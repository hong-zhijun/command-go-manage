/**
 * Command Go Manage — Fastify 主入口
 *
 * 一个端口同时提供：
 * - /v1/*          API 代理（OpenAI 兼容）
 * - /api/auth/*    认证
 * - /api/admin/*   管理后台
 * - /api/dashboard 用户面板
 * - /              Web 前端
 */
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCors from '@fastify/cors';
import fastifyJwt from '@fastify/jwt';
import fastifyFormbody from '@fastify/formbody';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import config from './config.js';
import { getDb, closeDb } from './db/index.js';
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin.js';
import proxyRoutes from './routes/proxy.js';
import dashboardRoutes from './routes/dashboard.js';
import { startQuotaSync, stopQuotaSync } from './pool/quota-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  // JWT Secret 安全提醒
  if (config.jwtSecret.startsWith('change-me-in-production')) {
    console.warn('\n⚠️  WARNING: JWT_SECRET is using the default value!');
    console.warn('   Set JWT_SECRET env var in production to a random string.\n');
  }

  // 初始化数据库
  getDb();

  const app = Fastify({
    logger: true,
    // 允许大请求体（代理需要）
    bodyLimit: config.ccMaxBodyMb * 1024 * 1024,
  });

  // ── 插件 ──────────────────────────────────────

  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await app.register(fastifyFormbody);

  // 兼容旧 proxy 行为：不管 Content-Type 是什么都尝试按 JSON 解析请求体。
  // 部分 AI 客户端发 text/plain 或不带 Content-Type，Fastify 默认不解析会导致 400。
  app.addContentTypeParser('*', { parseAs: 'string' }, (req, body, done) => {
    try {
      const json = body ? JSON.parse(body) : undefined;
      done(null, json);
    } catch {
      done(null, body);
    }
  });

  await app.register(fastifyJwt, {
    secret: config.jwtSecret,
    sign: { expiresIn: config.jwtExpiresIn },
  });

  // JWT 认证装饰器
  app.decorate('authenticate', async function (request, reply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized', message: err.message });
    }
  });

  // 静态文件：Web 前端
  await app.register(fastifyStatic, {
    root: resolve(__dirname, 'web'),
    prefix: '/',
    decorateReply: false,
  });

  // ── 路由 ──────────────────────────────────────

  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(proxyRoutes);
  await app.register(dashboardRoutes);

  // ── 启动 ──────────────────────────────────────

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`
┌──────────────────────────────────────────────┐
│                                              │
│   🚀 Command Go Manage                      │
│                                              │
│   Web Panel:  http://${config.host}:${config.port}        │
│   API Proxy:  http://${config.host}:${config.port}/v1     │
│   Health:     http://${config.host}:${config.port}/health  │
│                                              │
│   Admin:  ${config.adminUsername} / ${config.adminPassword.slice(0, 3)}***          │
│                                              │
└──────────────────────────────────────────────┘
`);

    // 启动额度定期同步
    startQuotaSync();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // 优雅退出
  const shutdown = async () => {
    console.log('\n[shutdown] Stopping...');
    stopQuotaSync();
    await app.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
