-- ============================================================
-- Command Go Manage — 数据库 schema
-- ============================================================

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'user',   -- 'admin' | 'user'
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  last_login    INTEGER NOT NULL DEFAULT 0
);

-- 系统签发的 API Key（用户拿这个调代理）
CREATE TABLE IF NOT EXISTS api_keys (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash    TEXT    NOT NULL UNIQUE,             -- bcrypt hash
  key_prefix  TEXT    NOT NULL,                    -- sk-cg-xxxx（前8位，用于展示）
  name        TEXT    NOT NULL DEFAULT 'default',  -- 用户自定义名称
  rate_limit  INTEGER NOT NULL DEFAULT 60,         -- 每分钟请求上限
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL DEFAULT 0,
  total_calls INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- CC 原始 Key 池（管理员配置）
CREATE TABLE IF NOT EXISTS cc_keys (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key             TEXT    NOT NULL UNIQUE,       -- user_xxxx（CC 原始 key）
  label               TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'active', -- 'active' | 'exhausted' | 'banned' | 'error'
  -- 用户身份缓存
  user_name           TEXT    NOT NULL DEFAULT '',
  -- 套餐
  plan_id             TEXT    NOT NULL DEFAULT '',
  plan_name           TEXT    NOT NULL DEFAULT '',
  -- 额度缓存
  monthly_left        REAL,
  purchased           REAL,
  free_credits        REAL,
  five_hour_used      REAL,
  five_hour_cap       REAL,
  five_hour_exceeded  INTEGER NOT NULL DEFAULT 0,
  five_hour_reset     INTEGER NOT NULL DEFAULT 0,
  weekly_used         REAL,
  weekly_cap          REAL,
  weekly_exceeded     INTEGER NOT NULL DEFAULT 0,
  weekly_reset        INTEGER NOT NULL DEFAULT 0,
  -- 调度参数（管理员可控）
  priority            INTEGER NOT NULL DEFAULT 10,   -- 权重 1-100，越大越优先
  max_concurrent      INTEGER NOT NULL DEFAULT 0,    -- 最大并发请求数，0=不限
  timezone_override   TEXT    NOT NULL DEFAULT '',    -- 指纹时区覆盖，空=自动
  -- 运行状态
  current_inflight    INTEGER NOT NULL DEFAULT 0,    -- 当前在途请求数
  last_checked        INTEGER NOT NULL DEFAULT 0,
  last_error          TEXT    NOT NULL DEFAULT '',
  created_at          INTEGER NOT NULL,
  -- 扩展详情 JSON
  detail              TEXT
);

-- 调用日志
CREATE TABLE IF NOT EXISTS usage_logs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL,
  api_key_id      INTEGER,                           -- 用户的自定义 key
  cc_key_id       INTEGER,                           -- 使用的 CC key
  model           TEXT    NOT NULL DEFAULT '',
  input_tokens    INTEGER NOT NULL DEFAULT 0,
  output_tokens   INTEGER NOT NULL DEFAULT 0,
  cached_tokens   INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  status          TEXT    NOT NULL DEFAULT 'ok',      -- 'ok' | 'error' | 'timeout'
  error_message   TEXT    NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usage_logs_user   ON usage_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_logs_time   ON usage_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_usage_logs_cc_key ON usage_logs(cc_key_id);

-- ── 迁移：给已有 cc_keys 表补新字段 ──
-- SQLite 的 ALTER TABLE ADD COLUMN 碰到已存在的列会报错，用 pragma 检查绕过
-- 这里简单用一段安全的方式：如果列不存在就加
-- 注意：better-sqlite3 的 db.exec() 会在报错时停止，所以分开执行

-- 如果 cc_keys 表已存在但缺少 priority 列，需要在 JS 层做迁移
