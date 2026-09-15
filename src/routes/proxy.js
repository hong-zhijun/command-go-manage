/**
 * 代理路由 — OpenAI / Anthropic 兼容端点
 *
 * /v1/chat/completions  — OpenAI Chat API
 * /v1/messages          — Anthropic Messages API
 * /v1/models            — 模型列表
 */
import { randomUUID } from 'crypto';
import config from '../config.js';
import { extractApiKey, validateApiKey } from '../auth/api-key.js';
import { pickCcKey, acquireCcKey, releaseCcKey } from '../pool/dispatcher.js';
import { buildCcRequest, forwardToCC, ensureInitialized, createIdleWatchdog, waitDrain } from '../proxy/core.js';
import { createSseTranslator, mapCcError, normalizeUsage, mapFinishReason, mapAnthropicStopReason, fakeThinkingSignature, anthropicInputTokens } from '../proxy/translator.js';
import { insertUsageLog } from '../db/index.js';

// ── 模型列表 ──────────────────────────────────────

const MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  { id: 'gpt-5.5', name: 'GPT-5.5' },
  { id: 'gpt-5.4', name: 'GPT-5.4' },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
  { id: 'deepseek/deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
  { id: 'moonshotai/Kimi-K2.6', name: 'Kimi K2.6' },
  { id: 'moonshotai/Kimi-K2.5', name: 'Kimi K2.5' },
  { id: 'Qwen/Qwen3.7-Max', name: 'Qwen 3.7 Max' },
  { id: 'Qwen/Qwen3.6-Plus', name: 'Qwen 3.6 Plus' },
  { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash' },
  { id: 'xiaomi/mimo-v2.5', name: 'MiMo V2.5' },
];

// ── 滑动窗口限流（per API Key） ──────────────────────

const rateBuckets = new Map(); // apiKeyId → { timestamps[] }

function checkRateLimit(apiKeyId, limit) {
  if (!limit || limit <= 0) return true;
  const now = Date.now();
  const windowMs = 60_000; // 1 分钟窗口
  let bucket = rateBuckets.get(apiKeyId);
  if (!bucket) { bucket = { ts: [] }; rateBuckets.set(apiKeyId, bucket); }
  // 清除过期记录
  bucket.ts = bucket.ts.filter(t => now - t < windowMs);
  if (bucket.ts.length >= limit) return false;
  bucket.ts.push(now);
  return true;
}

// 每 5 分钟清理空桶
setInterval(() => {
  const now = Date.now();
  for (const [id, bucket] of rateBuckets) {
    bucket.ts = bucket.ts.filter(t => now - t < 60_000);
    if (bucket.ts.length === 0) rateBuckets.delete(id);
  }
}, 300_000);

// ── 辅助函数 ──────────────────────────────────────

function nowUnix() { return Math.floor(Date.now() / 1000); }

function sendJsonRaw(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(data?.retry_after ? { 'Retry-After': String(data.retry_after) } : {}),
  });
  res.end(body);
}

export default async function proxyRoutes(fastify) {

  // ── GET /v1/models ──

  fastify.get('/v1/models', async () => {
    return {
      object: 'list',
      data: MODELS.map(m => ({
        id: m.id,
        object: 'model',
        created: 1700000000,
        owned_by: m.id.includes('/') ? m.id.split('/')[0] : 'system',
      })),
    };
  });

  // ── POST /v1/chat/completions ──

  fastify.post('/v1/chat/completions', {
    // 用 rawBody 模式，跳过 Fastify 的 body 解析，手动处理流
    config: { rawBody: true },
  }, async (request, reply) => {
    // 1. 鉴权
    const rawKey = extractApiKey(request.headers);
    if (!rawKey) {
      return reply.code(401).send({
        error: { message: 'Missing API key. Send via Authorization: Bearer sk-cg-xxx', type: 'auth_error' },
      });
    }
    const user = validateApiKey(rawKey);
    if (!user) {
      return reply.code(401).send({
        error: { message: 'Invalid API key', type: 'auth_error' },
      });
    }

    // 1.5 Rate limit 检查
    if (!checkRateLimit(user.apiKeyId, user.rateLimit)) {
      return reply.code(429).send({
        error: { message: `Rate limit exceeded (${user.rateLimit} req/min)`, type: 'rate_limit_error' },
        retry_after: 10,
      });
    }

    // 2. 解析请求体
    const openaiReq = request.body;
    if (!openaiReq || !openaiReq.messages) {
      return reply.code(400).send({
        error: { message: 'Invalid request: messages required', type: 'invalid_request_error' },
      });
    }

    // 3. 从池中选 CC Key（sticky：同一个 API Key 尽量粘在同一个 CC Key 上，提高缓存命中率）
    const ccKeyRow = pickCcKey(user.apiKeyId);
    if (!ccKeyRow) {
      return reply.code(503).send({
        error: { message: 'No available CC keys in pool', type: 'server_error' },
      });
    }

    const ccKey = ccKeyRow.api_key;
    const stream = openaiReq.stream === true;
    const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
    const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
    const created = nowUnix();
    const startTime = Date.now();

    // 4. 占位
    acquireCcKey(ccKeyRow.id);

    const abortController = new AbortController();
    let aborted = false;
    let lastCcEvent = '';
    let bytesReceived = 0;
    let translator = null;
    let reader = null;
    let fullText = '';

    // 获取原始 Node response 用于流式写入
    const res = reply.raw;
    const req = request.raw;

    try {
      // 5. 初始化（fingerprint + lifecycle，传入管理员配置的时区覆盖）
      const fpOverrides = ccKeyRow.timezone_override ? { timezone: ccKeyRow.timezone_override } : {};
      await ensureInitialized(ccKey, abortController.signal, fpOverrides);

      // 6. 构建 CC 请求体
      const ccBody = buildCcRequest(openaiReq);

      // 7. 转发
      const ccResponse = await forwardToCC(ccBody, ccKey, abortController.signal);

      if (!ccResponse.ok) {
        const errorText = await ccResponse.text().catch(() => '');
        const mapped = mapCcError(ccResponse.status, errorText);
        logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', mapped.body?.error?.message);
        releaseCcKey(ccKeyRow.id);
        sendJsonRaw(res, mapped.status, mapped.body);
        return reply.hijack();
      }

      // 客户端断连处理
      req.on('close', () => {
        if (!aborted && !res.writableEnded) {
          aborted = true;
          if (!abortController.signal.aborted) abortController.abort();
        }
      });

      if (stream) {
        // ── 流式响应 ──
        translator = createSseTranslator(model, completionId, created);
        let buffer = '';
        let started = false;
        const decoder = new TextDecoder();
        reader = ccResponse.body.getReader();

        const idle = createIdleWatchdog(config.ccStreamIdleMs);
        try {
          while (true) {
            const result = await Promise.race([reader.read(), idle.arm()]);
            const { done, value } = result;
            if (done || aborted) break;
            bytesReceived += value.length;

            const chunkText = decoder.decode(value, { stream: true });
            buffer += chunkText;
            let lines = [];
            if (chunkText.indexOf('\n') !== -1) {
              lines = buffer.split('\n');
              buffer = lines.pop() || '';
            }

            for (const line of lines) {
              const events = translator.parseLine(line);
              if (events) {
                if (!started) {
                  res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'X-Accel-Buffering': 'no',
                  });
                  started = true;
                }
                for (const evt of events) res.write(evt);
                await waitDrain(res);
              }
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
          }

          if (!aborted) {
            // 处理残余 buffer
            if (buffer.trim()) {
              const events = translator.parseLine(buffer);
              if (events) {
                if (!started) started = true;
                for (const evt of events) res.write(evt);
                await waitDrain(res);
              }
            }

            if (translator.upstreamError) {
              if (!started) {
                sendJsonRaw(res, translator.upstreamError.status, translator.upstreamError.body);
              }
            } else if (translator.outputTokens === 0) {
              if (!started) {
                sendJsonRaw(res, 429, { error: { message: 'Empty response (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 });
              }
            } else {
              if (!started) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
                started = true;
              }
              res.write(translator.getDoneEvent());
            }
          }
        } catch (e) {
          if (e.message === 'STREAM_IDLE_TIMEOUT') {
            try { reader.cancel(); } catch {}
            try { abortController.abort(); } catch {}
            if (!started) {
              sendJsonRaw(res, 429, { error: { message: 'Response timeout', type: 'rate_limit_error' }, retry_after: 5 });
            }
          } else if (!aborted) {
            try { abortController.abort(); } catch {}
            if (!started) {
              sendJsonRaw(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error' }, retry_after: 10 });
            }
          }
        } finally {
          idle.dispose();
        }

        if (!res.writableEnded) res.end();

        // 记录用量
        logUsage(user, ccKeyRow, model,
          translator?.inputTokens ?? 0, translator?.outputTokens ?? 0, translator?.cachedInputTokens ?? 0,
          Date.now() - startTime, translator?.upstreamError ? 'error' : 'ok');
      } else {
        // ── 非流式响应 ──
        let reasoningContent = '';
        let finishReason = 'stop';
        let usage = null;
        let toolCalls = null;

        reader = ccResponse.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        const idle = createIdleWatchdog(config.ccNonStreamIdleMs);
        try {
          while (true) {
            const result = await Promise.race([reader.read(), idle.arm()]);
            const { done, value } = result;
            if (done) break;
            bytesReceived += value.length;
            buf += decoder.decode(value, { stream: true });

            if (buf.indexOf('\n') !== -1) {
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;
                try {
                  const event = JSON.parse(trimmed);
                  switch (event.type) {
                    case 'text-delta': fullText += event.text || ''; break;
                    case 'reasoning-delta': reasoningContent += event.text || ''; break;
                    case 'tool-call':
                      toolCalls = toolCalls || [];
                      toolCalls.push({
                        id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                        type: 'function',
                        function: { name: event.toolName || '', arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}) },
                      });
                      break;
                    case 'finish':
                      finishReason = mapFinishReason(event.finishReason || 'stop');
                      if (event.totalUsage) usage = event.totalUsage;
                      break;
                  }
                } catch {}
              }
            }
          }
        } finally {
          idle.dispose();
        }

        if (!usage) usage = {};
        normalizeUsage(usage);

        const responseData = {
          id: completionId,
          object: 'chat.completion',
          created,
          model,
          choices: [{
            index: 0,
            message: Object.assign(
              { role: 'assistant', content: fullText || null },
              toolCalls ? { tool_calls: toolCalls } : {},
              reasoningContent ? { reasoning_content: reasoningContent } : {},
            ),
            finish_reason: finishReason,
          }],
          usage: {
            prompt_tokens: usage.inputTokens ?? 0,
            completion_tokens: usage.outputTokens ?? 0,
            total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 },
          },
        };

        logUsage(user, ccKeyRow, model,
          usage.inputTokens ?? 0, usage.outputTokens ?? 0, usage.cachedInputTokens ?? 0,
          Date.now() - startTime, 'ok');

        sendJsonRaw(res, 200, responseData);
      }

      releaseCcKey(ccKeyRow.id);
      return reply.hijack();
    } catch (e) {
      releaseCcKey(ccKeyRow.id);
      if (!abortController.signal.aborted) try { abortController.abort(); } catch {}
      logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', e.message);

      if (!res.headersSent) {
        sendJsonRaw(res, 502, { error: { message: `Upstream error: ${e.message}`, type: 'proxy_error' }, retry_after: 10 });
      }
      return reply.hijack();
    }
  });

  // ── GET /health ──

  fastify.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));
}

function logUsage(user, ccKeyRow, model, inputTokens, outputTokens, cachedTokens, latencyMs, status, errorMessage) {
  try {
    insertUsageLog({
      userId: user.userId,
      apiKeyId: user.apiKeyId,
      ccKeyId: ccKeyRow.id,
      model,
      inputTokens,
      outputTokens,
      cachedTokens,
      latencyMs,
      status,
      errorMessage: errorMessage || '',
    });
  } catch {
    // 日志写入失败不影响主流程
  }
}
