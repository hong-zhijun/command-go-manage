/**
 * 自定义 API Key 鉴权
 *
 * 系统签发 sk-cg-xxxx 给用户，用户用它调代理接口。
 * 这里负责生成、验证、查找对应用户。
 */
import crypto from 'crypto';
import config from '../config.js';
import { createApiKey, touchApiKey } from '../db/index.js';
import { getDb } from '../db/index.js';

/**
 * 生成一个新的 API Key
 * @returns {{ fullKey: string, keyHash: string, keyPrefix: string }}
 */
export function generateApiKey() {
  const random = crypto.randomBytes(24).toString('base64url');
  const fullKey = `${config.apiKeyPrefix}${random}`;
  const keyHash = hashApiKey(fullKey);
  const keyPrefix = fullKey.slice(0, config.apiKeyPrefix.length + 8);
  return { fullKey, keyHash, keyPrefix };
}

/**
 * 对 API Key 做 SHA-256 哈希（用于数据库存储和查找）
 * 不用 bcrypt 是因为每个请求都要查——bcrypt 太慢
 */
export function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * 从请求头提取 API Key
 */
export function extractApiKey(headers) {
  // Authorization: Bearer sk-cg-xxxx
  const auth = headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token.startsWith(config.apiKeyPrefix)) return token;
  }
  // x-api-key: sk-cg-xxxx
  const xKey = headers['x-api-key'] || '';
  if (xKey.startsWith(config.apiKeyPrefix)) return xKey;
  return null;
}

/**
 * 验证 API Key 并返回用户信息
 * @returns {{ userId, username, role, apiKeyId } | null}
 */
export function validateApiKey(rawKey) {
  if (!rawKey) return null;

  const keyHash = hashApiKey(rawKey);
  const row = getDb().prepare(`
    SELECT ak.id as api_key_id, ak.user_id, ak.is_active as key_active, ak.rate_limit,
           u.username, u.role, u.is_active as user_active
    FROM api_keys ak
    JOIN users u ON ak.user_id = u.id
    WHERE ak.key_hash = ?
  `).get(keyHash);

  if (!row) return null;
  if (!row.key_active || !row.user_active) return null;

  // 更新最后使用时间
  touchApiKey(row.api_key_id);

  return {
    userId: row.user_id,
    username: row.username,
    role: row.role,
    apiKeyId: row.api_key_id,
    rateLimit: row.rate_limit,
  };
}
