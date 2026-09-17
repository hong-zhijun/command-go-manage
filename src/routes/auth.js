/**
 * 认证路由 — 登录 / 注册 / 用户信息
 */
import { hashSync, compareSync } from 'bcryptjs';
import { findUserByUsername, createUser, updateUserLogin, findUserById } from '../db/index.js';
import { generateApiKey, hashApiKey } from '../auth/api-key.js';
import { createApiKey, findApiKeysByUser, deleteApiKey } from '../db/index.js';

export default async function authRoutes(fastify) {
  // POST /api/auth/login
  fastify.post('/api/auth/login', async (request, reply) => {
    const { username, password } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'Missing username or password' });
    }

    const user = findUserByUsername(username);
    if (!user || !compareSync(password, user.password_hash)) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }
    if (!user.is_active) {
      return reply.code(403).send({ error: 'Account disabled' });
    }

    updateUserLogin(user.id);

    const token = fastify.jwt.sign({
      id: user.id,
      username: user.username,
      role: user.role,
    });

    return { token, user: { id: user.id, username: user.username, role: user.role } };
  });

  // POST /api/auth/register（管理员才能创建用户）
  fastify.post('/api/auth/register', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const caller = request.user;
    if (caller.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin only' });
    }

    const { username, password, role } = request.body || {};
    if (!username || !password) {
      return reply.code(400).send({ error: 'Missing username or password' });
    }
    if (username.length < 3 || username.length > 32) {
      return reply.code(400).send({ error: 'Username must be 3-32 chars' });
    }

    const existing = findUserByUsername(username);
    if (existing) {
      return reply.code(409).send({ error: 'Username already exists' });
    }

    const passwordHash = hashSync(password, 10);
    const userRole = (role === 'admin') ? 'admin' : 'user';
    const result = createUser(username, passwordHash, userRole);

    return reply.code(201).send({
      user: { id: result.lastInsertRowid, username, role: userRole },
    });
  });

  // GET /api/auth/me
  fastify.get('/api/auth/me', {
    preHandler: [fastify.authenticate],
  }, async (request) => {
    const user = findUserById(request.user.id);
    if (!user) return { error: 'User not found' };
    return { user };
  });

  // ── 用户的 API Key 管理 ───────────────────────

  // GET /api/auth/keys
  fastify.get('/api/auth/keys', {
    preHandler: [fastify.authenticate],
  }, async (request) => {
    const keys = findApiKeysByUser(request.user.id);
    return { keys };
  });

  // POST /api/auth/keys — 签发新 Key
  fastify.post('/api/auth/keys', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const { name } = request.body || {};
    if (!name || !name.trim()) {
      return reply.code(400).send({ error: 'Key 名称不能为空' });
    }
    const { fullKey, keyHash, keyPrefix } = generateApiKey();

    createApiKey(request.user.id, keyHash, keyPrefix, name.trim());

    // ⚠️ fullKey 只在创建时返回一次，之后无法再获取
    return reply.code(201).send({
      key: fullKey,
      prefix: keyPrefix,
      message: 'Save this key — it will not be shown again',
    });
  });

  // DELETE /api/auth/keys/:id
  fastify.delete('/api/auth/keys/:id', {
    preHandler: [fastify.authenticate],
  }, async (request, reply) => {
    const keys = findApiKeysByUser(request.user.id);
    const target = keys.find(k => k.id === Number(request.params.id));
    if (!target) {
      return reply.code(404).send({ error: 'Key not found' });
    }
    deleteApiKey(target.id);
    return { ok: true };
  });
}
