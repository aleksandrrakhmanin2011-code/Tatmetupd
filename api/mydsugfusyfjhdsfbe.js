import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  // Запрещаем Vercel и браузеру кэшировать этот ответ
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  const cookies = req.headers.cookie || '';
  const passMatch = cookies.match(/auth_pass=([^;]+)/);
  const sidMatch = cookies.match(/auth_sid=([^;]+)/);
  
  if (passMatch && sidMatch) {
    const pass = passMatch[1];
    const sid = sidMatch[1];
    
    try {
      const exists = await redis.exists(`sess:${pass}:${sid}`);
      if (exists === 1) {
        return res.status(200).json({ auth: true });
      }
    } catch (e) {
      console.error('Redis error in me.js:', e);
    }
  }
  
  return res.status(200).json({ auth: false });
}
