// Сервер для Railway (и любого Node-хостинга): раздаёт статику,
// закрывает admin.html паролем (Basic Auth, переменная ADMIN_PASSWORD).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

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

function send(res, code, body, headers) {
  res.writeHead(code, headers);
  res.end(body);
}

function sendFile(res, filePath, code) {
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 500, 'Server error', { 'Content-Type': 'text/plain; charset=utf-8' });
    send(res, code || 200, data, { 'Content-Type': type });
  });
}

function notFound(res) {
  const page = path.join(ROOT, '404.html');
  if (fs.existsSync(page)) return sendFile(res, page, 404);
  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
}

function adminAuthorized(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  return password === ADMIN_PASSWORD;
}

http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  if (urlPath === '/admin') urlPath = '/admin.html';
  if (!path.extname(urlPath)) urlPath += '.html'; // /cases -> /cases.html

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT + path.sep)) return notFound(res); // защита от ../
  if (path.basename(filePath) === 'server.js') return notFound(res);

  if (path.basename(filePath) === 'admin.html') {
    if (!ADMIN_PASSWORD) {
      return send(res, 503,
        '<meta charset="utf-8">Админка закрыта: задайте переменную окружения ADMIN_PASSWORD в настройках хостинга (Railway → Variables).',
        { 'Content-Type': 'text/html; charset=utf-8' });
    }
    if (!adminAuthorized(req)) {
      return send(res, 401, 'Требуется пароль', {
        'Content-Type': 'text/plain; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
      });
    }
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    sendFile(res, filePath);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Site running on port ${PORT}. Admin password ${ADMIN_PASSWORD ? 'is set' : 'NOT set — admin disabled'}.`);
});
