import { Redis } from '@upstash/redis';
import fs from 'fs';
import path from 'path';
import { parse } from 'url';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  // 1. Проверка авторизации по Redis
  const cookies = req.headers.cookie || '';
  const passMatch = cookies.match(/auth_pass=([^;]+)/);
  const sidMatch = cookies.match(/auth_sid=([^;]+)/);

  let isAuth = false;
  if (passMatch && sidMatch) {
    try {
      const exists = await redis.exists(`sess:${passMatch[1]}:${sidMatch[1]}`);
      if (exists === 1) isAuth = true;
    } catch (e) {
      console.error('Redis error:', e);
    }
  }

  // Если не авторизован — выкидываем на страницу входа
    if (!isAuth) {
    res.writeHead(302, { 
      Location: '/login.html',
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end();
    return;
  }

  // 2. Надежное извлечение пути к файлу
  const parsedUrl = parse(req.url, true);
  let reqPath = parsedUrl.query.path || '';
  
  // Если путь пустой (зашли на главную) — отдаем index.html
  if (!reqPath || reqPath === '/') {
    reqPath = 'index.html';
  }
  
  reqPath = decodeURIComponent(reqPath);
  // Убираем слеши в начале и защищаемся от выхода за пределы папки
  reqPath = reqPath.replace(/^\/+/, '').replace(/\.\.\//g, '');

  const filePath = path.join(process.cwd(), 'protected', reqPath);
  
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.status(404).send('404: File Not Found');
      return;
    }

    // 3. Отдаем файл с правильными заголовками
    const ext = path.extname(filePath);
    let contentType = 'text/html; charset=utf-8';
    if (ext === '.js') contentType = 'text/javascript; charset=utf-8';
    else if (ext === '.css') contentType = 'text/css; charset=utf-8';
    else if (ext === '.png') contentType = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';

    const fileContent = fs.readFileSync(filePath);
        res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.status(200).send(fileContent);
  } catch (e) {
    console.error('Serve Error:', e);
    res.status(500).send('Internal Server Error');
  }
}
