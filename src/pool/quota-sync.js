/**
 * 额度同步器（提取自 commandcode-usage）
 *
 * 定期拉取所有 CC Key 的额度数据并更新到数据库。
 * 每个 Key 调 4 个上游端点：whoami / credits / subscriptions / usage-summary
 */
import config from '../config.js';
import { listCcKeys, updateCcKeyQuota, updateCcKeyStatus } from '../db/index.js';

// 已知套餐月度信用额
const KNOWN_PLANS = {
  'individual-go':       { name: 'Go',         monthlyCredits: 10 },
  'individual-goat':     { name: 'GOAT',       monthlyCredits: 70 },
  'individual-pro':      { name: 'Pro',        monthlyCredits: 30 },
  'individual-pro-v1':   { name: 'Pro',        monthlyCredits: 80 },
  'individual-provider': { name: 'Provider',   monthlyCredits: 15 },
  'individual-max':      { name: 'Max',        monthlyCredits: 150 },
  'individual-ultra':    { name: 'Ultra',      monthlyCredits: 300 },
  'teams-pro':           { name: 'Teams Pro',  monthlyCredits: 40 },
};

const PLAN_PREFIXES = Object.keys(KNOWN_PLANS).sort((a, b) => b.length - a.length);

function planInfo(planId) {
  if (!planId) return undefined;
  const norm = String(planId).toLowerCase().replace(/_/g, '-');
  const prefix = PLAN_PREFIXES.find(p => norm.startsWith(p));
  return prefix ? KNOWN_PLANS[prefix] : undefined;
}

function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : null; }

function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  if (typeof v === 'string' && v) { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
  return null;
}

async function getJson(path, key) {
  const resp = await fetch(config.ccApiBase + path, {
    headers: {
      'Authorization': 'Bearer ' + key,
      'Accept': 'application/json',
      'User-Agent': 'command-go-manage/1.0',
    },
  });
  if (!resp.ok) {
    const err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

function pickWindow(wl, names) {
  for (const n of names) if (isRecord(wl[n])) return wl[n];
  return undefined;
}

function normalizeWindow(raw) {
  if (!isRecord(raw)) return {};
  const used = num(raw.used) ?? num(raw.usage) ?? 0;
  const cap = num(raw.cap) ?? num(raw.limit) ?? 0;
  const exceeded = raw.exceeded === true || raw.exceeded === 'true' || (cap > 0 && used >= cap);
  return { used, cap, exceeded, resetAt: toEpochMs(raw.resetAt ?? raw.reset_at) ?? 0 };
}

/**
 * 拉取单个 CC Key 的额度报告
 */
export async function fetchKeyReport(apiKey) {
  const report = {};

  // 1. whoami
  try {
    const who = await getJson('/alpha/whoami', apiKey);
    const user = isRecord(who.user) ? who.user : (isRecord(who.data?.user) ? who.data.user : undefined);
    if (user) report.userName = str(user.userName) ?? str(user.username) ?? str(user.name) ?? '';
    report.orgId = isRecord(who.org) ? str(who.org.id) : undefined;
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      throw new Error(`Key rejected (HTTP ${e.status})`);
    }
  }

  // 2. billing/credits
  try {
    const cr = await getJson('/alpha/billing/credits', apiKey);
    const credits = isRecord(cr.credits) ? cr.credits : (isRecord(cr.data?.credits) ? cr.data.credits : undefined);
    const wl = isRecord(cr.windowLimits) ? cr.windowLimits : (isRecord(cr.data?.windowLimits) ? cr.data.windowLimits : undefined);

    if (credits) {
      report.monthlyLeft = num(credits.monthlyCredits) ?? num(credits.monthly_credits);
      report.purchased = num(credits.purchasedCredits) ?? num(credits.purchased_credits);
      report.freeCredits = num(credits.freeCredits) ?? num(credits.free_credits);
      report.planIdFallback = str(credits.planId) ?? str(credits.plan_id);
    }
    if (wl) {
      const fh = normalizeWindow(pickWindow(wl, ['fiveHour', 'five_hour', 'rolling5h', '5h']));
      const wk = normalizeWindow(pickWindow(wl, ['weekly', 'week']));
      report.fiveHour = fh;
      report.weekly = wk;
      report.exceeded = str(wl.exceeded) ?? '';
      report.limited = wl.limited === true;
      report.belowThreshold = credits?.belowThreshold === true;
    }
  } catch { /* 非致命 */ }

  // 3. billing/subscriptions
  try {
    const subPath = report.orgId
      ? '/alpha/billing/subscriptions?orgId=' + encodeURIComponent(report.orgId)
      : '/alpha/billing/subscriptions';
    const sub = await getJson(subPath, apiKey);
    const data = isRecord(sub.data) ? sub.data : (isRecord(sub.subscription) ? sub.subscription : undefined);
    const planId = str(data?.planId) ?? str(data?.plan_id) ?? report.planIdFallback;
    if (planId) {
      const info = planInfo(planId);
      report.planId = planId;
      report.planName = info?.name ?? planId;
      report.monthlyCredits = info?.monthlyCredits ?? null;
      report.currentPeriodEnd = toEpochMs(data?.currentPeriodEnd ?? data?.current_period_end) ?? 0;
      report.cancelAtPeriodEnd = data?.cancelAtPeriodEnd === true;
    }
  } catch { /* 非致命 */ }

  // 4. usage/summary
  try {
    const us = await getJson('/alpha/usage/summary', apiKey);
    const u = isRecord(us.data) ? us.data : us;
    if (isRecord(u)) {
      report.usage = {
        totalCount: num(u.totalCount) ?? 0,
        totalCost: num(u.totalCost) ?? 0,
        successRate: num(u.successRate) ?? 0,
        totalTokensIn: num(u.totalTokensIn) ?? 0,
        totalTokensOut: num(u.totalTokensOut) ?? 0,
      };
    }
  } catch { /* 非致命 */ }

  return report;
}

/**
 * 同步单个 CC Key 的额度到数据库
 */
export async function syncCcKey(ccKeyRow) {
  try {
    const report = await fetchKeyReport(ccKeyRow.api_key);
    const fh = report.fiveHour || {};
    const wk = report.weekly || {};

    updateCcKeyQuota(ccKeyRow.id, {
      userName: report.userName || ccKeyRow.user_name,
      planId: report.planId || '',
      planName: report.planName || '',
      monthlyLeft: report.monthlyLeft,
      purchased: report.purchased,
      freeCredits: report.freeCredits,
      fiveHourUsed: fh.used,
      fiveHourCap: fh.cap,
      fiveHourExceeded: fh.exceeded,
      fiveHourReset: fh.resetAt,
      weeklyUsed: wk.used,
      weeklyCap: wk.cap,
      weeklyExceeded: wk.exceeded,
      weeklyReset: wk.resetAt,
      lastError: '',
      status: fh.exceeded || wk.exceeded ? 'exhausted' : 'active',
      detail: JSON.stringify({
        usage: report.usage || null,
        exceeded: report.exceeded || null,
        limited: report.limited || false,
        belowThreshold: report.belowThreshold || false,
        cancelAtPeriodEnd: report.cancelAtPeriodEnd || false,
        currentPeriodEnd: report.currentPeriodEnd || 0,
        monthlyCredits: report.monthlyCredits,
      }),
    });

    return { ok: true };
  } catch (e) {
    updateCcKeyStatus(ccKeyRow.id, 'error', e.message || String(e));
    return { ok: false, error: e.message };
  }
}

/**
 * 同步所有 CC Key
 */
export async function syncAllCcKeys() {
  const keys = listCcKeys();
  const results = await Promise.allSettled(keys.map(k => syncCcKey(k)));
  const ok = results.filter(r => r.status === 'fulfilled' && r.value.ok).length;
  const fail = results.length - ok;
  console.log(`[quota-sync] Synced ${ok}/${results.length} keys (${fail} failed)`);
  return { total: results.length, ok, fail };
}

let syncTimer = null;

/**
 * 启动定期同步
 */
export function startQuotaSync() {
  if (syncTimer) return;

  // 启动后 10 秒执行首次同步
  setTimeout(() => syncAllCcKeys().catch(console.error), 10_000);

  // 定期同步
  syncTimer = setInterval(
    () => syncAllCcKeys().catch(console.error),
    config.quotaRefreshIntervalMs
  );
  console.log(`[quota-sync] Started (interval: ${config.quotaRefreshIntervalMs / 1000}s)`);
}

export function stopQuotaSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
