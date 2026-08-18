// Прокси Blitzortung Data API для слоя молний (грозопеленгатор).
//
// ПОЛИТИКА BLITZORTUNG: сторонние приложения обязаны раздавать данные своим клиентам
// ЧЕРЕЗ СВОЙ СЕРВЕР — клиент сайта НИКОГДА не ходит на data.blitzortung.org напрямую.
// Этот прокси — ровно такое решение (+ edge-кэш Vercel снижает нагрузку на их API).
//
// ДОСТУП (бесплатно для некоммерческого использования):
//   1. Регистрация на blitzortung.org → заявка на Data Access (обычно одобряют).
//   2. Полученные логин/пароль задать в env: BLITZORTUNG_USER / BLITZORTUNG_PASS
//      (Vercel: Settings → Environment Variables; локально: .env из .env.example).
//   3. До выдачи доступа этот эндпоинт честно возвращает 503/401 — сайт покажет
//      «⚡ недоступно», ничего не сломается.

const UPSTREAM = 'https://data.blitzortung.org/Data/Protected/strikes.json';
const TIMEOUT_MS = 12000;

export default async function handler(req, res) {
  const user = process.env.BLITZORTUNG_USER || '';
  const pass = process.env.BLITZORTUNG_PASS || '';
  res.setHeader('Access-Control-Allow-Origin', '*'); // свой домен; заголовок — подстраховка

  if (!user || !pass) {
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({ error: 'BLITZORTUNG_USER/PASS не заданы на сервере' }));
  }

  // Параметры: bbox видимой области (клиент расширяет на ~15%) + окно времени
  const q = new URL(req.url, 'http://x').searchParams;
  const minLat = parseFloat(q.get('minLat')), maxLat = parseFloat(q.get('maxLat'));
  const minLon = parseFloat(q.get('minLon')), maxLon = parseFloat(q.get('maxLon'));
  const minutes = Math.max(5, Math.min(120, parseInt(q.get('minutes')) || 30));
  const hasBbox = [minLat, maxLat, minLon, maxLon].every(Number.isFinite);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const upstream = await fetch(UPSTREAM, {
      signal: ctrl.signal,
      headers: {
        // Не притворяемся браузером — честный идентификатор приложения
        'User-Agent': 'tatmeteo-lightning/1.0',
        'Accept': 'application/json',
        'Authorization': 'Basic ' + Buffer.from(user + ':' + pass).toString('base64')
      }
    });
    clearTimeout(timer);

    if (upstream.status === 401 || upstream.status === 403) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ error: 'Blitzortung: доступ не оформлен (HTTP ' + upstream.status + ')' }));
    }
    if (!upstream.ok) {
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ error: 'Blitzortung upstream: HTTP ' + upstream.status }));
    }

    const data = await upstream.json();
    // Формат: массив ударов, первое поле — unix-время (сек; страхуемся от мс/нс),
    // далее lat, lon. Фильтруем по окну времени и bbox — клиенту летит минимум.
    const raw = Array.isArray(data) ? data : (Array.isArray(data.strikes) ? data.strikes : []);
    const now = Date.now() / 1000;
    const since = now - minutes * 60;
    const strikes = [];
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      if (!Array.isArray(s) || s.length < 3) continue;
      let t = +s[0];
      if (t > 1e15) t = t / 1e9;      // наносекунды
      else if (t > 1e12) t = t / 1e3; // миллисекунды
      const lat = +s[1], lon = +s[2];
      if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (t < since) continue;
      if (hasBbox && (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon)) continue;
      strikes.push([+lat.toFixed(4), +lon.toFixed(4), Math.round(t)]);
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    // Real-time, но 30с edge-кэша достаточно (poll клиента — 20с) и бережёт upstream
    res.setHeader('Cache-Control', 'public, s-maxage=30, stale-while-revalidate=60');
    res.end(JSON.stringify({ strikes: strikes, count: strikes.length, fetched_at: Math.round(now) }));
  } catch (e) {
    clearTimeout(timer);
    res.statusCode = 502;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ error: e.name === 'AbortError' ? 'Blitzortung: тайм-аут' : ('Сеть: ' + e.message) }));
  }
}
