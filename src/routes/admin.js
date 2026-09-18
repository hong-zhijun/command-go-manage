/**
 * 管理员路由 — CC Key 池管理 / 系统统计
 */
import {
  listCcKeys, findCcKeyByRawKey, insertCcKey, deleteCcKey, updateCcKeyLabel,
  updateCcKeyDispatch, findCcKeyById,
  getSystemUsageStats, findAllApiKeys,
  getHourlyStats, getDailyStats, getModelDistribution,
  queryUsageLogs, getDistinctModels, startOfDayUTC8,
} from '../db/index.js';
import { syncCcKey, syncAllCcKeys, fetchKeyReport } from '../pool/quota-sync.js';
import { getDeviceSummary, TIMEZONE_OPTIONS } from '../proxy/fingerprint.js';
import { invalidateKeyState } from '../proxy/core.js';

// 掩码 CC Key（只显示前 8 位 + 后 4 位）
function maskCcKey(key) {
  if (!key || key.length <= 12) return key;
  return key.slice(0, 8) + '…' + key.slice(-4);
}

// CC Key 行 → 前端 JSON（含调度参数和指纹摘要）
function toCcKeyView(row) {
  const detail = row.detail ? (() => { try { return JSON.parse(row.detail); } catch { return null; } })() : null;

  // 生成设备指纹摘要
  let deviceSummary = null;
  try {
    const overrides = row.timezone_override ? { timezone: row.timezone_override } : {};
    deviceSummary = getDeviceSummary(row.api_key, overrides);
  } catch { /* 非致命 */ }

  return {
    id: row.id,
    label: row.label,
    maskedKey: maskCcKey(row.api_key),
    status: row.status,
    userName: row.user_name,
    plan: row.plan_id ? {
      planId: row.plan_id,
      name: row.plan_name || row.plan_id,
    } : null,
    credits: {
      monthlyLeft: row.monthly_left,
      purchased: row.purchased,
      freeCredits: row.free_credits,
      fiveHour: row.five_hour_cap != null ? {
        used: row.five_hour_used, cap: row.five_hour_cap,
        exceeded: !!row.five_hour_exceeded, resetAt: row.five_hour_reset,
      } : null,
      weekly: row.weekly_cap != null ? {
        used: row.weekly_used, cap: row.weekly_cap,
        exceeded: !!row.weekly_exceeded, resetAt: row.weekly_reset,
      } : null,
    },
    // 调度参数
    priority: row.priority ?? 10,
    maxConcurrent: row.max_concurrent ?? 0,
    timezoneOverride: row.timezone_override || '',
    // 设备指纹摘要
    device: deviceSummary,
    currentInflight: row.current_inflight,
    lastChecked: row.last_checked,
    lastError: row.last_error,
    detail,
  };
}

export default async function adminRoutes(fastify) {
  // 所有管理路由都需要 admin 角色
  fastify.addHook('preHandler', async (request, reply) => {
    await fastify.authenticate(request, reply);
    if (request.user.role !== 'admin') {
      return reply.code(403).send({ error: 'Admin only' });
    }
  });

  // ── CC Key 池管理 ─────────────────────────────

  // GET /api/admin/cc-keys
  fastify.get('/api/admin/cc-keys', async () => {
    const keys = listCcKeys();
    return { keys: keys.map(toCcKeyView) };
  });

  // GET /api/admin/timezones — 可用时区列表
  fastify.get('/api/admin/timezones', async () => {
    return { timezones: ['', ...TIMEZONE_OPTIONS] };
  });

  // POST /api/admin/cc-keys — 添加 CC Key（先验证再入库）
  fastify.post('/api/admin/cc-keys', async (request, reply) => {
    const { key, label } = request.body || {};
    if (!key) return reply.code(400).send({ error: 'Missing key' });

    const trimmed = key.trim();
    if (!/^[\x21-\x7e]+$/.test(trimmed)) {
      return reply.code(400).send({ error: 'Key contains invalid characters' });
    }

    const existing = findCcKeyByRawKey(trimmed);
    if (existing) {
      return reply.code(409).send({ error: 'Key already exists', key: toCcKeyView(existing) });
    }

    // 先验证 key 是否有效
    try {
      const report = await fetchKeyReport(trimmed);
      insertCcKey(trimmed, label || report.userName || maskCcKey(trimmed));

      // 拉取到的数据立即写入
      const row = findCcKeyByRawKey(trimmed);
      if (row) await syncCcKey(row);

      const fresh = findCcKeyByRawKey(trimmed);
      return reply.code(201).send({ key: toCcKeyView(fresh) });
    } catch (e) {
      return reply.code(400).send({ error: `Key validation failed: ${e.message}` });
    }
  });

  // PATCH /api/admin/cc-keys/:id — 改标签
  fastify.patch('/api/admin/cc-keys/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const { label } = request.body || {};
    if (!label) return reply.code(400).send({ error: 'Missing label' });

    const row = findCcKeyById(id);
    if (!row) return reply.code(404).send({ error: 'Key not found' });

    updateCcKeyLabel(id, label.trim().slice(0, 60));
    const fresh = findCcKeyById(id);
    return { key: toCcKeyView(fresh) };
  });

  // PATCH /api/admin/cc-keys/:id/dispatch — 修改调度参数
  fastify.patch('/api/admin/cc-keys/:id/dispatch', async (request, reply) => {
    const id = Number(request.params.id);
    const row = findCcKeyById(id);
    if (!row) return reply.code(404).send({ error: 'Key not found' });

    const { priority, maxConcurrent, timezoneOverride } = request.body || {};
    updateCcKeyDispatch(id, {
      priority: priority !== undefined ? Number(priority) : undefined,
      maxConcurrent: maxConcurrent !== undefined ? Number(maxConcurrent) : undefined,
      timezoneOverride,
    });

    // 时区变了要清缓存，下次请求重新生成指纹
    if (timezoneOverride !== undefined && timezoneOverride !== row.timezone_override) {
      invalidateKeyState(row.api_key);
    }

    const fresh = findCcKeyById(id);
    return { key: toCcKeyView(fresh) };
  });

  // DELETE /api/admin/cc-keys/:id
  fastify.delete('/api/admin/cc-keys/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const row = findCcKeyById(id);
    if (!row) return reply.code(404).send({ error: 'Key not found' });
    deleteCcKey(id);
    return { ok: true };
  });

  // POST /api/admin/cc-keys/refresh — 刷新一个或全部
  fastify.post('/api/admin/cc-keys/refresh', async (request) => {
    const { id } = request.body || {};
    if (id != null) {
      const row = findCcKeyById(Number(id));
      if (!row) return { error: 'Key not found' };
      const result = await syncCcKey(row);
      const fresh = findCcKeyById(Number(id));
      return { keys: [toCcKeyView(fresh)], result };
    }
    const result = await syncAllCcKeys();
    const keys = listCcKeys();
    return { keys: keys.map(toCcKeyView), result };
  });

  // ── 系统统计 ──────────────────────────────────

  // GET /api/admin/stats
  fastify.get('/api/admin/stats', async () => {
    const now = Date.now();
    const today = getSystemUsageStats(startOfDayUTC8(now));
    const week = getSystemUsageStats(now - 7 * 24 * 60 * 60 * 1000);
    const ccKeys = listCcKeys();

    return {
      today,
      week,
      totalCcKeys: ccKeys.length,
      activeCcKeys: ccKeys.filter(k => k.status === 'active').length,
    };
  });

  // ── 图表数据 ──────────────────────────────────

  // GET /api/admin/charts?range=24h|7d|30d
  fastify.get('/api/admin/charts', async (request) => {
    const range = request.query.range || '7d';
    const rangeMs = {
      '24h': 24 * 60 * 60 * 1000,
      '7d':  7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000,
    }[range] || 7 * 24 * 60 * 60 * 1000;

    // 24h 用小时粒度，7d/30d 用天粒度
    const timeSeries = range === '24h'
      ? getHourlyStats(rangeMs)
      : getDailyStats(rangeMs);

    const modelDist = getModelDistribution(rangeMs);

    // CC Key 池健康摘要
    const ccKeys = listCcKeys();
    const poolHealth = {
      total: ccKeys.length,
      active: ccKeys.filter(k => k.status === 'active').length,
      exhausted: ccKeys.filter(k => k.status === 'exhausted').length,
      error: ccKeys.filter(k => k.status === 'error').length,
      totalInflight: ccKeys.reduce((s, k) => s + (k.current_inflight || 0), 0),
    };

    return { range, timeSeries, modelDist, poolHealth };
  });

  // ── 日志查询 ──────────────────────────────────

  // GET /api/admin/logs?page=1&limit=50&model=xxx&status=ok|error&since=ts&until=ts
  fastify.get('/api/admin/logs', async (request) => {
    const page = Math.max(1, parseInt(request.query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(request.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const result = queryUsageLogs({
      offset,
      limit,
      model: request.query.model || undefined,
      status: request.query.status || undefined,
      since: request.query.since ? Number(request.query.since) : undefined,
      until: request.query.until ? Number(request.query.until) : undefined,
    });

    return {
      page, limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
      logs: result.rows,
    };
  });

  // GET /api/admin/logs/models — 所有模型名列表（筛选用）
  fastify.get('/api/admin/logs/models', async () => {
    return { models: getDistinctModels() };
  });
}
