import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  const action = req.query.action;
  const cookies = req.headers.cookie || '';
  const adminCookieMatch = cookies.match(/admin_sess=([^;]+)/);
  const adminSess = adminCookieMatch ? adminCookieMatch[1] : null;

  // ─── АВТОРИЗАЦИЯ ОТКЛЮЧЕНА ───
  // Любой запрос считается авторизованным
  let isAuthorized = true;

  // Если есть сессия — поддерживаем её, но не требуем
  if (adminSess) {
    const exists = await redis.get(`admin_sess:${adminSess}`);
    if (exists) isAuthorized = true;
  }

  // Для входа всегда возвращаем успех (если вызван)
  if (req.method === 'POST' && action === 'admin_login') {
    return res.json({ success: true });
  }

  // Все остальные запросы пропускаем без проверки
  try {
    if (req.method === 'GET') {
      const passwords = await redis.smembers('passwords');
      const logs = await redis.lrange('logs', 0, 19);

      const passStatus = [];
      for (const p of passwords) {
        const keys = await redis.keys(`sess:${p}:*`);
        let ips = [];
        for (const k of keys) {
          const ip = await redis.get(k);
          if (ip) ips.push(ip);
        }
        passStatus.push({ password: p, activeDevices: keys.length, ips: ips.join(', ') });
      }

      return res.json({ passwords: passStatus, logs });
    }

    if (req.method === 'POST') {
      const getBody = () => new Promise((resolve) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
      });
      const body = await getBody();
      const { action: postAction, password } = body;

      if (postAction === 'generate') {
        const newPass = Math.random().toString(36).slice(2, 10);
        await redis.sadd('passwords', newPass);
        return res.json({ success: true, password: newPass });
      }

      if (postAction === 'delete') {
        if (!password) return res.status(400).json({ error: 'Не указан пароль' });
        await redis.srem('passwords', password);
        await redis.del(`device:${password}`);
        const keys = await redis.keys(`sess:${password}:*`);
        if (keys.length > 0) await redis.del(...keys);
        return res.json({ success: true });
      }
    }

    return res.status(404).json({ error: 'Not found' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
