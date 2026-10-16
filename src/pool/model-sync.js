/**
 * 模型同步器
 *
 * 由管理员在面板手动触发，从池中每个未停用的 CC Key 拉取上游可用模型
 * （/provider/v1/models），取并集写入 models 表。对外开放哪些模型由管理员在面板中控制：
 * - 未开启模型白名单：/v1/models 返回全部可用模型，请求不限制模型
 * - 开启模型白名单：/v1/models 只返回已勾选的模型，其余模型的请求直接拒绝
 */
import config from '../config.js';
import {
  listCcKeys, listModels, listEnabledModelIds, isModelEnabled, mergeModelSync,
  getSetting, setSetting,
} from '../db/index.js';

// 上游无数据时的兜底列表
export const FALLBACK_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-haiku-4-5-20251001',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
  'moonshotai/Kimi-K2.6',
  'moonshotai/Kimi-K2.5',
  'Qwen/Qwen3.7-Max',
  'Qwen/Qwen3.6-Plus',
  'google/gemini-3.5-flash',
  'xiaomi/mimo-v2.5',
];

const FILTER_SETTING = 'model_filter_enabled';
const LAST_SYNC_SETTING = 'model_last_sync';

export function isModelFilterEnabled() {
  return getSetting(FILTER_SETTING, '0') === '1';
}

export function setModelFilterEnabled(enabled) {
  setSetting(FILTER_SETTING, enabled ? '1' : '0');
}

export function getLastModelSync() {
  return Number(getSetting(LAST_SYNC_SETTING, '0')) || 0;
}

/**
 * 拉取单个 CC Key 的上游模型列表
 * @returns {Promise<{ id: string, ownedBy: string }[]>}
 */
export async function fetchKeyModels(apiKey) {
  const resp = await fetch(`${config.ccApiBase}/provider/v1/models`, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json',
      'x-cli-environment': 'production',
      'x-command-code-version': config.ccProtocolVersion,
    },
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
  if (!list) throw new Error('Unexpected models response');
  return list
    .map(m => (typeof m === 'string' ? { id: m } : m))
    .filter(m => m && typeof m.id === 'string' && m.id)
    .map(m => ({ id: m.id, ownedBy: typeof m.owned_by === 'string' ? m.owned_by : '' }));
}

let syncing = null;

/**
 * 同步所有未停用 Key 的模型（并发调用合并为一次）
 */
export function syncAllModels() {
  if (!syncing) syncing = doSync().finally(() => { syncing = null; });
  return syncing;
}

async function doSync() {
  const keys = listCcKeys().filter(k => !k.is_disabled);
  const results = await Promise.allSettled(keys.map(k => fetchKeyModels(k.api_key)));

  const seen = new Map();
  const failedKeyIds = [];
  results.forEach((r, i) => {
    const keyId = keys[i].id;
    if (r.status !== 'fulfilled') { failedKeyIds.push(keyId); return; }
    for (const m of r.value) {
      const entry = seen.get(m.id) || { ownedBy: m.ownedBy, keyIds: [] };
      entry.keyIds.push(keyId);
      if (!entry.ownedBy && m.ownedBy) entry.ownedBy = m.ownedBy;
      seen.set(m.id, entry);
    }
  });

  const added = mergeModelSync(seen, keys.map(k => k.id), failedKeyIds);
  setSetting(LAST_SYNC_SETTING, Date.now());

  const fail = failedKeyIds.length;
  if (fail > 0) console.log(`[model-sync] ${fail}/${keys.length} keys failed`);
  if (added > 0) console.log(`[model-sync] Discovered ${added} new model(s)`);
  return { total: keys.length, ok: keys.length - fail, fail, models: seen.size, added };
}

/**
 * 对调用者可见的模型 ID 列表
 */
export function getExposedModelIds() {
  if (isModelFilterEnabled()) return listEnabledModelIds();
  const available = listModels().filter(m => m.available).map(m => m.id);
  return available.length ? available : FALLBACK_MODELS;
}

/**
 * 请求的模型是否允许调用（未开启白名单时一律放行）
 */
export function isModelAllowed(model) {
  if (!isModelFilterEnabled()) return true;
  return isModelEnabled(model);
}
