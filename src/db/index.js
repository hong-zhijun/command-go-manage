/**
 * SQLite 数据库封装（better-sqlite3）
 * 同步操作，简单可靠，适合单机部署
 */
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hashSync, compareSync } from 'bcryptjs';
import config from '../config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db;

export function getDb() {
  if (db) return db;

  // 确保数据目录存在
  const dbDir = dirname(resolve(config.dbPath));
  mkdirSync(dbDir, { recursive: true });

  db = new Database(resolve(config.dbPath), {
    // WAL 模式：并发读 + 写不阻塞读
    // verbose: process.env.NODE_ENV === 'development' ? console.log : undefined,
  });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // 执行建表
  const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf-8');
  db.exec(schema);

  // 迁移：给已有 cc_keys 表补新字段
  const ccCols = db.pragma('table_info(cc_keys)').map(c => c.name);
  const migrations = [
    ['priority',          'INTEGER NOT NULL DEFAULT 10'],
    ['max_concurrent',    'INTEGER NOT NULL DEFAULT 0'],
    ['timezone_override', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [col, def] of migrations) {
    if (!ccCols.includes(col)) {
      db.exec(`ALTER TABLE cc_keys ADD COLUMN ${col} ${def}`);
      console.log(`[db] Migrated cc_keys: added ${col}`);
    }
  }

  // 创建初始管理员（如果不存在）；已存在则同步环境变量中的密码
  const admin = db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(config.adminUsername);
  if (!admin) {
    const hash = hashSync(config.adminPassword, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
    ).run(config.adminUsername, hash, 'admin', Date.now());
    console.log(`[db] Admin user "${config.adminUsername}" created`);
  } else {
    // 环境变量密码与数据库不一致时自动更新
    if (!compareSync(config.adminPassword, admin.password_hash)) {
      const newHash = hashSync(config.adminPassword, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newHash, admin.id);
      console.log(`[db] Admin password synced from environment`);
    }
  }

  // 启动时清除残留的 inflight 计数（进程崩溃后不会归零）
  db.exec('UPDATE cc_keys SET current_inflight = 0');

  // 清理 90 天前的 usage_logs
  const retentionMs = 90 * 24 * 60 * 60 * 1000;
  const pruned = db.prepare('DELETE FROM usage_logs WHERE created_at < ?').run(Date.now() - retentionMs);
  if (pruned.changes > 0) console.log(`[db] Pruned ${pruned.changes} old usage_logs`);

  console.log('[db] Database ready:', resolve(config.dbPath));
  return db;
}

// ── Users ──────────────────────────────────────────

export function findUserByUsername(username) {
  return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

export function findUserById(id) {
  return getDb().prepare('SELECT id, username, role, is_active, created_at, last_login FROM users WHERE id = ?').get(id);
}

export function createUser(username, passwordHash, role = 'user') {
  const stmt = getDb().prepare(
    'INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)'
  );
  return stmt.run(username, passwordHash, role, Date.now());
}

export function listUsers() {
  return getDb().prepare(
    'SELECT id, username, role, is_active, created_at, last_login FROM users ORDER BY id ASC'
  ).all();
}

export function updateUserLogin(id) {
  getDb().prepare('UPDATE users SET last_login = ? WHERE id = ?').run(Date.now(), id);
}

export function updateUserActive(id, isActive) {
  getDb().prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
}

export function deleteUser(id) {
  getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
}

// ── API Keys（系统签发给用户的） ───────────────────

export function createApiKey(userId, keyHash, keyPrefix, name = 'default') {
  const stmt = getDb().prepare(
    'INSERT INTO api_keys (user_id, key_hash, key_prefix, name, created_at) VALUES (?, ?, ?, ?, ?)'
  );
  return stmt.run(userId, keyHash, keyPrefix, name, Date.now());
}

export function findApiKeysByUser(userId) {
  return getDb().prepare(
    'SELECT id, user_id, key_prefix, name, rate_limit, is_active, created_at, last_used, total_calls FROM api_keys WHERE user_id = ? ORDER BY id ASC'
  ).all(userId);
}

export function findAllApiKeys() {
  return getDb().prepare(
    `SELECT ak.id, ak.user_id, ak.key_prefix, ak.name, ak.rate_limit, ak.is_active,
            ak.created_at, ak.last_used, ak.total_calls, u.username
     FROM api_keys ak JOIN users u ON ak.user_id = u.id
     ORDER BY ak.id ASC`
  ).all();
}

export function findApiKeyByHash(keyHash) {
  return getDb().prepare(
    `SELECT ak.*, u.username, u.role, u.is_active as user_active
     FROM api_keys ak JOIN users u ON ak.user_id = u.id
     WHERE ak.key_hash = ?`
  ).get(keyHash);
}

export function touchApiKey(id) {
  getDb().prepare(
    'UPDATE api_keys SET last_used = ?, total_calls = total_calls + 1 WHERE id = ?'
  ).run(Date.now(), id);
}

export function deleteApiKey(id) {
  getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function updateApiKeyActive(id, isActive) {
  getDb().prepare('UPDATE api_keys SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id);
}

// ── CC Keys（管理员配置的原始密钥池） ──────────────

export function listCcKeys() {
  return getDb().prepare('SELECT * FROM cc_keys ORDER BY id ASC').all();
}

export function listActiveCcKeys() {
  return getDb().prepare(
    "SELECT * FROM cc_keys WHERE status = 'active' ORDER BY id ASC"
  ).all();
}

export function findCcKeyById(id) {
  return getDb().prepare('SELECT * FROM cc_keys WHERE id = ?').get(id);
}

export function findCcKeyByRawKey(apiKey) {
  return getDb().prepare('SELECT * FROM cc_keys WHERE api_key = ?').get(apiKey);
}

export function insertCcKey(apiKey, label) {
  const stmt = getDb().prepare(
    'INSERT INTO cc_keys (api_key, label, created_at) VALUES (?, ?, ?)'
  );
  return stmt.run(apiKey, label, Date.now());
}

export function updateCcKeyQuota(id, data) {
  const stmt = getDb().prepare(`
    UPDATE cc_keys SET
      user_name = ?, plan_id = ?, plan_name = ?,
      monthly_left = ?, purchased = ?, free_credits = ?,
      five_hour_used = ?, five_hour_cap = ?, five_hour_exceeded = ?, five_hour_reset = ?,
      weekly_used = ?, weekly_cap = ?, weekly_exceeded = ?, weekly_reset = ?,
      last_checked = ?, last_error = ?, status = ?, detail = ?
    WHERE id = ?
  `);
  stmt.run(
    data.userName || '', data.planId || '', data.planName || '',
    data.monthlyLeft ?? null, data.purchased ?? null, data.freeCredits ?? null,
    data.fiveHourUsed ?? null, data.fiveHourCap ?? null, data.fiveHourExceeded ? 1 : 0, data.fiveHourReset ?? 0,
    data.weeklyUsed ?? null, data.weeklyCap ?? null, data.weeklyExceeded ? 1 : 0, data.weeklyReset ?? 0,
    Date.now(), data.lastError || '', data.status || 'active', data.detail || null,
    id
  );
}

export function updateCcKeyStatus(id, status, error = '') {
  getDb().prepare('UPDATE cc_keys SET status = ?, last_error = ?, last_checked = ? WHERE id = ?')
    .run(status, error, Date.now(), id);
}

export function updateCcKeyInflight(id, delta) {
  getDb().prepare(
    'UPDATE cc_keys SET current_inflight = MAX(0, current_inflight + ?) WHERE id = ?'
  ).run(delta, id);
}

export function deleteCcKey(id) {
  getDb().prepare('DELETE FROM cc_keys WHERE id = ?').run(id);
}

export function updateCcKeyLabel(id, label) {
  getDb().prepare('UPDATE cc_keys SET label = ? WHERE id = ?').run(label, id);
}

export function updateCcKeyDispatch(id, { priority, maxConcurrent, timezoneOverride }) {
  const sets = [];
  const vals = [];
  if (priority !== undefined)          { sets.push('priority = ?');          vals.push(Math.max(1, Math.min(100, priority))); }
  if (maxConcurrent !== undefined)     { sets.push('max_concurrent = ?');    vals.push(Math.max(0, maxConcurrent)); }
  if (timezoneOverride !== undefined)  { sets.push('timezone_override = ?'); vals.push(timezoneOverride || ''); }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().prepare(`UPDATE cc_keys SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

// ── Usage Logs ──────────────────────────────────────

export function insertUsageLog(log) {
  const stmt = getDb().prepare(`
    INSERT INTO usage_logs (user_id, api_key_id, cc_key_id, model, input_tokens, output_tokens,
                            cached_tokens, latency_ms, status, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    log.userId, log.apiKeyId, log.ccKeyId, log.model || '',
    log.inputTokens || 0, log.outputTokens || 0, log.cachedTokens || 0,
    log.latencyMs || 0, log.status || 'ok', log.errorMessage || '',
    Date.now()
  );
}

export function getUserUsageStats(userId, since) {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      SUM(cached_tokens) as total_cached_tokens,
      SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as success_calls,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_calls
    FROM usage_logs WHERE user_id = ? AND created_at >= ?
  `).get(userId, since || 0);
}

export function getSystemUsageStats(since) {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total_calls,
      SUM(input_tokens) as total_input_tokens,
      SUM(output_tokens) as total_output_tokens,
      COUNT(DISTINCT user_id) as active_users
    FROM usage_logs WHERE created_at >= ?
  `).get(since || 0);
}

// ── UTC+8 时间工具 ────────────────────────────────

const UTC8_MS = 8 * 3600000;

export function startOfDayUTC8(ts = Date.now()) {
  return Math.floor((ts + UTC8_MS) / 86400000) * 86400000 - UTC8_MS;
}

// ── 时序聚合（图表用） ──────────────────────────────

/**
 * 按小时聚合请求量 & token（最近 N 毫秒）
 */
export function getHourlyStats(sinceMs) {
  const since = Date.now() - sinceMs;
  return getDb().prepare(`
    SELECT
      CAST((created_at / 3600000) AS INTEGER) * 3600000 AS hour_ts,
      COUNT(*)                       AS calls,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_calls,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS err_calls,
      SUM(input_tokens)              AS input_tokens,
      SUM(output_tokens)             AS output_tokens,
      SUM(cached_tokens)             AS cached_tokens
    FROM usage_logs
    WHERE created_at >= ?
    GROUP BY hour_ts
    ORDER BY hour_ts ASC
  `).all(since);
}

/**
 * 按天聚合请求量 & token（最近 N 毫秒），按 UTC+8 日界分组
 */
export function getDailyStats(sinceMs) {
  const since = Date.now() - sinceMs;
  const offset = UTC8_MS;
  return getDb().prepare(`
    SELECT
      (CAST(((created_at + ${offset}) / 86400000) AS INTEGER) * 86400000 - ${offset}) AS day_ts,
      COUNT(*)                       AS calls,
      SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok_calls,
      SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) AS err_calls,
      SUM(input_tokens)              AS input_tokens,
      SUM(output_tokens)             AS output_tokens,
      SUM(cached_tokens)             AS cached_tokens
    FROM usage_logs
    WHERE created_at >= ?
    GROUP BY day_ts
    ORDER BY day_ts ASC
  `).all(since);
}

/**
 * 按模型聚合调用量（最近 N 毫秒）
 */
export function getModelDistribution(sinceMs) {
  const since = Date.now() - sinceMs;
  return getDb().prepare(`
    SELECT
      model,
      COUNT(*)          AS calls,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens
    FROM usage_logs
    WHERE created_at >= ? AND model != ''
    GROUP BY model
    ORDER BY calls DESC
    LIMIT 20
  `).all(since);
}

/**
 * 分页查询 usage_logs
 */
export function queryUsageLogs({ offset = 0, limit = 50, model, status, since, until } = {}) {
  const conditions = [];
  const params = [];

  if (model)  { conditions.push('model = ?');        params.push(model); }
  if (status) { conditions.push('status = ?');       params.push(status); }
  if (since)  { conditions.push('created_at >= ?');  params.push(since); }
  if (until)  { conditions.push('created_at <= ?');  params.push(until); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  const total = getDb().prepare(`SELECT COUNT(*) AS cnt FROM usage_logs ${where}`).get(...params).cnt;

  const rows = getDb().prepare(`
    SELECT ul.*, u.username, ak.key_prefix, ak.name AS api_key_name, ck.label AS cc_label
    FROM usage_logs ul
    LEFT JOIN users u ON ul.user_id = u.id
    LEFT JOIN api_keys ak ON ul.api_key_id = ak.id
    LEFT JOIN cc_keys ck ON ul.cc_key_id = ck.id
    ${where}
    ORDER BY ul.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { total, rows };
}

/**
 * 获取所有不同模型名（给前端筛选用）
 */
export function getDistinctModels() {
  return getDb().prepare(
    "SELECT DISTINCT model FROM usage_logs WHERE model != '' ORDER BY model"
  ).all().map(r => r.model);
}

// ── Cleanup ─────────────────────────────────────────

export function closeDb() {
  if (db) {
    db.close();
    db = undefined;
  }
}
