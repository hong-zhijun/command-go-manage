/**
 * 代理路由 — OpenAI / Anthropic / Responses 兼容端点
 *
 * /v1/chat/completions  — OpenAI Chat API
 * /v1/messages          — Anthropic Messages API
 * /v1/responses         — OpenAI Responses API
 * /v1/models            — 模型列表
 */
import { randomUUID } from 'crypto';
import config from '../config.js';
import { extractApiKey, validateApiKey } from '../auth/api-key.js';
import { pickCcKey, acquireCcKey, releaseCcKey } from '../pool/dispatcher.js';
import { buildCcRequest, forwardToCC, ensureInitialized, createIdleWatchdog, waitDrain } from '../proxy/core.js';
import {
  createSseTranslator, mapCcError, normalizeUsage, mapFinishReason,
  convertAnthropicToOpenAI, createAnthropicSseTranslator, buildAnthropicResponse,
} from '../proxy/translator.js';
import {
  convertResponsesToChat, createResponsesSseTranslator,
  buildResponsesObject,
} from '../proxy/responses-translator.js';
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

function sendAnthropicError(res, status, type, message, retryAfter) {
  const body = { type: 'error', error: { type, message } };
  const headers = { 'Content-Type': 'application/json' };
  if (retryAfter !== undefined) {
    body.retry_after = retryAfter;
    headers['Retry-After'] = String(retryAfter);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendResponsesError(res, status, type, message, retryAfter) {
  const body = { error: { message, type, code: null, param: null } };
  if (retryAfter !== undefined) body.retry_after = retryAfter;
  sendJsonRaw(res, status, body);
}

// 连续超时计数（per apiKeyId，防止跨用户误报）
const timeoutCounters = new Map(); // apiKeyId → count
const TIMEOUT_REDUCE_CONTEXT_THRESHOLD = 3;

function getTimeouts(apiKeyId) { return timeoutCounters.get(apiKeyId) || 0; }
function bumpTimeouts(apiKeyId) { timeoutCounters.set(apiKeyId, getTimeouts(apiKeyId) + 1); }
function resetTimeouts(apiKeyId) { timeoutCounters.delete(apiKeyId); }

// ── 公共鉴权（不含选 Key，避免畸形请求污染 stickyMap）──

function authenticate(request) {
  const rawKey = extractApiKey(request.headers);
  if (!rawKey) return { err: 'Missing API key. Send via Authorization: Bearer sk-cg-xxx' };
  const user = validateApiKey(rawKey);
  if (!user) return { err: 'Invalid API key' };
  if (!checkRateLimit(user.apiKeyId, user.rateLimit)) {
    return { err: `Rate limit exceeded (${user.rateLimit} req/min)`, rateLimited: true };
  }
  return { user };
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

  // ══════════════════════════════════════════════════════
  // POST /v1/chat/completions — OpenAI Chat API
  // ══════════════════════════════════════════════════════

  fastify.post('/v1/chat/completions', {
    config: { rawBody: true },
  }, async (request, reply) => {
    // 1. 鉴权
    const auth = authenticate(request);
    if (auth.err) {
      if (auth.rateLimited) return reply.code(429).send({ error: { message: auth.err, type: 'rate_limit_error' }, retry_after: 10 });
      return reply.code(401).send({ error: { message: auth.err, type: 'auth_error' } });
    }
    const { user } = auth;

    // 2. 解析请求体（先校验再选 Key，避免畸形请求污染 stickyMap）
    const openaiReq = request.body;
    if (!openaiReq || !openaiReq.messages) {
      return reply.code(400).send({ error: { message: 'Invalid request: messages required', type: 'invalid_request_error' } });
    }

    // 3. 选 CC Key（sticky 路由）
    const ccKeyRow = pickCcKey(user.apiKeyId);
    if (!ccKeyRow) {
      return reply.code(503).send({ error: { message: 'No available CC keys in pool', type: 'server_error' } });
    }
    const ccKey = ccKeyRow.api_key;
    const stream = openaiReq.stream === true;
    const model = openaiReq.model || 'deepseek/deepseek-v4-flash';
    const completionId = `chatcmpl-${randomUUID().slice(0, 12)}`;
    const created = nowUnix();
    const startTime = Date.now();

    // 3. 占位
    acquireCcKey(ccKeyRow.id);

    const abortController = new AbortController();
    let aborted = false;
    let lastCcEvent = '';
    let bytesReceived = 0;
    let translator = null;
    let reader = null;
    let fullText = '';
    let streamStatus = 'ok';

    const res = reply.raw;
    const req = request.raw;

    try {
      // 4. 初始化
      const fpOverrides = ccKeyRow.timezone_override ? { timezone: ccKeyRow.timezone_override } : {};
      await ensureInitialized(ccKey, abortController.signal, fpOverrides);

      // 5. 构建 CC 请求体
      const ccBody = buildCcRequest(openaiReq);

      // 6. 转发
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
      let started = false;
      res.on('close', () => {
        if (!aborted && !res.writableEnded) {
          aborted = true;
          // 断连前抢发 usage=0 终止 chunk，避免下游自行估算 token
          if (stream && started && !res.destroyed) {
            try {
              const stopChunk = { id: completionId, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
              res.write(`data: ${JSON.stringify(stopChunk)}\n\n`);
              res.write('data: [DONE]\n\n');
            } catch {}
          }
          if (!abortController.signal.aborted) abortController.abort();
        }
      });

      if (stream) {
        // ── 流式响应 ──
        translator = createSseTranslator(model, completionId, created);
        let buffer = '';
        let lastKeepaliveAt = Date.now();
        const decoder = new TextDecoder();
        reader = ccResponse.body.getReader();

        // 立即发 SSE header，防止 Cloudflare 524 超时
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(': connected\n\n');
        started = true;

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
                for (const evt of events) res.write(evt);
                lastKeepaliveAt = Date.now();
                await waitDrain(res);
              } else if (line.trim() && Date.now() - lastKeepaliveAt > 15000) {
                res.write(': keepalive\n\n');
                lastKeepaliveAt = Date.now();
              }
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
          }

          if (!aborted) {
            if (buffer.trim()) {
              const events = translator.parseLine(buffer);
              if (events) {
                for (const evt of events) res.write(evt);
                await waitDrain(res);
              }
            }

            if (translator.upstreamError) {
              // header 已发，错误通过 SSE 数据发送
              try { res.write(`data: ${JSON.stringify(translator.upstreamError.body)}\n\n`); } catch {}
            } else if (!translator.hadOutput) {
              try { res.write(`data: ${JSON.stringify({ error: { message: 'Empty response (zero output tokens)', type: 'rate_limit_error' }, retry_after: 10 })}\n\n`); } catch {}
            } else {
              res.write(translator.getDoneEvent());
            }
            resetTimeouts(user.apiKeyId);
          }
        } catch (e) {
          if (e.message === 'STREAM_IDLE_TIMEOUT') {
            streamStatus = 'timeout';
            try { reader.cancel(); } catch {}
            try { abortController.abort(); } catch {}
            bumpTimeouts(user.apiKeyId);
            const timeoutMsg = getTimeouts(user.apiKeyId) >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            if (!res.writableEnded) {
              try { res.write(`data: ${JSON.stringify({ error: { message: timeoutMsg, type: 'rate_limit_error' }, retry_after: 5 })}\n\n`); } catch {}
            }
          } else if (!aborted) {
            streamStatus = 'error';
            try { abortController.abort(); } catch {}
            if (!res.writableEnded) {
              try { res.write(`data: ${JSON.stringify({ error: { message: `Upstream error: ${e.message}`, type: 'proxy_error' }, retry_after: 10 })}\n\n`); } catch {}
            }
          }
        } finally {
          idle.dispose();
        }

        if (!res.writableEnded) res.end();

        if (aborted && streamStatus === 'ok') streamStatus = 'abort';
        if (translator?.upstreamError && streamStatus === 'ok') streamStatus = 'error';
        const ctx = streamContext(startTime, bytesReceived, lastCcEvent);
        const errMsg = streamStatus === 'ok' ? ''
          : streamStatus === 'timeout' ? `idle_timeout [${ctx}]`
          : streamStatus === 'abort' ? `client_disconnect [${ctx}]`
          : `${translator?.upstreamError?.body?.error?.message || 'upstream_error'} [${ctx}]`;

        logUsage(user, ccKeyRow, model,
          translator?.inputTokens ?? 0, translator?.outputTokens ?? 0, translator?.cachedInputTokens ?? 0,
          Date.now() - startTime, streamStatus, errMsg);
      } else {
        // ── 非流式响应 ──
        let reasoningContent = '';
        let finishReason = 'stop';
        let usage = null;
        let toolCalls = null;

        const handleEvent = (event) => {
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
            case 'finish-step':
            case 'finish':
              if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
              if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
              break;
          }
        };

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
                try { handleEvent(JSON.parse(trimmed)); } catch {}
              }
            }
          }
        } finally {
          idle.dispose();
        }

        // 处理残余 buffer（上游末尾可能不带换行）
        if (buf.trim()) {
          try { handleEvent(JSON.parse(buf.trim())); } catch {}
        }

        if (!usage) usage = {};
        normalizeUsage(usage);

        resetTimeouts(user.apiKeyId);
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

  // ══════════════════════════════════════════════════════
  // POST /v1/messages — Anthropic Messages API
  // ══════════════════════════════════════════════════════

  fastify.post('/v1/messages', {
    config: { rawBody: true },
  }, async (request, reply) => {
    // 1. 鉴权
    const auth = authenticate(request);
    if (auth.err) {
      const res = reply.raw;
      if (auth.rateLimited) { sendAnthropicError(res, 429, 'rate_limit_error', auth.err, 10); return reply.hijack(); }
      sendAnthropicError(res, 401, 'authentication_error', auth.err);
      return reply.hijack();
    }
    const { user } = auth;

    // 2. 解析请求体（先校验再选 Key，避免畸形请求污染 stickyMap）
    const anthropicReq = request.body;
    if (!anthropicReq || !anthropicReq.messages) {
      sendAnthropicError(reply.raw, 400, 'invalid_request_error', 'Invalid request: messages required');
      return reply.hijack();
    }

    // 3. 选 CC Key（sticky 路由）
    const ccKeyRow = pickCcKey(user.apiKeyId);
    if (!ccKeyRow) {
      sendAnthropicError(reply.raw, 503, 'server_error', 'No available CC keys in pool');
      return reply.hijack();
    }
    const ccKey = ccKeyRow.api_key;
    const stream = anthropicReq.stream === true;
    const model = anthropicReq.model || 'claude-sonnet-4-6';
    const messageId = `msg_${randomUUID().slice(0, 12)}`;
    const startTime = Date.now();

    // 4. Anthropic → OpenAI → CC
    const openaiReq = convertAnthropicToOpenAI(anthropicReq);
    const ccBody = buildCcRequest(openaiReq);

    // 5. 占位
    acquireCcKey(ccKeyRow.id);

    const abortController = new AbortController();
    let aborted = false;
    let started = false;           // hoisted: close handler 也需要
    let bytesReceived = 0;
    let lastCcEvent = '';
    let reader = null;
    let translator = null;
    let streamStatus = 'ok';

    const res = reply.raw;
    const req = request.raw;

    try {
      // 6. 初始化
      const fpOverrides = ccKeyRow.timezone_override ? { timezone: ccKeyRow.timezone_override } : {};
      await ensureInitialized(ccKey, abortController.signal, fpOverrides);

      // 7. 转发
      const ccResponse = await forwardToCC(ccBody, ccKey, abortController.signal);

      if (!ccResponse.ok) {
        const errorText = await ccResponse.text().catch(() => '');
        const mapped = mapCcError(ccResponse.status, errorText);
        logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', mapped.body?.error?.message);
        releaseCcKey(ccKeyRow.id);
        sendAnthropicError(res, mapped.status, mapped.body.error.type, mapped.body.error.message);
        return reply.hijack();
      }

      // 客户端断连处理
      res.on('close', () => {
        if (res.writableEnded) return;
        aborted = true;
        if (!abortController.signal.aborted) {
          // 断连前抢发 usage=0 终止事件（仅流式且已发过 header）
          if (stream && started && !res.destroyed) {
            try {
              res.write(`event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: 0, input_tokens: 0, cache_read_input_tokens: 0 },
              })}\n\n`);
              res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
            } catch {}
          }
          try { abortController.abort(); } catch {}
        }
      });

      if (stream) {
        // ── 流式 Anthropic SSE ──
        translator = createAnthropicSseTranslator(model, messageId);
        let buffer = '';
        const buf = []; // 缓冲 message_start 直到首个内容事件
        const decoder = new TextDecoder();
        reader = ccResponse.body.getReader();

        const SSE_HEADERS = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        };

        // 立即发 SSE header + message_start，防止 Cloudflare 524 超时
        res.writeHead(200, SSE_HEADERS);
        res.write(translator.getMessageStart());
        started = true;
        buf.length = 0;

        // 心跳：Anthropic 标准 ping 事件，覆盖长 thinking 的静默窗口
        let lastSentAt = Date.now();
        const heartbeat = setInterval(() => {
          if (!aborted && !res.writableEnded && !res.writableNeedDrain && Date.now() - lastSentAt > 15000) {
            try { res.write('event: ping\ndata: {"type":"ping"}\n\n'); lastSentAt = Date.now(); } catch {}
          }
        }, 5000);

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
                for (const evt of events) { try { res.write(evt); } catch {} }
                lastSentAt = Date.now();
                await waitDrain(res);
              }
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
          }

          if (!aborted) {
            if (buffer.trim()) {
              const events = translator.parseLine(buffer);
              if (events) {
                for (const evt of events) { try { res.write(evt); } catch {} }
                await waitDrain(res);
              }
            }

            if (translator.upstreamError) {
              try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: translator.upstreamError.body.error })}\n\n`); } catch {}
            } else if (translator.outputTokens === 0) {
              try { abortController.abort(); } catch {}
              try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' }, retry_after: 10 })}\n\n`); } catch {}
            } else {
              const finishEvents = translator.finish();
              for (const evt of finishEvents) { try { res.write(evt); } catch {} }
            }
            resetTimeouts(user.apiKeyId);
          }
        } catch (e) {
          if (aborted) {
            // 客户端已断连
          } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
            streamStatus = 'timeout';
            try { reader.cancel(); } catch {}
            try { abortController.abort(); } catch {}
            bumpTimeouts(user.apiKeyId);
            const timeoutMsg = getTimeouts(user.apiKeyId) >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            if (!res.writableEnded) {
              try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: timeoutMsg }, retry_after: 5 })}\n\n`); } catch {}
            }
          } else {
            streamStatus = 'error';
            try { abortController.abort(); } catch {}
            if (!res.writableEnded) {
              try { res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'internal_error', message: e.message } })}\n\n`); } catch {}
            }
          }
        } finally {
          clearInterval(heartbeat);
          idle.dispose();
        }

        if (!res.writableEnded) res.end();

        if (aborted && streamStatus === 'ok') streamStatus = 'abort';
        if (translator?.upstreamError && streamStatus === 'ok') streamStatus = 'error';
        const ctx = streamContext(startTime, bytesReceived, lastCcEvent);
        const errMsg = streamStatus === 'ok' ? ''
          : streamStatus === 'timeout' ? `idle_timeout [${ctx}]`
          : streamStatus === 'abort' ? `client_disconnect [${ctx}]`
          : `${translator?.upstreamError?.body?.error?.message || 'upstream_error'} [${ctx}]`;

        logUsage(user, ccKeyRow, model,
          translator?.inputTokens ?? 0, translator?.outputTokens ?? 0, translator?.cachedInputTokens ?? 0,
          Date.now() - startTime, streamStatus, errMsg);
      } else {
        // ── 非流式 Anthropic JSON ──
        let fullText = '';
        let thinkingText = '';
        let finishReason = 'stop';
        let usage = null;
        let toolCalls = null;
        let upstreamError = null;

        const handleEvent = (event) => {
          switch (event.type) {
            case 'text-delta': fullText += event.text || ''; break;
            case 'reasoning-delta': thinkingText += event.text || ''; break;
            case 'tool-call':
              (toolCalls = toolCalls || []).push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: { name: event.toolName || '', arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}) },
              });
              break;
            case 'finish-step':
            case 'finish':
              if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
              if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
              break;
            case 'error':
              upstreamError = { status: 502, type: 'upstream_error', message: event.error?.message || event.message || 'Unknown error' };
              break;
          }
        };

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
                try { handleEvent(JSON.parse(trimmed)); } catch {}
              }
            }
          }
        } finally {
          idle.dispose();
        }

        // 处理残余 buffer（上游末尾可能不带换行）
        if (buf.trim()) {
          try { handleEvent(JSON.parse(buf.trim())); } catch {}
        }

        if (upstreamError) {
          logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', upstreamError.message);
          releaseCcKey(ccKeyRow.id);
          sendAnthropicError(res, upstreamError.status, upstreamError.type, upstreamError.message);
          return reply.hijack();
        }

        // 零输出判定按实际内容（上游偶发不回 totalUsage）
        if (!fullText && !thinkingText && !toolCalls) {
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', 'Empty response');
          releaseCcKey(ccKeyRow.id);
          sendAnthropicError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
          return reply.hijack();
        }

        resetTimeouts(user.apiKeyId);
        const responseData = buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText);

        logUsage(user, ccKeyRow, model,
          usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.cachedInputTokens ?? 0,
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
        sendAnthropicError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
      }
      return reply.hijack();
    }
  });

  // ══════════════════════════════════════════════════════
  // POST /v1/responses — OpenAI Responses API
  // ══════════════════════════════════════════════════════

  fastify.post('/v1/responses', {
    config: { rawBody: true },
  }, async (request, reply) => {
    // 1. 鉴权
    const auth = authenticate(request);
    if (auth.err) {
      const res = reply.raw;
      if (auth.rateLimited) { sendResponsesError(res, 429, 'rate_limit_error', auth.err, 10); return reply.hijack(); }
      sendResponsesError(res, 401, 'authentication_error', auth.err);
      return reply.hijack();
    }
    const { user } = auth;

    // 2. 解析请求体（先校验再选 Key，避免畸形请求污染 stickyMap）
    const respReq = request.body;
    if (!respReq) {
      sendResponsesError(reply.raw, 400, 'invalid_request_error', 'Invalid JSON body');
      return reply.hijack();
    }

    // 无状态代理：不支持 previous_response_id
    if (respReq.previous_response_id) {
      sendResponsesError(reply.raw, 400, 'invalid_request_error',
        'previous_response_id is not supported (this proxy is stateless); send the full input each turn');
      return reply.hijack();
    }

    // 3. Responses → Chat → CC
    let chatReq = convertResponsesToChat(respReq);
    if (!chatReq.messages.length) {
      sendResponsesError(reply.raw, 400, 'invalid_request_error', 'input is required');
      return reply.hijack();
    }

    // 4. 选 CC Key（sticky 路由）
    const ccKeyRow = pickCcKey(user.apiKeyId);
    if (!ccKeyRow) {
      sendResponsesError(reply.raw, 503, 'server_error', 'No available CC keys in pool');
      return reply.hijack();
    }
    const ccKey = ccKeyRow.api_key;
    const stream = chatReq.stream === true;
    const model = chatReq.model || 'deepseek/deepseek-v4-flash';
    const responseId = 'resp_' + randomUUID().replace(/-/g, '').slice(0, 24);
    const created = nowUnix();
    const echoOpts = {
      instructions: respReq.instructions === undefined ? null : respReq.instructions,
      max_output_tokens: respReq.max_output_tokens === undefined ? null : respReq.max_output_tokens,
      temperature: respReq.temperature,
      top_p: respReq.top_p,
      reasoning: respReq.reasoning || null,
      tool_choice: typeof respReq.tool_choice === 'string' ? respReq.tool_choice : 'auto',
      tools: respReq.tools || [],
    };

    const ccBody = buildCcRequest(chatReq);
    chatReq = null; // 释放

    // 4. 占位
    acquireCcKey(ccKeyRow.id);

    const abortController = new AbortController();
    let aborted = false;
    const startTime = Date.now();
    let bytesReceived = 0;
    let lastCcEvent = '';
    let reader = null;
    let translator = null;
    let streamStatus = 'ok';

    const res = reply.raw;
    const req = request.raw;

    // 客户端断连
    res.on('close', () => {
      if (res.writableEnded) return;
      aborted = true;
      if (!abortController.signal.aborted) { try { abortController.abort(); } catch {} }
    });

    try {
      // 5. 初始化
      const fpOverrides = ccKeyRow.timezone_override ? { timezone: ccKeyRow.timezone_override } : {};
      await ensureInitialized(ccKey, abortController.signal, fpOverrides);
      const ccResponse = await forwardToCC(ccBody, ccKey, abortController.signal);

      if (!ccResponse.ok) {
        const errorText = await ccResponse.text().catch(() => '');
        const mapped = mapCcError(ccResponse.status, errorText);
        logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', mapped.body?.error?.message);
        releaseCcKey(ccKeyRow.id);
        sendResponsesError(res, mapped.status, mapped.body.error.type, mapped.body.error.message, mapped.body.retry_after);
        return reply.hijack();
      }

      if (stream) {
        // ── 流式 Responses SSE ──
        translator = createResponsesSseTranslator(model, responseId, created);
        let buffer = '';
        let started = false;
        const decoder = new TextDecoder();
        reader = ccResponse.body.getReader();

        const SSE_HEADERS = {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        };

        // 上游已连通，立即发 SSE header + 注释，告诉 Cloudflare 连接有效，
        // 防止 CC 推理时间长导致 TTFB 超过 Cloudflare 的 100 秒超时 (524)。
        res.writeHead(200, SSE_HEADERS);
        res.write(': connected\n\n');
        started = true;

        const writeEvents = async (evts) => {
          for (const e of evts) res.write(e);
          await waitDrain(res);
        };

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
              const evts = translator.parseLine(line);
              if (evts) await writeEvents(evts);
              if (translator.lastCcEvent) lastCcEvent = translator.lastCcEvent;
            }
          }

          if (!aborted) {
            if (buffer.trim()) {
              const evts = translator.parseLine(buffer);
              if (evts) await writeEvents(evts);
            }

            if (translator.upstreamError) {
              const failed = translator.fail(translator.upstreamError.body.error.message);
              if (failed.length) await writeEvents(failed);
            } else if (translator.outputTokens === 0 && !translator.started) {
              try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
              try { res.write(translator.errorEvent('Empty response from upstream (zero output tokens)')); } catch {}
            } else {
              for (const e of translator.finish()) res.write(e);
            }
            resetTimeouts(user.apiKeyId);
          }
        } catch (e) {
          if (aborted) {
            try { reader.cancel(); } catch {}
          } else if (e.message === 'STREAM_IDLE_TIMEOUT') {
            streamStatus = 'timeout';
            try { reader.cancel(); } catch {}
            try { abortController.abort(); } catch {}
            bumpTimeouts(user.apiKeyId);
            const timeoutMsg = getTimeouts(user.apiKeyId) >= TIMEOUT_REDUCE_CONTEXT_THRESHOLD
              ? 'Response timeout - try reducing context length (summarize earlier messages)'
              : 'Response timeout - request timed out';
            if (!res.writableEnded) {
              try { res.write(translator.errorEvent(timeoutMsg)); } catch {}
            }
          } else {
            streamStatus = 'error';
            try { abortController.abort(); } catch {}
            if (!res.writableEnded) {
              try { res.write(translator.errorEvent(e.message)); } catch {}
            }
          }
        } finally {
          idle.dispose();
        }

        if (!res.writableEnded) res.end();

        if (aborted && streamStatus === 'ok') streamStatus = 'abort';
        if (translator?.upstreamError && streamStatus === 'ok') streamStatus = 'error';
        const ctx = streamContext(startTime, bytesReceived, lastCcEvent);
        const errMsg = streamStatus === 'ok' ? ''
          : streamStatus === 'timeout' ? `idle_timeout [${ctx}]`
          : streamStatus === 'abort' ? `client_disconnect [${ctx}]`
          : `${translator?.upstreamError?.body?.error?.message || 'upstream_error'} [${ctx}]`;

        logUsage(user, ccKeyRow, model,
          translator?.inputTokens ?? 0, translator?.outputTokens ?? 0, translator?.cachedInputTokens ?? 0,
          Date.now() - startTime, streamStatus, errMsg);
      } else {
        // ── 非流式 Responses JSON ──
        let fullText = '';
        let thinkingText = '';
        let usage = null;
        let finishReason = 'stop';
        let upstreamError = null;
        const toolCalls = [];

        const handleEvent = (event) => {
          switch (event.type) {
            case 'text-delta': fullText += event.text || ''; break;
            case 'reasoning-delta': thinkingText += event.text || ''; break;
            case 'tool-call':
              toolCalls.push({
                id: event.toolCallId || ('call_' + randomUUID().slice(0, 8)),
                type: 'function',
                function: { name: event.toolName || '', arguments: typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {}) },
              });
              break;
            case 'finish-step':
            case 'finish':
              if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
              if (event.totalUsage || event.usage) usage = event.totalUsage || event.usage;
              break;
            case 'error':
              upstreamError = { status: 502, type: 'upstream_error', message: event.error?.message || event.message || 'Unknown error' };
              break;
          }
        };

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
                if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) continue;
                try { handleEvent(JSON.parse(trimmed)); } catch {}
              }
            }
          }
        } finally {
          idle.dispose();
        }

        // 处理残余 buffer（上游末尾可能不带换行）
        if (buf.trim()) {
          try { handleEvent(JSON.parse(buf.trim())); } catch {}
        }

        if (upstreamError) {
          logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', upstreamError.message);
          releaseCcKey(ccKeyRow.id);
          sendResponsesError(res, upstreamError.status, upstreamError.type, upstreamError.message);
          return reply.hijack();
        }

        if (!fullText && !thinkingText && !toolCalls.length) {
          try { if (!abortController.signal.aborted) abortController.abort(); } catch {}
          logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', 'Empty response');
          releaseCcKey(ccKeyRow.id);
          sendResponsesError(res, 429, 'rate_limit_error', 'Empty response from upstream (zero output tokens)', 10);
          return reply.hijack();
        }

        resetTimeouts(user.apiKeyId);
        echoOpts.finishReason = finishReason;
        const responseData = buildResponsesObject(responseId, model, created, fullText, thinkingText, toolCalls, usage, echoOpts);

        logUsage(user, ccKeyRow, model,
          usage?.inputTokens ?? 0, usage?.outputTokens ?? 0, usage?.cachedInputTokens ?? 0,
          Date.now() - startTime, 'ok');

        sendJsonRaw(res, 200, responseData);
      }

      releaseCcKey(ccKeyRow.id);
      return reply.hijack();
    } catch (e) {
      releaseCcKey(ccKeyRow.id);
      if (e.name === 'AbortError' || e.code === 'ABORT_ERR') return reply.hijack();
      if (!abortController.signal.aborted) try { abortController.abort(); } catch {}
      logUsage(user, ccKeyRow, model, 0, 0, 0, Date.now() - startTime, 'error', e.message);

      if (!res.headersSent) {
        sendResponsesError(res, 502, 'proxy_error', `Upstream error: ${e.message}`, 10);
      } else if (!res.writableEnded) {
        try { res.write(translator ? translator.errorEvent(e.message) : ''); } catch {}
        try { res.end(); } catch {}
      }
      return reply.hijack();
    }
  });

  // ── GET /health ──

  fastify.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));
}

function streamContext(startTime, bytesReceived, lastCcEvent) {
  return `${((Date.now() - startTime) / 1000).toFixed(1)}s, ${bytesReceived}B, last=${lastCcEvent || 'none'}`;
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
