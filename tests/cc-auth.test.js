import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import formbody from '@fastify/formbody';

test('localhost authorization imports validate and save accounts once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'command-go-auth-'));
  process.env.DB_PATH = join(directory, 'test.db');
  delete process.env.PUBLIC_BASE_URL;
  process.env.ADMIN_PASSWORD = 'test-password';
  const upstream = Fastify({ logger: false });
  let identityMode = 'valid';
  upstream.get('/alpha/whoami', async (request, reply) => {
    if (identityMode === 'offline') return reply.code(503).send({ error: 'unavailable' });
    if (identityMode === 'malformed') return { success: false };
    if (request.headers.authorization !== 'Bearer user_test-key') return reply.code(401).send({});
    return { success: true, user: { id: 'user-id', userName: 'verified-account' } };
  });
  upstream.get('/alpha/billing/credits', async () => ({ credits: { monthlyCredits: 10 } }));
  upstream.get('/alpha/billing/subscriptions', async () => ({}));
  upstream.get('/alpha/usage/summary', async () => ({ totalCount: 0 }));
  await upstream.listen({ host: '127.0.0.1', port: 0 });
  process.env.CC_API_BASE = upstream.listeningOrigin;
  const { default: routes } = await import('../src/routes/cc-auth.js');
  const db = await import('../src/db/index.js');
  const { updateCcAuthSession } = await import('../src/cc-auth/flow.js');
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: 'test-jwt-secret' });
  await app.register(formbody);
  app.decorate('authenticate', async function (request, reply) {
    try { await request.jwtVerify(); }
    catch { return reply.code(401).send({ error: 'Unauthorized' }); }
  });
  await app.register(routes);
  await app.ready();
  t.after(async () => {
    await app.close();
    await upstream.close();
    db.closeDb();
    rmSync(directory, { recursive: true, force: true });
  });
  const headers = { authorization: `Bearer ${app.jwt.sign({ id: 1, role: 'admin' })}` };
  const otherAdmin = { authorization: `Bearer ${app.jwt.sign({ id: 2, role: 'admin' })}` };
  const start = async () => {
    const response = await app.inject({ method: 'POST', url: '/api/admin/cc-keys/auth/start', headers, payload: { label: 'My account' } });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    const link = new URL(result.authorizationUrl);
    assert.equal(link.origin, 'https://commandcode.ai');
    assert.equal(link.searchParams.get('callback'), 'http://localhost:5959/callback');
    return { ...result, state: link.searchParams.get('state') };
  };
  const callback = (session, extra = {}, format = 'json', authHeaders = headers) => {
    const payload = { state: session.state, apiKey: 'user_test-key', userId: 'user-id', userName: 'untrusted-label', keyName: 'cli-test', ...extra };
    let content = JSON.stringify(payload);
    if (format === 'form') content = new URLSearchParams(payload).toString();
    if (format === 'curl') content = `curl 'http://localhost:5959/callback' --data-raw '${new URLSearchParams(payload)}'`;
    return app.inject({ method: 'POST', url: '/api/admin/cc-keys/auth/import', headers: authHeaders, payload: { sessionId: session.sessionId, content } });
  };
  const status = session => app.inject({ url: `/api/admin/cc-keys/auth/status/${session.sessionId}`, headers });

  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/cc-keys/auth/start' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/admin/cc-keys/auth/start', headers: { authorization: `Bearer ${app.jwt.sign({ id: 1, role: 'user' })}` } })).statusCode, 403);
  const first = await start();
  assert.equal((await app.inject({ url: `/api/admin/cc-keys/auth/status/${first.sessionId}`, headers: otherAdmin })).statusCode, 404);
  assert.equal((await callback(first, {}, 'json', {})).statusCode, 401);
  assert.equal((await callback(first, {}, 'json', otherAdmin)).statusCode, 404);
  assert.equal((await callback(first, { state: 'wrong-state' })).statusCode, 403);
  const stateOnly = await app.inject({ method: 'POST', url: '/api/admin/cc-keys/auth/import', headers, payload: { sessionId: first.sessionId, content: `http://localhost:5959/callback/complete?state=${first.state}` } });
  assert.equal(stateOnly.statusCode, 400);
  assert.match(stateOnly.json().error, /没有 apiKey/);
  const wrongUrl = await app.inject({ method: 'POST', url: '/api/admin/cc-keys/auth/import', headers, payload: { sessionId: first.sessionId, content: `curl 'https://other.example/callback' --data-raw 'apiKey=user_test-key&state=${first.state}'` } });
  assert.equal(wrongUrl.statusCode, 400);
  assert.equal((await status(first)).json().status, 'pending');
  const second = await start();
  assert.equal((await callback(first)).statusCode, 404);
  updateCcAuthSession(second.sessionId, { expiresAt: Date.now() - 1 });
  assert.equal((await callback(second)).statusCode, 404);

  const denied = await start();
  await callback(denied, { error: 'access_denied' });
  assert.equal((await status(denied)).json().status, 'denied');
  assert.equal((await callback(denied)).statusCode, 409);

  const malformed = await start();
  assert.equal((await callback(malformed, { userId: {} })).statusCode, 400);
  const oversized = await start();
  assert.equal((await callback(oversized, { keyName: 'a'.repeat(130000) })).statusCode, 413);

  for (const mode of ['offline', 'malformed', 'rejected']) {
    identityMode = mode;
    const session = await start();
    const key = mode === 'rejected' ? 'user_invalid-key' : 'user_test-key';
    assert.equal((await callback(session, { apiKey: key })).statusCode, 400);
    assert.equal((await status(session)).json().status, 'pending');
    assert.equal(db.listCcKeys().length, 0);
  }
  identityMode = 'valid';
  const success = await start();
  const response = await callback(success, {}, 'curl');
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(!response.body.includes('user_test-key'));
  const saved = db.listCcKeys();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].label, 'My account');
  assert.equal(saved[0].user_name, 'verified-account');
  assert.equal(saved[0].api_key, 'user_test-key');
  const result = await status(success);
  assert.equal(result.json().status, 'success');
  assert.ok(!result.body.includes('user_test-key'));
  assert.equal((await callback(success)).statusCode, 409);
  const duplicate = await start();
  assert.equal((await callback(duplicate, {}, 'form')).statusCode, 200);
  assert.equal(db.listCcKeys().length, 1);
  const cancelled = await start();
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/admin/cc-keys/auth/session/${cancelled.sessionId}`, headers })).statusCode, 200);
  assert.equal((await callback(cancelled)).statusCode, 404);
});

test('dashboard inline JavaScript parses', () => {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const source = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(source);
});

test('complete server starts and exposes the authorization UI and routes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'command-go-server-'));
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: new URL('..', import.meta.url),
    windowsHide: true,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DB_PATH: join(directory, 'test.db'), JWT_SECRET: 'smoke-secret', ADMIN_USERNAME: 'smoke-admin', ADMIN_PASSWORD: 'smoke-password', PUBLIC_BASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) { ready = true; break; }
    } catch { /* process is starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('浏览器授权'));
  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'smoke-admin', password: 'smoke-password' }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const start = await fetch(`${base}/api/admin/cc-keys/auth/start`, { method: 'POST', headers, body: '{}' });
  assert.equal(start.status, 200);
  const session = await start.json();
  const status = await fetch(`${base}/api/admin/cc-keys/auth/status/${session.sessionId}`, { headers });
  assert.equal((await status.json()).status, 'pending');
  const pool = await fetch(`${base}/api/admin/cc-keys`, { headers });
  assert.equal(pool.status, 200);
  assert.deepEqual((await pool.json()).keys, []);
});
