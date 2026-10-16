import config from '../config.js';
import {
  createCcAuthSession, getCcAuthSession, updateCcAuthSession, deleteCcAuthSession,
} from '../cc-auth/flow.js';
import { parseCcAuthPaste, matchesCcCallbackUrl } from '../cc-auth/parse.js';
import { fetchKeyReport, syncCcKey } from '../pool/quota-sync.js';
import { findCcKeyByRawKey, findCcKeyById, insertCcKey } from '../db/index.js';

// 官网只允许本机回调。远程面板接收管理员粘贴的请求内容，不监听用户电脑端口。
const CALLBACK_URL = 'http://localhost:5959/callback';

function buildAuthorizationUrl(state) {
  const url = new URL('/studio/auth/cli', config.ccStudioBase);
  url.searchParams.set('callback', CALLBACK_URL);
  url.searchParams.set('state', state);
  url.searchParams.set('mode', 'redirect');
  return url.toString();
}

export default async function ccAuthRoutes(fastify) {
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply);
    if (reply.sent) return;
    if (request.user?.role !== 'admin') return reply.code(403).send({ error: 'Admin only' });
  });
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });

  fastify.post('/api/admin/cc-keys/auth/start', async (request, reply) => {
    const label = request.body?.label;
    if (label !== undefined && typeof label !== 'string') return reply.code(400).send({ error: '备注格式不正确' });
    const session = createCcAuthSession({ userId: request.user.id, callbackUrl: CALLBACK_URL });
    const authorizationUrl = buildAuthorizationUrl(session.state);
    updateCcAuthSession(session.id, { label: (label || '').trim().slice(0, 60) });
    return { sessionId: session.id, authorizationUrl, callbackUrl: CALLBACK_URL, expiresAt: session.expiresAt };
  });

  fastify.delete('/api/admin/cc-keys/auth/session/:sessionId', async (request, reply) => {
    const session = getCcAuthSession(request.params.sessionId);
    if (!session || session.userId !== request.user.id) return reply.code(404).send({ error: '授权已过期，请重新生成链接' });
    if (session.status === 'processing') return reply.code(409).send({ error: '正在保存授权结果' });
    deleteCcAuthSession(session.id);
    return { ok: true };
  });

  fastify.get('/api/admin/cc-keys/auth/status/:sessionId', async (request, reply) => {
    const session = getCcAuthSession(request.params.sessionId);
    if (!session || session.userId !== request.user.id) return reply.code(404).send({ error: '授权已过期，请重新生成链接' });
    return { status: session.status, message: session.message, expiresAt: session.expiresAt, keyId: session.keyId || null };
  });

  fastify.post('/api/admin/cc-keys/auth/import', { bodyLimit: 128_000 }, async (request, reply) => {
    const { sessionId, content } = request.body || {};
    const session = typeof sessionId === 'string' ? getCcAuthSession(sessionId) : null;
    if (!session || session.userId !== request.user.id) return reply.code(404).send({ error: '授权已过期，请重新生成链接' });
    if (session.status !== 'pending') return reply.code(409).send({ error: '此授权已处理，请重新生成链接' });

    let parsed;
    try { parsed = parseCcAuthPaste(content); }
    catch (error) { return reply.code(400).send({ error: error.message }); }
    const body = parsed.body;
    if (body.state !== session.state) return reply.code(403).send({ error: '回调不属于本次授权，请粘贴当前链接对应的请求' });
    if (parsed.callbackUrl && !matchesCcCallbackUrl(parsed.callbackUrl, session.callbackUrl)) {
      return reply.code(400).send({ error: '回调地址与本次授权不一致，请复制当前 localhost 回调请求' });
    }
    if (body.error) {
      updateCcAuthSession(session.id, { status: 'denied', message: '授权未完成，请重新生成链接后重试' });
      return reply.code(400).send({ error: '授权未完成，请重新生成链接后重试' });
    }

    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
    if (!/^[\x21-\x7e]{1,4096}$/.test(apiKey) || !['userId', 'userName', 'keyName'].every(name => typeof body[name] === 'string' && body[name].length > 0 && body[name].length <= 256)) {
      return reply.code(400).send({ error: '授权结果缺少必要字段，请复制完整请求体' });
    }

    updateCcAuthSession(session.id, { status: 'processing', message: '正在验证并保存账号' });
    try {
      let row = findCcKeyByRawKey(apiKey);
      const duplicate = !!row;
      if (!row) {
        const report = await fetchKeyReport(apiKey, { requireIdentity: true });
        // 验证期间另一次授权或手动添加可能已经保存了相同 Key。
        row = findCcKeyByRawKey(apiKey);
        if (!row) {
          const result = insertCcKey(apiKey, session.label || report.userName || body.userName);
          row = findCcKeyById(Number(result.lastInsertRowid));
          await syncCcKey(row, report);
        }
      }
      const message = duplicate ? '账号已存在于账号池' : '账号验证成功，已加入 CC 账号池';
      updateCcAuthSession(session.id, { status: 'success', message, keyId: row.id });
      return { status: 'success', message, keyId: row.id };
    } catch {
      // 网络失败允许再次粘贴，不返回可能携带凭据的上游异常。
      updateCcAuthSession(session.id, { status: 'pending', message: '账号验证或保存失败，请稍后重新提交' });
      return reply.code(400).send({ error: '账号验证或保存失败，请检查 Key 或稍后重新提交' });
    }
  });
}
