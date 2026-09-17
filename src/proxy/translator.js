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
  let hadOutput = false;

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    get hadOutput() { return hadOutput; },

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
          hadOutput = true;
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
          hadOutput = true;
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
          hadOutput = true;
          out.push(makeChunk(completionId, created, model, delta, null, null));
          break;
        }

        case 'finish-step': {
          if (event.finishReason) finishReason = mapFinishReason(event.finishReason);
          const u = event.usage;
          if (u) {
            usage = u;
            if (u.outputTokens) {
              this.inputTokens = u.inputTokens ?? 0;
              this.outputTokens = u.outputTokens;
              this.cachedInputTokens = u.cachedInputTokens ?? 0;
            } else if (u.inputTokens) {
              // 有 input 无 output —— 保留已记录的 outputTokens
              this.inputTokens = u.inputTokens;
              this.cachedInputTokens = u.cachedInputTokens ?? 0;
            }
          }
          break;
        }

        case 'finish': {
          const fr = finishReason || mapFinishReason(event.finishReason || 'stop');
          const u = event.totalUsage || usage || {};
          // 只在上游回报有效 outputTokens 时调 normalizeUsage（它会在 output 为假值时清零 input）
          if (u.outputTokens) {
            normalizeUsage(u);
            this.inputTokens = u.inputTokens ?? 0;
            this.outputTokens = u.outputTokens;
            this.cachedInputTokens = u.cachedInputTokens ?? 0;
          } else if (u.inputTokens) {
            // 有 input 无 output —— 保留之前 finish-step 记录的 outputTokens
            this.inputTokens = u.inputTokens;
            this.cachedInputTokens = u.cachedInputTokens ?? 0;
          }
          const openaiUsage = {
            prompt_tokens: this.inputTokens,
            completion_tokens: this.outputTokens,
            total_tokens: this.inputTokens + this.outputTokens,
            prompt_tokens_details: { cached_tokens: this.cachedInputTokens },
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

// ── Anthropic 请求转换 ──────────────────────────────

/**
 * 把 Anthropic Messages API 请求转换为 OpenAI Chat 格式，
 * 以便复用 buildCcRequest 通道。
 */
export function convertAnthropicToOpenAI(anthropicReq) {
  // 1. 提取 system prompt（Anthropic 的 system 是顶层字段，不在 messages 里）
  let systemPrompt = '';
  let systemBlocks = null;
  if (anthropicReq.system) {
    if (typeof anthropicReq.system === 'string') {
      systemPrompt = anthropicReq.system;
    } else if (Array.isArray(anthropicReq.system)) {
      systemBlocks = anthropicReq.system
        .filter(b => b && b.type === 'text')
        .map(b => {
          const blk = { type: 'text', text: b.text ?? '' };
          if (b.cache_control) blk.cache_control = b.cache_control;
          return blk;
        });
      systemPrompt = systemBlocks.map(b => b.text).join('\n');
    }
  }

  // 2. 构建 tool_name 反查表 + 转换 messages
  const toolNameFromId = {};
  const openaiMessages = [];

  // systemBlocks 可能全是空 text 但带 cache_control——此时 systemPrompt 为空但断点不能丢
  if (systemPrompt || (systemBlocks && systemBlocks.length)) {
    openaiMessages.push({
      role: 'system',
      content: systemBlocks && systemBlocks.length ? systemBlocks : systemPrompt,
    });
  }

  const messages = anthropicReq.messages || [];
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      let textContent = '';
      let thinkingContent = '';
      const textParts = [];
      let textHasCache = false;
      const toolCalls = [];
      const blocks = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content || '' }];
      for (const block of blocks) {
        if (block.type === 'text') {
          textContent += block.text || '';
          const part = { type: 'text', text: block.text || '' };
          if (block.cache_control) { part.cache_control = block.cache_control; textHasCache = true; }
          textParts.push(part);
        } else if (block.type === 'thinking') {
          thinkingContent += block.thinking || '';
        } else if (block.type === 'tool_use') {
          toolNameFromId[block.id] = block.name;
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input || {}) },
          });
        }
      }
      const assistantMsg = {
        role: 'assistant',
        content: (textParts.length > 1 || textHasCache) ? textParts : (textContent || null),
      };
      if (thinkingContent) assistantMsg.reasoning_content = thinkingContent;
      if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
      openaiMessages.push(assistantMsg);
    } else if (msg.role === 'user') {
      let textContent = '';
      const parts = [];
      let textHasCache = false;
      const toolResults = [];
      if (typeof msg.content === 'string') {
        textContent = msg.content;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            textContent += block.text || '';
            const part = { type: 'text', text: block.text || '' };
            if (block.cache_control) { part.cache_control = block.cache_control; textHasCache = true; }
            parts.push(part);
          } else if (block.type === 'image') {
            const s = block.source || {};
            const url = s.type === 'base64' && s.data
              ? `data:${s.media_type || 'image/png'};base64,${s.data}`
              : (s.url || '');
            if (url) parts.push({ type: 'image_url', image_url: { url } });
          } else if (block.type === 'tool_result') {
            toolResults.push(block);
          }
        }
      }
      // tool_result 优先入队：OpenAI 语义要求 tool 消息紧跟 assistant 的 tool_calls
      for (const tr of toolResults) {
        const toolContent = typeof tr.content === 'string' ? tr.content
          : Array.isArray(tr.content) ? tr.content.map(c => c.text || '').join('\n')
          : String(tr.content || '');
        const toolMsg = { role: 'tool', tool_call_id: tr.tool_use_id, content: toolContent };
        if (toolNameFromId[tr.tool_use_id]) toolMsg.name = toolNameFromId[tr.tool_use_id];
        openaiMessages.push(toolMsg);
      }
      if (parts.length || textContent) {
        const singleText = parts.length <= 1 && (parts.length === 0 || parts[0].type === 'text') && !textHasCache;
        openaiMessages.push({ role: 'user', content: singleText ? textContent : parts });
      }
    }
  }

  // 3. 构建 OpenAI 格式请求
  const openaiReq = {
    model: anthropicReq.model || 'deepseek/deepseek-v4-flash',
    messages: openaiMessages,
    max_tokens: anthropicReq.max_tokens || 64000,
    stream: anthropicReq.stream === true,
  };

  // 4. 转换 tools
  if (anthropicReq.tools && anthropicReq.tools.length > 0) {
    openaiReq.tools = anthropicReq.tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
  }

  // 5. 转换 tool_choice
  if (anthropicReq.tool_choice) {
    const tc = anthropicReq.tool_choice;
    if (tc.type === 'auto' || tc.type === undefined) openaiReq.tool_choice = 'auto';
    else if (tc.type === 'any') openaiReq.tool_choice = 'required';
    else if (tc.type === 'tool') openaiReq.tool_choice = { type: 'function', function: { name: tc.name } };
    else if (tc.type === 'none') openaiReq.tool_choice = 'none';
  }

  // 6. 可选参数
  if (anthropicReq.temperature !== undefined) openaiReq.temperature = anthropicReq.temperature;
  if (anthropicReq.top_p !== undefined) openaiReq.top_p = anthropicReq.top_p;
  if (anthropicReq.stop_sequences) openaiReq.stop = anthropicReq.stop_sequences;
  if (anthropicReq.metadata?.user_id) openaiReq.user = anthropicReq.metadata.user_id;

  // 7. Anthropic thinking → reasoning_effort
  if (anthropicReq.thinking) {
    const t = anthropicReq.thinking;
    if (t.type === 'disabled' || t.type === 'none') {
      // 不发送 reasoning_effort
    } else if (t.type === 'adaptive') {
      openaiReq.reasoning_effort = t.effort ?? 'medium';
    } else if (t.budget_tokens !== undefined) {
      if (t.budget_tokens >= 10000) openaiReq.reasoning_effort = 'high';
      else if (t.budget_tokens >= 5000) openaiReq.reasoning_effort = 'medium';
      else openaiReq.reasoning_effort = 'low';
    }
  }

  return openaiReq;
}

// ── Anthropic SSE 流式转换器 ──────────────────────────

/**
 * 创建 Anthropic SSE 转换器（状态机模式，逐行解析 CC NDJSON）
 * 输出 Anthropic Messages SSE 事件格式（content_block lifecycle）
 */
export function createAnthropicSseTranslator(model, messageId) {
  let nextBlockIndex = 0;
  let currentBlockIndex = -1;
  let currentBlockType = null;
  let blockStarted = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let noCacheTokens = -1;
  let stopReason = null;
  let hasError = false;
  let currentThinkingText = '';
  let hadOutput = false; // 是否实际产出过 content block

  function closeCurrentBlock() {
    if (blockStarted) {
      const idx = currentBlockIndex;
      const type = currentBlockType;
      let out = '';
      if (type === 'thinking') {
        out += `event: content_block_delta\ndata: ${JSON.stringify({
          type: 'content_block_delta', index: idx,
          delta: { type: 'signature_delta', signature: fakeThinkingSignature(currentThinkingText) },
        })}\n\n`;
        currentThinkingText = '';
      }
      blockStarted = false;
      currentBlockType = null;
      return out + `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }
    return '';
  }

  function openBlock(type, contentBlock) {
    if (!blockStarted || currentBlockType !== type) {
      const close = closeCurrentBlock();
      currentBlockIndex = nextBlockIndex++;
      currentBlockType = type;
      blockStarted = true;
      return close + `event: content_block_start\ndata: ${JSON.stringify({
        type: 'content_block_start', index: currentBlockIndex, content_block: contentBlock,
      })}\n\n`;
    }
    return '';
  }

  return {
    lastCcEvent: '',
    upstreamError: null,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,

    getMessageStart() {
      return `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId, type: 'message', role: 'assistant', content: [], model,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })}\n\n`;
    },

    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '[DONE]' || trimmed.startsWith(':')) return null;
      let event;
      try { event = JSON.parse(trimmed); } catch { return null; }
      if (!event.type) return null;
      this.lastCcEvent = event.type;

      const out = [];

      switch (event.type) {
        case 'start': case 'start-step': case 'text-start': case 'reasoning-start':
          break;

        case 'reasoning-delta': {
          const text = event.text || '';
          if (!text) break;
          hadOutput = true;
          const blockEvt = openBlock('thinking', { type: 'thinking', thinking: '' });
          currentThinkingText += text;
          out.push(blockEvt + `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index: currentBlockIndex,
            delta: { type: 'thinking_delta', thinking: text },
          })}\n\n`);
          break;
        }

        case 'text-delta': {
          const text = event.text || '';
          hadOutput = true;
          const blockEvt = openBlock('text', { type: 'text', text: '' });
          out.push(blockEvt + `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index: currentBlockIndex,
            delta: { type: 'text_delta', text },
          })}\n\n`);
          outputTokens += 1;
          break;
        }

        case 'tool-call': {
          hadOutput = true;
          const closeEvt = closeCurrentBlock();
          if (closeEvt) out.push(closeEvt);

          const id = event.toolCallId || `toolu_${randomUUID().slice(0, 12)}`;
          const name = event.toolName || '';
          const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input || {});
          const tcIndex = nextBlockIndex++;

          out.push(`event: content_block_start\ndata: ${JSON.stringify({
            type: 'content_block_start', index: tcIndex,
            content_block: { type: 'tool_use', id, name, input: {} },
          })}\n\n`);
          out.push(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta', index: tcIndex,
            delta: { type: 'input_json_delta', partial_json: input },
          })}\n\n`);
          out.push(`event: content_block_stop\ndata: ${JSON.stringify({
            type: 'content_block_stop', index: tcIndex,
          })}\n\n`);
          outputTokens += 20;
          break;
        }

        case 'finish-step':
        case 'finish': {
          if (event.finishReason) stopReason = mapAnthropicStopReason(mapFinishReason(event.finishReason));
          const u = event.totalUsage || event.usage;
          if (u) {
            // 只在上游回报有效 outputTokens 时才采纳（normalizeUsage 在 outputTokens 为假值时会清零 input）
            if (u.outputTokens) {
              normalizeUsage(u);
              outputTokens = u.outputTokens;
              inputTokens = u.inputTokens ?? inputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
            } else if (u.inputTokens) {
              // 有 input 无 output —— 保留本地 output 估算，只采纳 input
              inputTokens = u.inputTokens;
              cachedInputTokens = u.cachedInputTokens ?? cachedInputTokens;
            }
            cacheWriteTokens = u.inputTokenDetails?.cacheWriteTokens ?? cacheWriteTokens;
            if (typeof u.inputTokenDetails?.noCacheTokens === 'number') {
              noCacheTokens = u.inputTokenDetails.noCacheTokens;
            }
            this.inputTokens = inputTokens;
            this.outputTokens = outputTokens;
            this.cachedInputTokens = cachedInputTokens;
          }
          break;
        }

        case 'error': {
          hasError = true;
          this.upstreamError = mapCcEventError(event);
          out.push(`event: error\ndata: ${JSON.stringify({
            type: 'error', error: this.upstreamError.body.error,
          })}\n\n`);
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

    finish() {
      this.inputTokens = inputTokens;
      this.outputTokens = outputTokens;
      this.cachedInputTokens = cachedInputTokens;

      if (hasError) return [];

      const out = [];
      const closeEvt = closeCurrentBlock();
      if (closeEvt) out.push(closeEvt);

      if (!hadOutput) {
        out.push(`event: error\ndata: ${JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: 'Empty response from upstream (zero output tokens)' },
          retry_after: 10,
        })}\n\n`);
      } else {
        out.push(`event: message_delta\ndata: ${JSON.stringify({
          type: 'message_delta',
          delta: { stop_reason: stopReason || 'end_turn' },
          usage: {
            output_tokens: outputTokens,
            cache_read_input_tokens: cachedInputTokens,
            cache_creation_input_tokens: cacheWriteTokens || 0,
            input_tokens: noCacheTokens >= 0
              ? noCacheTokens
              : Math.max(0, inputTokens - cachedInputTokens - (cacheWriteTokens || 0)),
          },
        })}\n\n`);
        out.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      }
      return out;
    },
  };
}

// ── Anthropic 非流式响应构建 ──────────────────────────

export function buildAnthropicResponse(model, fullText, toolCalls, finishReason, usage, thinkingText) {
  const content = [];
  if (thinkingText) content.push({ type: 'thinking', thinking: thinkingText, signature: fakeThinkingSignature(thinkingText) });
  if (fullText) content.push({ type: 'text', text: fullText });
  if (toolCalls) {
    for (const tc of toolCalls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }

  normalizeUsage(usage || {});
  const estOut = Math.max(1,
    Math.ceil(((fullText || '').length + (thinkingText || '').length) / 4) + (toolCalls ? toolCalls.length * 20 : 0));

  return {
    id: `msg_${randomUUID().slice(0, 12)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapAnthropicStopReason(finishReason || 'stop'),
    stop_sequence: null,
    usage: {
      input_tokens: anthropicInputTokens(usage),
      output_tokens: usage?.outputTokens || estOut,
      cache_creation_input_tokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      cache_read_input_tokens: usage?.cachedInputTokens ?? 0,
    },
  };
}
