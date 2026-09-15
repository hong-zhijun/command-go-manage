/**
 * CC NDJSON → OpenAI SSE 转换器（提取自 commandcode-proxy）
 *
 * CC 上游返回 NDJSON 格式（每行一个 JSON 事件），
 * 这里负责逐行解析并转换为 OpenAI Chat Completions SSE 格式。
 */
import crypto from 'crypto';
import { randomUUID } from 'crypto';

// ── OpenAI 格式 ──────────────────────────────────────

export function createSseTranslator(model, completionId, created) {
  let chunkIndex = 0;
  let finishReason = null;
  let usage = null;
  let toolCallIndex = 0;

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,

    /** 解析一行 NDJSON，返回 OpenAI chunk 字符串数组 */
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;

      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'text-start': case 'reasoning-start': case 'start': case 'start-step':
          break;

        case 'text-delta': {
          const text = event.text || event.delta || '';
          if (!text) break;
          const delta = chunkIndex === 0 ? { role: 'assistant', content: text } : { content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          const delta = chunkIndex === 0
            ? { role: 'assistant', reasoning_content: text }
            : { reasoning_content: text };
          chunkIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'tool-call': {
          const id = event.toolCallId || `call_${Date.now()}_${toolCallIndex}`;
          const name = event.toolName || '';
          const args = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcEntry = { index: toolCallIndex, id, type: 'function', function: { name, arguments: args } };
          const delta = chunkIndex === 0
            ? { role: 'assistant', content: null, tool_calls: [tcEntry] }
            : { tool_calls: [tcEntry] };
          chunkIndex++;
          toolCallIndex++;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          if (event.usage) {
            usage = event.usage;
            this.inputTokens = event.usage.inputTokens ?? 0;
            this.outputTokens = event.usage.outputTokens ?? 0;
            this.cachedInputTokens = event.usage.cachedInputTokens ?? 0;
          }
          break;
        }

        case 'finish': {
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || usage || {};
          normalizeUsage(u);
          this.inputTokens = u.inputTokens ?? 0;
          this.outputTokens = u.outputTokens ?? 0;
          this.cachedInputTokens = u.cachedInputTokens ?? 0;
          const openaiUsage = {
            prompt_tokens: u.inputTokens ?? 0,
            completion_tokens: u.outputTokens ?? 0,
            total_tokens: (u.inputTokens ?? 0) + (u.outputTokens ?? 0),
            prompt_tokens_details: { cached_tokens: u.cachedInputTokens ?? 0 },
          };
          out.push(makeChunk(completionId, created, model, {}, fr, openaiUsage));
          break;
        }

        case 'error': {
          const msg = event.error?.message || event.message || 'Unknown error';
          this.upstreamError = mapCcEventError(event);
          break;
        }

        case 'reasoning-end': case 'provider-metadata': case 'tool-input-start':
        case 'tool-input-delta': case 'tool-input-end': case 'tool-error': case 'text-end':
          break;
        default:
          break;
      }

      return out.length > 0 ? out : null;
    },

    getDoneEvent() {
      return 'data: [DONE]\n\n';
    },
  };
}

function makeChunk(id, created, model, delta, finishReason, usage) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  if (usage) chunk.usage = usage;
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── 共享工具函数 ──────────────────────────────────────

export function normalizeUsage(u) {
  if (!u) return;
  const ot = Number(u.outputTokens);
  if (!ot) {
    u.inputTokens = 0;
    u.cachedInputTokens = 0;
  }
}

export function mapFinishReason(reason) {
  switch (reason) {
    case 'tool-calls': return 'tool_calls';
    case 'length': return 'length';
    case 'stop': return 'stop';
    default: return reason || 'stop';
  }
}

// ── 错误映射 ──────────────────────────────────────

const CC_STATUS_MAP = {
  400: { status: 400, type: 'invalid_request_error' },
  401: { status: 401, type: 'authentication_error' },
  402: { status: 429, type: 'rate_limit_error' },
  403: { status: 401, type: 'authentication_error' },
  404: { status: 404, type: 'not_found' },
  422: { status: 400, type: 'invalid_request_error' },
  429: { status: 429, type: 'rate_limit_error' },
  500: { status: 502, type: 'upstream_error' },
  502: { status: 502, type: 'upstream_error' },
  503: { status: 503, type: 'temporarily_unavailable' },
};

export function mapCcError(ccStatus, ccBody) {
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };
  let message = `CC API error (${ccStatus})`;
  let code = null;

  if (ccBody) {
    try {
      const parsed = JSON.parse(ccBody);
      message = parsed.error?.message || parsed.message || message;
      code = parsed.error?.code || parsed.code || null;
    } catch {
      message = ccBody.slice(0, 200) || message;
    }
  }

  if (ccStatus === 429) {
    return {
      status: 429, code,
      body: { error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) }, retry_after: 30 },
    };
  }
  return { status: mapped.status, code, body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

export function mapCcEventError(event) {
  const message = event.error?.message || event.message || 'Unknown CC error';
  const code = event.error?.code || event.code || null;
  const statusMatch = message.match(/^<(\d{3})>/);
  const ccStatus = statusMatch ? Number(statusMatch[1]) : 502;
  const mapped = CC_STATUS_MAP[ccStatus] || { status: 502, type: 'upstream_error' };

  if (mapped.status === 429) {
    return {
      status: 429, code,
      body: { error: { message, type: 'rate_limit_error', ...(code ? { code } : {}) }, retry_after: 30 },
    };
  }
  return { status: mapped.status, code, body: { error: { message, type: mapped.type, ...(code ? { code } : {}) } } };
}

// ── Anthropic 协议支持 ──────────────────────────────

export function mapAnthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls': return 'tool_use';
    case 'length': return 'max_tokens';
    case 'stop': return 'end_turn';
    default: return 'end_turn';
  }
}

export function fakeThinkingSignature(thinkingText) {
  const seed = crypto.createHash('sha256').update(thinkingText || 'dsh-proxy-thinking').digest().subarray(0, 64);
  const raw = Buffer.concat([Buffer.from([0x12, seed.length]), seed]);
  return raw.toString('base64');
}

export function anthropicInputTokens(usage, noCacheOverride) {
  const u = usage || {};
  if (typeof noCacheOverride === 'number' && noCacheOverride >= 0) return noCacheOverride;
  const noCache = u.inputTokenDetails?.noCacheTokens;
  if (typeof noCache === 'number' && noCache >= 0) return noCache;
  const cacheRead = u.cachedInputTokens || u.inputTokenDetails?.cacheReadTokens || 0;
  const cacheWrite = u.inputTokenDetails?.cacheWriteTokens || 0;
  return Math.max(0, (u.inputTokens || 0) - cacheRead - cacheWrite);
}
