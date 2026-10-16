import { URL, URLSearchParams } from 'url';
import config from '../config.js';
import {
  createCcAuthSession,
  findCcAuthSessionByState,
  getCcAuthSession,
  updateCcAuthSession,
  deleteCcAuthSession,
} from '../cc-auth/flow.js';
import { fetchKeyReport, syncCcKey } from '../pool/quota-sync.js';
import { findCcKeyByRawKey, findCcKeyById, insertCcKey } from '../db/index.js';

function publicBaseUrl() {
  if (!config.publicBaseUrl) throw new Error('请先配置 PUBLIC_BASE_URL 为管理面板的公网 HTTPS 地址');
  const url = new URL(config.publicBaseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('PUBLIC_BASE_URL 必须是 HTTPS 站点地址，例如 https://cc.example.com');
  }
  return url.origin;
}

function buildAuthorizationUrl({ callbackUrl, state }) {
  const url = new URL('/studio/auth/cli', config.ccStudioBase);
  url.searchParams.set('callback', callbackUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('mode', 'redirect');
  return url.toString();
}

function isAdmin(request) {
  return request.user?.role === 'admin';
}

function normalizeCallbackBody(body) {
  if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  if (typeof body !== 'string') return {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch { /* form body fallback */ }
  return Object.fromEntries(new URLSearchParams(body));
}

function callbackPage(title, message, ok = true) {
  const color = ok ? '#059669' : '#dc2626';
  const safe = String(message).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui,sans-serif;padding:40px;color:#1f2937"><h2 style="color:${color}">${title}</h2><p>${safe}</p><p>可以关闭此页面并返回管理面板。</p></body></html>`;
}

export default async function ccAuthRoutes(fastify) {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  fastify.post('/api/admin/cc-keys/auth/start', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ error: 'Admin only' });

    let baseUrl;
    try { baseUrl = publicBaseUrl(); }
    catch (error) { return reply.code(400).send({ error: error.message }); }
    const label = request.body?.label;
    if (label !== undefined && typeof label !== 'string') return reply.code(400).send({ error: '备注格式不正确' });
    const callbackUrl = `${baseUrl}/api/admin/cc-keys/auth/callback`;
    const session = createCcAuthSession({
      userId: request.user.id,
      callbackUrl,
      authorizationUrl: null,
    });
    const authorizationUrl = buildAuthorizationUrl({ callbackUrl, state: session.state });
    updateCcAuthSession(session.id, { authorizationUrl, label: (label || '').trim().slice(0, 60) });

    return {
      sessionId: session.id,
      authorizationUrl,
      expiresAt: session.expiresAt,
    };
  });

  fastify.delete('/api/admin/cc-keys/auth/session/:sessionId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ error: 'Admin only' });
    const session = getCcAuthSession(request.params.sessionId);
    if (!session || session.userId !== request.user.id) return reply.code(404).send({ error: '授权已过期，请重新生成链接' });
    if (session.status === 'processing') return reply.code(409).send({ error: '正在保存授权结果' });
    deleteCcAuthSession(session.id);
    return { ok: true };
  });

  fastify.get('/api/admin/cc-keys/auth/status/:sessionId', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    if (!isAdmin(request)) return reply.code(403).send({ error: 'Admin only' });
    const session = getCcAuthSession(request.params.sessionId);
    if (!session || session.userId !== request.user.id) {
      return reply.code(404).send({ error: '授权已过期，请重新生成链接' });
    }
    return {
      status: session.status,
      message: session.message,
      expiresAt: session.expiresAt,
      keyId: session.keyId || null,
    };
  });

  // Command Code 的授权页面会把 apiKey 等字段 POST 到 callback。
  // 该接口不能要求 JWT，因为请求来自浏览器授权页；一次性 state 负责绑定会话。
  fastify.post('/api/admin/cc-keys/auth/callback', { bodyLimit: 10_000 }, async (request, reply) => {
    const body = normalizeCallbackBody(request.body);
    const state = typeof body.state === 'string' ? body.state : '';
    const session = findCcAuthSessionByState(state);

    if (!session || session.status !== 'pending') {
      return reply.code(403).type('text/html').send(callbackPage('授权失败', '授权状态无效或已过期。', false));
    }

    if (body.error) {
      updateCcAuthSession(session.id, { status: 'denied', message: '授权未完成，请重新生成链接后重试' });
      return reply.type('text/html').send(callbackPage('授权未完成', '请重新生成链接后重试', false));
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!/^[\x21-\x7e]{1,4096}$/.test(apiKey) || !['userId', 'userName', 'keyName'].every(name => typeof body[name] === 'string' && body[name].length > 0 && body[name].length <= 256)) {
      updateCcAuthSession(session.id, { status: 'error', message: '授权结果缺少必要字段' });
      return reply.code(400).type('text/html').send(callbackPage('授权失败', '授权结果缺少必要字段。', false));
    }

    updateCcAuthSession(session.id, { status: 'processing', message: '正在验证并保存账号' });
    try {
      const existing = findCcKeyByRawKey(apiKey);
      if (existing) {
        updateCcAuthSession(session.id, { status: 'success', message: '账号已存在于账号池', keyId: existing.id });
        return reply.type('text/html').send(callbackPage('账号已存在', '这个账号已经在 CC 账号池中。'));
      }

      const report = await fetchKeyReport(apiKey, { requireIdentity: true });
      // 验证期间另一次授权或手动添加可能已经保存了相同 Key。
      let row = findCcKeyByRawKey(apiKey);
      if (!row) {
        const result = insertCcKey(apiKey, session.label || report.userName || body.userName);
        row = findCcKeyById(Number(result.lastInsertRowid));
        if (row) await syncCcKey(row, report);
      }
      updateCcAuthSession(session.id, {
        status: 'success',
        message: '账号授权成功，已加入 CC 账号池',
        keyId: row.id,
      });
      return reply.type('text/html').send(callbackPage('授权成功', '账号已验证并加入 CC 账号池。'));
    } catch (error) {
      updateCcAuthSession(session.id, { status: 'error', message: '账号验证或保存失败，请重新授权后重试' });
      return reply.code(400).type('text/html').send(callbackPage('授权失败', '账号验证或保存失败，请返回管理面板重试。', false));
    }
  });

  fastify.get('/api/admin/cc-keys/auth/callback', async (_request, reply) => {
    return reply.code(405).type('text/html').send(callbackPage('请返回管理面板', '授权回调需要由授权页面 POST 调用。', false));
  });
}

