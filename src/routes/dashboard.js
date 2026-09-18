/**
 * 用户面板路由 — 个人用量统计
 */
import { getUserUsageStats, findApiKeysByUser, startOfDayUTC8 } from '../db/index.js';

export default async function dashboardRoutes(fastify) {
  fastify.addHook('preHandler', fastify.authenticate);

  // GET /api/dashboard — 用户面板数据
  fastify.get('/api/dashboard', async (request) => {
    const userId = request.user.id;
    const now = Date.now();
    const todayStart = startOfDayUTC8(now);

    const today = getUserUsageStats(userId, todayStart);
    const week = getUserUsageStats(userId, now - 7 * 24 * 60 * 60 * 1000);
    const month = getUserUsageStats(userId, now - 30 * 24 * 60 * 60 * 1000);
    const keys = findApiKeysByUser(userId);

    return {
      user: {
        id: request.user.id,
        username: request.user.username,
        role: request.user.role,
      },
      stats: { today, week, month },
      apiKeys: keys,
    };
  });
}
