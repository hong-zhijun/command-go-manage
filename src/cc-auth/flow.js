import crypto from 'crypto';

const SESSION_TTL_MS = 10 * 60 * 1000;
const sessions = new Map();

function randomState() {
  return crypto.randomBytes(32).toString('base64url');
}

function randomSessionId() {
  return crypto.randomBytes(18).toString('base64url');
}

function purgeExpired() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(id);
  }
}

export function createCcAuthSession({ userId, callbackUrl }) {
  purgeExpired();
  for (const [id, session] of sessions) {
    if (session.userId === userId && session.status !== 'processing') sessions.delete(id);
  }
  const id = randomSessionId();
  const state = randomState();
  const session = {
    id,
    state,
    userId,
    callbackUrl,
    status: 'pending',
    message: '等待粘贴浏览器授权回调内容',
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  sessions.set(id, session);
  return { ...session };
}

export function getCcAuthSession(id) {
  purgeExpired();
  const session = sessions.get(id);
  return session ? { ...session } : null;
}

export function updateCcAuthSession(id, patch) {
  const session = sessions.get(id);
  if (!session) return null;
  Object.assign(session, patch);
  return { ...session };
}

// 防止关闭浏览器后留下的过期会话长期占用内存。
setInterval(purgeExpired, 60_000).unref();

export function deleteCcAuthSession(id) {
  sessions.delete(id);
}

