/**
 * CC 代理核心 — 请求构建、会话管理、上游转发（提取自 commandcode-proxy）
 *
 * 职责：
 * - 把 OpenAI/Anthropic 格式的请求转换为 CC 信封格式
 * - 管理每个 CC Key 的 session 和设备指纹
 * - 把请求转发到 CC 上游
 */
import crypto, { randomUUID } from 'crypto';
import config from '../config.js';
import { generateFingerprint, DEVICE_PROFILE } from './fingerprint.js';

// ── 会话管理（per CC Key） ──────────────────────────

const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;
const SESSION_JITTER_MS = 60 * 60 * 1000;
const INIT_REFRESH_MS = 8 * 60 * 60 * 1000;
const INIT_JITTER_MS = 2 * 60 * 60 * 1000;

const sessionStore = new Map();   // ccKey → { sessionId, expiresAt }
const keyStateStore = new Map();  // ccKey → { fingerprint, nextInitAt }

function ensureSession(ccKey) {
  const now = Date.now();
  const entry = sessionStore.get(ccKey);
  if (entry && now < entry.expiresAt) return entry.sessionId;

  const jitter = Math.floor(Math.random() * SESSION_JITTER_MS);
  const sessionId = randomUUID();
  sessionStore.set(ccKey, { sessionId, expiresAt: now + SESSION_DURATION_MS + jitter });
  return sessionId;
}

function getOrCreateKeyState(ccKey, overrides = {}) {
  let state = keyStateStore.get(ccKey);
  if (!state) {
    state = {
      fingerprint: generateFingerprint(ccKey, overrides),
      nextInitAt: 0,
    };
    keyStateStore.set(ccKey, state);
  }
  return state;
}

/**
 * 清除某个 key 的缓存状态（时区等配置变更后需要重建指纹）
 */
export function invalidateKeyState(ccKey) {
  keyStateStore.delete(ccKey);
  sessionStore.delete(ccKey);
}

// 定期清理过期 session
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionStore) {
    if (now >= entry.expiresAt) {
      sessionStore.delete(key);
      keyStateStore.delete(key);
    }
  }
}, 60 * 60 * 1000);

// ── 初始化预请求（fingerprint + lifecycle） ─────────

export async function ensureInitialized(ccKey, signal, overrides = {}) {
  const state = getOrCreateKeyState(ccKey, overrides);
  const now = Date.now();
  if (now < state.nextInitAt) return;

  try {
    const headers = {
      'Content-Type': 'application/json',
      'x-cli-environment': 'production',
      'Authorization': `Bearer ${ccKey}`,
      'x-command-code-version': config.ccProtocolVersion,
      ...(config.ccZdr ? { 'x-cmd-zdr': '1' } : {}),
    };
    const fingerprint = state.fingerprint || {};

    // 10 秒超时，防止 DNS 解析慢或连接卡住时拖延主请求
    const initSignal = AbortSignal.any([
      AbortSignal.timeout(10_000),
      ...(signal ? [signal] : []),
    ]);

    await Promise.all([
      fetch(`${config.ccApiBase}/alpha/fingerprint/record`, {
        method: 'POST', headers, signal: initSignal,
        body: JSON.stringify(fingerprint),
      }).catch(() => {}),

      fetch(`${config.ccApiBase}/alpha/lifecycle-events`, {
        method: 'POST', headers, signal: initSignal,
        body: JSON.stringify({
          eventType: 'cli_session_exists',
          metadata: {
            sessionId: `sess_${crypto.randomBytes(8).toString('hex')}`,
            cliVersion: config.ccProtocolVersion,
            mode: config.ccCliSessionMode,
            os: `${DEVICE_PROFILE.platform}-${DEVICE_PROFILE.arch}`,
          },
        }),
      }).catch(() => {}),
    ]);

    const jitter = Math.floor(Math.random() * INIT_JITTER_MS);
    state.nextInitAt = Date.now() + INIT_REFRESH_MS + jitter;
  } catch {
    // 失败不阻塞，下次重试
  }
}

// ── 工具函数 ──────────────────────────────────────

function slugifyProjectPath(p) {
  const s = String(p || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'root';
}

function generateTraceparent() {
  const traceId = crypto.randomBytes(16).toString('hex');
  const parentId = crypto.randomBytes(8).toString('hex');
  return `00-${traceId}-${parentId}-01`;
}

function getDateStr() {
  return new Date().toISOString().slice(0, 10);
}

function tryParseJSON(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

// CLI 工具名别名
const TOOL_NAME_ALIASES = {
  bash_output: 'shell_output',
  task_output: 'shell_output',
  tool_search: 'search_tools',
  read_multiple_files: 'read_file',
};
function toWireToolName(name) { return TOOL_NAME_ALIASES[name] || name; }

function toWireToolOutputValue(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('\n');
  return content == null ? '' : String(content);
}

// ── CC 请求体构建 ──────────────────────────────────

export function buildCcRequest(openaiReq) {
  const { model, messages, max_tokens, temperature, tools, reasoning_effort, tool_choice, parallel_tool_calls, prompt_cache_key } = openaiReq;

  // 提取 system prompt
  const systemMsgs = messages.filter(m => m.role === 'system' || m.role === 'developer');
  const systemBlocks = [];
  for (const m of systemMsgs) {
    if (typeof m.content === 'string') {
      if (m.content) systemBlocks.push({ type: 'text', text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        const text = c?.text ?? c?.content ?? '';
        if (text === '' && !c?.cache_control) continue;
        const block = { type: 'text', text: String(text) };
        if (c?.cache_control) block.cache_control = c.cache_control;
        systemBlocks.push(block);
      }
    } else if (m.content != null) {
      systemBlocks.push({ type: 'text', text: String(m.content) });
    }
  }
  for (let i = 0; i < systemBlocks.length - 1; i++) systemBlocks[i].text += '\n';

  const chatMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

  // Build tool_call_id → tool_name reverse lookup
  const toolNameMap = {};
  for (const msg of chatMessages) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (tc.id) toolNameMap[tc.id] = tc.function?.name || '';
      }
    }
  }

  // 转换 messages 为 CC 格式
  const ccMessages = chatMessages.map(msg => {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        return { role: 'user', content: [{ type: 'text', text: msg.content }] };
      }
      if (Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image_url') {
            const url = part.image_url?.url || '';
            const mediaType = /^data:([^;,]+)/.exec(url)?.[1];
            const imagePart = { type: 'image', image: url };
            if (mediaType) imagePart.mimeType = mediaType;
            return imagePart;
          }
          return part;
        }).filter(Boolean);
        return { role: 'user', content: parts };
      }
      return { role: 'user', content: [{ type: 'text', text: String(msg.content) }] };
    }
    if (msg.role === 'assistant') {
      const parts = [];
      if (msg.reasoning_content) parts.push({ type: 'reasoning', text: msg.reasoning_content });
      if (msg.content && typeof msg.content === 'string') {
        if (msg.content) parts.push({ type: 'text', text: msg.content });
      } else if (msg.content && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === 'text') parts.push(part);
          else if (part.type === 'reasoning' && !msg.reasoning_content) parts.push(part);
        }
      }
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          parts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.function?.name || '',
            input: (typeof tc.function?.arguments === 'string' ? tryParseJSON(tc.function.arguments) : (tc.function?.arguments || {})),
          });
        }
      }
      return { role: 'assistant', content: parts };
    }
    if (msg.role === 'tool') {
      return {
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: msg.tool_call_id,
          toolName: toolNameMap[msg.tool_call_id] || msg.name || '',
          output: { type: 'text', value: toWireToolOutputValue(msg.content) },
        }],
      };
    }
    return { role: 'user', content: [{ type: 'text', text: String(msg.content ?? '') }] };
  });

  // 缓存断点
  const hasCacheMarker = systemBlocks.some(b => b.cache_control) || ccMessages.some(msg =>
    Array.isArray(msg.content) && msg.content.some(part => part?.cache_control));
  if (prompt_cache_key && !hasCacheMarker && systemBlocks.length) {
    systemBlocks[systemBlocks.length - 1].cache_control = { type: 'ephemeral' };
  }

  const body = {
    config: {
      workingDir: DEVICE_PROFILE.projectDir,
      date: getDateStr(),
      environment: DEVICE_PROFILE.platform,
      structure: [],
      isGitRepo: false,
      currentBranch: '',
      mainBranch: '',
      gitStatus: '',
      recentCommits: [],
    },
    memory: null,
    taste: null,
    skills: null,
    permissionMode: 'standard',
    mode: config.ccCliMode,
    params: {
      model: model || 'deepseek/deepseek-v4-flash',
      messages: ccMessages,
      max_tokens: Math.min(max_tokens || 64000, 200000),
      stream: true,
    },
  };

  // 条件字段
  if (systemBlocks.length) {
    body.params.system = systemBlocks;
  } else if (config.ccEmptySystemPlaceholder) {
    body.params.system = [{ type: 'text', text: ' ' }];
  }
  if (temperature !== undefined) body.params.temperature = temperature;
  if (reasoning_effort !== undefined) body.params.reasoning_effort = reasoning_effort;

  body.params.tools = (tools || []).map(t => ({
    name: toWireToolName(t.function?.name || t.name || ''),
    description: t.function?.description || t.description || '',
    input_schema: t.function?.parameters || t.input_schema || { type: 'object', properties: {} },
  }));

  if (tool_choice !== undefined) {
    if (typeof tool_choice === 'string') {
      const map = { 'auto': 'auto', 'none': 'none', 'required': 'any' };
      body.params.tool_choice = { type: map[tool_choice] || 'auto' };
    } else if (tool_choice.type === 'function') {
      body.params.tool_choice = { type: 'tool', name: tool_choice.function?.name };
    } else {
      body.params.tool_choice = tool_choice;
    }
  }
  if (parallel_tool_calls !== undefined) body.params.parallel_tool_calls = parallel_tool_calls;

  return body;
}

// ── 上游转发 ──────────────────────────────────────

export async function forwardToCC(ccBody, ccKey, signal) {
  const url = `${config.ccApiBase}/alpha/generate`;
  const traceparent = generateTraceparent();
  const sessionId = ensureSession(ccKey);

  // 按 CLI 键顺序排列信封
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
    const ordered = {};
    for (const k of ['config', 'memory', 'taste', 'skills', 'permissionMode']) ordered[k] = ccBody[k];
    ordered.threadId = sessionId;
    for (const k of ['mode', 'promptCache', 'params']) if (k in ccBody) ordered[k] = ccBody[k];
    ccBody = ordered;
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'cli',
    'x-command-code-version': config.ccProtocolVersion,
    'x-cli-environment': 'production',
    'x-project-slug': slugifyProjectPath(DEVICE_PROFILE.projectDir),
    'x-taste-learning': 'false',
    'x-session-id': sessionId,
    'Authorization': `Bearer ${ccKey}`,
    'traceparent': traceparent,
  };

  if (config.ccZdr) headers['x-cmd-zdr'] = '1';

  const jsonBody = JSON.stringify(ccBody);

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: jsonBody,
    signal,
  });
  return resp;
}

// ── 空闲看门狗 ──────────────────────────────────────

export function createIdleWatchdog(timeoutMs) {
  let rejectFn = null;
  const expired = new Promise((_, reject) => { rejectFn = reject; });
  expired.catch(() => {});
  const timer = setTimeout(() => rejectFn(new Error('STREAM_IDLE_TIMEOUT')), timeoutMs);
  return {
    arm() { timer.refresh(); return expired; },
    dispose() { clearTimeout(timer); },
  };
}

// ── 背压控制 ──────────────────────────────────────

export function waitDrain(res) {
  if (!res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done); res.off('close', done); res.off('error', done);
      resolve();
    };
    res.once('drain', done); res.once('close', done); res.once('error', done);
  });
}
