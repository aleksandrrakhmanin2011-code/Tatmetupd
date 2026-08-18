// Прокси WMS-тайлов EUMETSAT через Vercel.
// Зачем: view.eumetsat.int медленный/нестабильный из РФ; серверы Vercel — вне РФ,
// клиент ходит на свой домен (нет CORS-проблем), а CDN Vercel кэширует тайлы на edge.
// Функция намеренно НЕ трогает существующие api/* и их rewrites.

const UPSTREAM = 'https://view.eumetsat.int/geoserver/wms';
const TIMEOUT_MS = 12000;

export default async function handler(req, res) {
  // Пробрасываем query-строку 1:1 (bbox, layers, time, width, height, crs, ...)
  const qIdx = req.url.indexOf('?');
  const qs = qIdx >= 0 ? req.url.slice(qIdx + 1) : '';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(UPSTREAM + (qs ? '?' + qs : ''), {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'tatmeteo-proxy/1.0' }
    });
    clearTimeout(timer);

    if (!upstream.ok) {
      // Ошибку EUMETSAT не ретраим на сервере — retry уже есть на клиенте
      res.statusCode = 502;
      res.setHeader('Content-Type', 'text/plain');
      res.setHeader('Cache-Control', 'no-store');
      res.end('EUMETSAT upstream error: HTTP ' + upstream.status);
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    const hasTime = /(^|&)time=/i.test(qs);

    res.statusCode = 200;
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'image/png');
    // Исторические тайлы (time= задан) неизменяемы — кэшируем на CDN сутки;
    // LIVE-тайлы — 5 минут на edge, минута в браузере
    res.setHeader('Cache-Control', hasTime
      ? 'public, max-age=3600, s-maxage=86400, immutable'
      : 'public, max-age=60, s-maxage=300');
    res.setHeader('Access-Control-Allow-Origin', '*'); // подстраховка
    res.end(buf);
  } catch (e) {
    clearTimeout(timer);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    res.end('Satellite proxy error: ' + (e.name === 'AbortError' ? 'upstream timeout' : e.message));
  }
}
