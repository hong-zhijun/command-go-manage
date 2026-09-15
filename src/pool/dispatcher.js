/**
 * CC Key 池调度器
 *
 * 策略：Sticky 粘性路由 + 额度感知 × 权重 + 并发上限
 *
 * 1. 如果调用方有 stickyHint（通常是 API Key ID），优先复用上次分配的 CC Key
 * 2. 粘性 key 不可用时（超限/异常/并发满），回退到正常调度
 * 3. 正常调度：
 *    a. 过滤掉非 active 的 key
 *    b. 过滤掉 5 小时窗口 exceeded 的
 *    c. 过滤掉已达 max_concurrent 上限的（0 = 不限）
 *    d. 按「(剩余容量 / (在途请求数 + 1)) × 权重」打分
 *    e. 选得分最高的
 * 4. 分配后记录粘性映射，下次优先复用
 */
import { listActiveCcKeys, updateCcKeyInflight } from '../db/index.js';

// ── Sticky 映射：stickyHint → ccKeyId ──
const stickyMap = new Map();
const STICKY_TTL_MS = 30 * 60 * 1000; // 30 分钟不活跃就过期

// 每 10 分钟清理过期粘性
setInterval(() => {
  const now = Date.now();
  for (const [hint, entry] of stickyMap) {
    if (now - entry.ts > STICKY_TTL_MS) stickyMap.delete(hint);
  }
}, 10 * 60 * 1000);

/**
 * 判断一个 CC Key 是否当前可用
 */
function isKeyAvailable(k) {
  if (k.status !== 'active') return false;
  // 5 小时窗口超限
  if (k.five_hour_exceeded) {
    if (!(k.five_hour_reset > 0 && Date.now() > k.five_hour_reset)) return false;
  }
  if (k.five_hour_cap > 0 && k.five_hour_used >= k.five_hour_cap) return false;
  // 并发上限
  if (k.max_concurrent > 0 && (k.current_inflight || 0) >= k.max_concurrent) return false;
  return true;
}

/**
 * 从 CC Key 池中选一个最优 Key
 * @param {string|number} [stickyHint] - 粘性标识（通常是用户的 apiKeyId），相同 hint 尽量复用同一个 CC Key
 * @returns {{ id, api_key, label, priority, max_concurrent, timezone_override } | null}
 */
export function pickCcKey(stickyHint) {
  const keys = listActiveCcKeys();
  if (keys.length === 0) return null;

  // ── 1. Sticky 优先 ──
  if (stickyHint != null) {
    const sticky = stickyMap.get(stickyHint);
    if (sticky) {
      const stickyKey = keys.find(k => k.id === sticky.ccKeyId);
      if (stickyKey && isKeyAvailable(stickyKey)) {
        sticky.ts = Date.now(); // 续期
        return stickyKey;
      }
      // 粘性 key 不可用了，清除映射，走正常调度
      stickyMap.delete(stickyHint);
    }
  }

  // ── 2. 正常调度 ──
  let available = keys.filter(isKeyAvailable);

  // 如果所有 key 都不可用，从全部 active 中选（至少别返回 null）
  const pool = available.length > 0 ? available : keys;

  // 打分：(剩余容量 / (在途数 + 1)) × 权重
  let bestKey = null;
  let bestScore = -Infinity;

  for (const k of pool) {
    const remaining = Math.max(0, (k.five_hour_cap || 100) - (k.five_hour_used || 0));
    const inflight = k.current_inflight || 0;
    const weight = k.priority || 10;
    const score = (remaining / (inflight + 1)) * weight;

    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }

  // ── 3. 记录粘性 ──
  if (bestKey && stickyHint != null) {
    stickyMap.set(stickyHint, { ccKeyId: bestKey.id, ts: Date.now() });
  }

  return bestKey;
}

/**
 * 开始使用一个 CC Key（在途 +1）
 */
export function acquireCcKey(ccKeyId) {
  updateCcKeyInflight(ccKeyId, 1);
}

/**
 * 释放一个 CC Key（在途 -1）
 */
export function releaseCcKey(ccKeyId) {
  updateCcKeyInflight(ccKeyId, -1);
}
