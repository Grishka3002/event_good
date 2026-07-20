// Сервер для Railway (и любого Node-хостинга): раздаёт статику,
// закрывает admin.html паролем (Basic Auth, переменная ADMIN_PASSWORD),
// подставляет реальный домен в canonical/og:url/sitemap/robots,
// сжимает ответы (gzip) и ставит заголовки кэширования.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Заявки: токен бота — только в переменных окружения (Railway → Variables).
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
// Главный получатель заявок; в админке не отображается.
const LEAD_MAIN_ID = process.env.LEAD_MAIN_ID || '933148831';
// Базовый адрес, зашитый в исходниках; на лету заменяется на реальный домен запроса.
const BASE_PLACEHOLDER = 'https://grishka3002.github.io/event_good';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};
const TEXT_EXT = new Set(['.html', '.js', '.css', '.svg', '.xml', '.txt', '.json']);
const REWRITE_EXT = new Set(['.html', '.xml', '.txt']);

function send(req, res, code, body, headers) {
  headers = headers || {};
  if (typeof body === 'string') body = Buffer.from(body, 'utf8');
  const accepts = (req.headers['accept-encoding'] || '').includes('gzip');
  if (accepts && body.length > 512) {
    body = zlib.gzipSync(body);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Vary'] = 'Accept-Encoding';
  headers['Content-Length'] = body.length;
  res.writeHead(code, headers);
  res.end(body);
}

function requestOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto.split(',')[0].trim()}://${host.split(',')[0].trim()}`;
}

function sendFile(req, res, filePath, code) {
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) return send(req, res, 500, 'Server error', { 'Content-Type': 'text/plain; charset=utf-8' });
    if (REWRITE_EXT.has(ext)) {
      const origin = requestOrigin(req);
      if (origin) data = Buffer.from(data.toString('utf8').split(BASE_PLACEHOLDER).join(origin), 'utf8');
    }
    const cache = TEXT_EXT.has(ext) && ext !== '.svg'
      ? 'no-cache'                      // html/js/xml/txt — всегда свежие после деплоя
      : 'public, max-age=86400';        // картинки, шрифты, favicon — сутки
    send(req, res, code || 200, data, { 'Content-Type': type, 'Cache-Control': cache });
  });
}

function notFound(req, res) {
  const page = path.join(ROOT, '404.html');
  if (fs.existsSync(page)) return sendFile(req, res, page, 404);
  send(req, res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

function adminAuthorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return password === ADMIN_PASSWORD;
}

// Дополнительные получатели заявок — из data.js (contacts.leadIds, через запятую).
function extraLeadIds() {
  try {
    const src = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
    const m = src.match(/leadIds:\s*'([^']*)'/);
    if (!m) return [];
    return m[1].split(',').map(s => s.trim()).filter(s => /^\d{5,15}$/.test(s));
  } catch { return []; }
}

async function tgSend(chatId, text) {
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const j = await r.json().catch(() => ({}));
  return !!j.ok;
}

// Простейшая защита от спама: не более 5 заявок с одного IP за 10 минут.
const leadLog = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (leadLog.get(ip) || []).filter(t => now - t < 600000);
  if (arr.length >= 5) return true;
  arr.push(now);
  leadLog.set(ip, arr);
  if (leadLog.size > 5000) leadLog.clear();
  return false;
}

function handleLead(req, res) {
  if (req.method !== 'POST') return send(req, res, 405, '{"ok":false}', { 'Content-Type': 'application/json' });
  if (!TG_BOT_TOKEN) return send(req, res, 503, '{"ok":false,"reason":"no-token"}', { 'Content-Type': 'application/json' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rateLimited(ip)) return send(req, res, 429, '{"ok":false,"reason":"rate-limit"}', { 'Content-Type': 'application/json' });

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 8192) { req.destroy(); }
  });
  req.on('end', async () => {
    let text;
    try { text = String(JSON.parse(body).text || '').trim(); } catch { text = ''; }
    if (!text || text.length > 3500) return send(req, res, 400, '{"ok":false,"reason":"bad-text"}', { 'Content-Type': 'application/json' });
    try {
      const okMain = await tgSend(LEAD_MAIN_ID, text);
      for (const id of extraLeadIds()) {
        if (id !== LEAD_MAIN_ID) await tgSend(id, text).catch(() => {});
      }
      if (okMain) return send(req, res, 200, '{"ok":true}', { 'Content-Type': 'application/json' });
      return send(req, res, 502, '{"ok":false,"reason":"tg-failed"}', { 'Content-Type': 'application/json' });
    } catch {
      return send(req, res, 502, '{"ok":false,"reason":"tg-error"}', { 'Content-Type': 'application/json' });
    }
  });
}

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(req, res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (urlPath === '/api/lead') return handleLead(req, res);

  // Дубли главной склеиваем 301-редиректом на «/» — для SEO
  if (urlPath === '/index.html' || urlPath === '/index') {
    res.writeHead(301, { Location: '/' });
    return res.end();
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  if (!path.extname(urlPath)) urlPath += '.html'; // /cases -> /cases.html

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT + path.sep)) return notFound(req, res); // защита от ../
  if (path.basename(filePath) === 'server.js') return notFound(req, res);

  if (path.basename(filePath) === 'admin.html') {
    if (!ADMIN_PASSWORD) {
      return send(req, res, 503,
        '<meta charset="utf-8">Админка закрыта: задайте переменную окружения ADMIN_PASSWORD в настройках хостинга (Railway → Variables).',
        { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (!adminAuthorized(req)) {
      return send(req, res, 401, 'Требуется пароль', {
        'Content-Type': 'text/plain; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
      });
    }
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    sendFile(req, res, filePath);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Site running on port ${PORT}. Admin password ${ADMIN_PASSWORD ? 'is set' : 'NOT set — admin disabled'}.`);
});
