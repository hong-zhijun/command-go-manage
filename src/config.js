/**
 * 统一配置 — 环境变量优先，回退到默认值
 */
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

// 项目根目录（src/ 的上一级）
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const config = {
  // 服务
  port: parseInt(process.env.PORT || '3050', 10),
  host: process.env.HOST || '0.0.0.0',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production-' + Date.now(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // 初始管理员（首次启动自动创建）
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',

  // CC 上游
  ccApiBase: process.env.CC_API_BASE || 'https://api.commandcode.ai',
  ccProjectSlug: process.env.CC_PROJECT_SLUG || 'cc-proxy',

  // CC 代理行为
  ccStreamIdleMs: parseInt(process.env.CC_STREAM_IDLE_MS || '30000', 10),
  ccNonStreamIdleMs: parseInt(process.env.CC_NONSTREAM_IDLE_MS || '90000', 10),
  ccMaxBodyMb: parseInt(process.env.CC_MAX_BODY_MB || '100', 10),

  // 设备伪装
  ccProtocolVersion: '1.53.1',
  ccCliMode: process.env.CC_CLI_MODE || 'agent',
  ccCliSessionMode: process.env.CC_CLI_SESSION_MODE || 'interactive',
  ccFingerprintSalt: process.env.CC_FINGERPRINT_SALT || '',
  ccDeviceProjectDir: process.env.CC_DEVICE_PROJECT_DIR || 'C:\\Users\\dev\\projects\\app',
  ccEmptySystemPlaceholder: process.env.CC_EMPTY_SYSTEM_PLACEHOLDER !== 'false',
  ccZdr: process.env.CMD_ZDR === '1',

  // Key 池
  quotaRefreshIntervalMs: parseInt(process.env.QUOTA_REFRESH_INTERVAL_MS || '300000', 10), // 5min
  modelRefreshIntervalMs: parseInt(process.env.MODEL_REFRESH_INTERVAL_MS || '300000', 10),

  // 数据库（相对于项目根目录解析）
  dbPath: process.env.DB_PATH || resolve(PROJECT_ROOT, 'data', 'command-go.db'),

  // 自定义 API Key 前缀
  apiKeyPrefix: process.env.API_KEY_PREFIX || 'sk-cg-',
};

export default config;
