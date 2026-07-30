// Сервер для Railway (и любого Node-хостинга): раздаёт статику,
// закрывает admin.html паролем (Basic Auth, переменная ADMIN_PASSWORD),
// подставляет реальный домен в canonical/og:url/sitemap/robots,
// сжимает ответы (gzip) и ставит заголовки кэширования.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = __dirname;

// Необязательный .env рядом с server.js — для хостингов без панели переменных
// окружения (например, Beget). Реальные env-переменные (Railway) всегда в приоритете.
(function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && !(key in process.env)) process.env[key] = val;
  }
})();

const PORT = process.env.PORT || 8080;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// Заявки: токен бота — только в переменных окружения (Railway → Variables).
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
// Главный получатель заявок; в админке не отображается.
const LEAD_MAIN_ID = process.env.LEAD_MAIN_ID || '933148831';
// Где физически лежит файл админки. На хостингах со статической раздачей файлов
// в обход Node (см. ниже) сюда указывают путь ВНЕ публично отдаваемой папки.
const ADMIN_HTML_PATH = process.env.ADMIN_HTML_PATH || path.join(__dirname, '_admin.html');
// Живые данные сайта (специалисты, кейсы и т.д.), которые правят через админку.
// По тем же причинам, что и ADMIN_HTML_PATH, лучше держать вне публичной папки.
const LIVE_DATA_PATH = process.env.LIVE_DATA_PATH || path.join(__dirname, '.live-data.json');
// Шаблоны страницы специалиста и блога — сервер подставляет в них SEO-теги конкретной
// карточки (title/description/canonical/og/JSON-LD) перед отдачей. На хостингах со
// статической раздачей файлов в обход Node (см. ADMIN_HTML_PATH выше) физического файла
// specialist.html/blog.html в публичной папке быть не должно — иначе запрос до Node
// не доходит и подстановка не срабатывает; путь к «настоящему» файлу — в этих переменных.
const SPECIALIST_HTML_PATH = process.env.SPECIALIST_HTML_PATH || path.join(__dirname, 'specialist.html');
const BLOG_HTML_PATH = process.env.BLOG_HTML_PATH || path.join(__dirname, 'blog.html');
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

// Дополнительные получатели заявок — из живых данных (contacts.leadIds, через запятую),
// а не из data.js: правки в админке должны работать сразу, без пересборки кода.
function extraLeadIds() {
  try {
    const raw = fs.readFileSync(LIVE_DATA_PATH, 'utf8');
    const leadIds = (JSON.parse(raw).contacts || {}).leadIds || '';
    return String(leadIds).split(',').map(s => s.trim()).filter(s => /^\d{5,15}$/.test(s));
  } catch { return []; }
}

// Живые данные сайта целиком — для подстановки SEO-тегов конкретного специалиста/статьи
// и для карты сайта. Если файла ещё нет (новая установка) — просто ничего не подставляем,
// страница отдаётся с обычными заголовками по умолчанию.
function readLiveData() {
  try {
    const j = JSON.parse(fs.readFileSync(LIVE_DATA_PATH, 'utf8'));
    return (j && typeof j === 'object') ? j : null;
  } catch { return null; }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// JSON.stringify экранирует кавычки/бэкслеши сам; здесь дополнительно экранируем "<",
// чтобы содержимое (например, "</script>" внутри текста) не могло разорвать тег скрипта.
function escapeJsonLd(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c');
}

function clamp(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// Точечно подменяет title/canonical/og-теги и описание в уже готовом HTML на значения
// конкретного специалиста/статьи — чтобы соцсети и поисковики видели их без выполнения JS
// (клиентский код тоже это делает, но только после загрузки, а боты соцсетей JS не ждут).
function injectHead(html, seo) {
  if (!seo) return html;
  if (seo.title) html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(seo.title)}</title>`);
  if (seo.url) {
    html = html.replace(/<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${escapeHtml(seo.url)}">`);
    html = html.replace(/<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${escapeHtml(seo.url)}">`);
  }
  if (seo.description) html = html.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${escapeHtml(seo.description)}">`);
  if (seo.ogTitle) html = html.replace(/<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escapeHtml(seo.ogTitle)}">`);
  if (seo.ogDescription) html = html.replace(/<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escapeHtml(seo.ogDescription)}">`);
  if (seo.ld) html = html.replace('<!--SEO_JSONLD-->', `<script type="application/ld+json">${escapeJsonLd(seo.ld)}</script>`);
  return html;
}

function buildSpecialistSeo(s, categories, origin) {
  const cat = (categories || []).find(c => c.slug === s.cat);
  const catName = cat ? cat.name : '';
  const title = clamp(`${s.name} — ${s.role} | Хорошее решение`, 90);
  const description = clamp(`${s.name}${catName ? ' (' + catName + (s.exp ? ', опыт ' + s.exp : '') + ')' : ''} — профиль, портфолио и видео работ. Бронирование напрямую, ${s.price || 'цена по запросу'}, без агентской наценки.`, 200);
  const url = `${origin}/specialist.html?id=${encodeURIComponent(s.id)}`;
  return {
    title, description, url,
    ogTitle: clamp(`${s.name} — ${s.role}`, 90),
    ogDescription: description,
    ld: {
      '@context': 'https://schema.org', '@type': 'Person', name: s.name, jobTitle: s.role,
      description: s.about || undefined,
      memberOf: { '@type': 'Organization', name: 'Объединение ивент-специалистов «Хорошее решение»' },
      url,
    },
  };
}

function buildArticleSeo(a, origin) {
  const title = clamp(`${a.title} — Блог «Хорошее решение»`, 90);
  const description = clamp(a.lead || a.title, 200);
  const url = `${origin}/blog.html?post=${encodeURIComponent(a.slug)}`;
  return {
    title, description, url,
    ogTitle: clamp(a.title, 90),
    ogDescription: description,
    ld: {
      '@context': 'https://schema.org', '@type': 'BlogPosting', headline: a.title,
      datePublished: a.date, description: a.lead,
      author: { '@type': 'Organization', name: 'Хорошее решение' },
      url,
    },
  };
}

function servePageWithSeo(req, res, filePath, seo) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return notFound(req, res);
    if (seo) html = injectHead(html, seo);
    send(req, res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
}

// Отдаём безусловно (с id и без) — не только чтобы подставить SEO-теги, но и чтобы
// путь гарантированно шёл через Node, а не через возможную статическую раздачу файла.
function serveSpecialistPage(req, res, id) {
  const d = readLiveData();
  const s = id && d && Array.isArray(d.specialists) ? d.specialists.find(x => x.id === id) : null;
  const seo = s ? buildSpecialistSeo(s, d.categories, requestOrigin(req) || 'https://eventspecialists.ru') : null;
  servePageWithSeo(req, res, SPECIALIST_HTML_PATH, seo);
}

function serveArticlePage(req, res, slug) {
  const d = readLiveData();
  const a = slug && d && Array.isArray(d.articles) ? d.articles.find(x => x.slug === slug) : null;
  const seo = a ? buildArticleSeo(a, requestOrigin(req) || 'https://eventspecialists.ru') : null;
  servePageWithSeo(req, res, BLOG_HTML_PATH, seo);
}

// Карта сайта собирается на лету: базовые страницы + каждый специалист и каждая статья
// блога из живых данных — так новые карточки из админки сами попадают в sitemap.
function serveSitemap(req, res) {
  const origin = requestOrigin(req) || 'https://eventspecialists.ru';
  const d = readLiveData();
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: origin + '/', priority: '1.0' },
    { loc: origin + '/specialists.html', priority: '0.9' },
    { loc: origin + '/cases.html', priority: '0.8' },
    { loc: origin + '/blog.html', priority: '0.7' },
  ];
  if (d && Array.isArray(d.specialists)) d.specialists.forEach(s => urls.push({ loc: origin + '/specialist.html?id=' + encodeURIComponent(s.id), priority: '0.6' }));
  if (d && Array.isArray(d.articles)) d.articles.forEach(a => urls.push({ loc: origin + '/blog.html?post=' + encodeURIComponent(a.slug), priority: '0.6' }));
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(u => `  <url><loc>${escapeHtml(u.loc)}</loc><lastmod>${today}</lastmod><priority>${u.priority}</priority></url>`).join('\n')
    + '\n</urlset>\n';
  send(req, res, 200, body, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
}

// Читает тело запроса целиком, обрывая соединение при превышении лимита.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooBig = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) { tooBig = true; req.destroy(); }
    });
    req.on('end', () => { if (!tooBig) resolve(body); });
    req.on('error', reject);
    req.on('close', () => { if (tooBig) reject(new Error('too-large')); });
  });
}

// Живые данные сайта: GET отдаёт всем (то же самое, что раньше было в data.js
// через localStorage), POST — только с паролем админки, пишет атомарно (через
// временный файл + переименование), чтобы не повредить файл при обрыве записи.
async function handleData(req, res) {
  if (req.method === 'GET') {
    fs.readFile(LIVE_DATA_PATH, 'utf8', (err, data) => {
      if (err) return send(req, res, 200, '{}', { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
      send(req, res, 200, data, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    });
    return;
  }
  if (req.method !== 'POST') return send(req, res, 405, '{"ok":false}', { 'Content-Type': 'application/json' });
  if (!ADMIN_PASSWORD || !adminAuthorized(req)) {
    return send(req, res, 401, '{"ok":false,"reason":"unauthorized"}', {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
    });
  }
  try {
    const body = await readBody(req, 20 * 1024 * 1024); // до 20 МБ — с запасом на фото
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad-shape');
    const tmpPath = LIVE_DATA_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(parsed));
    fs.renameSync(tmpPath, LIVE_DATA_PATH);
    return send(req, res, 200, '{"ok":true}', { 'Content-Type': 'application/json' });
  } catch (e) {
    return send(req, res, 400, '{"ok":false,"reason":"bad-body"}', { 'Content-Type': 'application/json' });
  }
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
  let urlObj, urlPath;
  try {
    urlObj = new URL(req.url, 'http://x');
    urlPath = decodeURIComponent(urlObj.pathname);
  } catch {
    return send(req, res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' });
  }

  if (urlPath === '/api/lead') return handleLead(req, res);
  if (urlPath === '/api/data') return handleData(req, res);
  if (urlPath === '/sitemap.xml') return serveSitemap(req, res);

  // Дубли главной склеиваем 301-редиректом на «/» — для SEO
  if (urlPath === '/index.html' || urlPath === '/index') {
    res.writeHead(301, { Location: '/' });
    return res.end();
  }

  // Профиль специалиста / статья блога — всегда через Node (см. SPECIALIST_HTML_PATH/
  // BLOG_HTML_PATH выше), с id/post подставляем title/description/canonical/og-теги
  // конкретной карточки (см. injectHead), чтобы соцсети и поисковики видели их без JS.
  if (urlPath === '/specialist.html' || urlPath === '/specialist') {
    return serveSpecialistPage(req, res, urlObj.searchParams.get('id'));
  }
  if (urlPath === '/blog.html' || urlPath === '/blog') {
    return serveArticlePage(req, res, urlObj.searchParams.get('post'));
  }
  // На некоторых хостингах (например, Beget) файлы, физически лежащие в отдаваемой
  // папке, веб-сервер может отдать напрямую в обход Node — а значит, и в обход проверки
  // пароля. Поэтому реальный файл админки может физически лежать ВНЕ этой папки
  // (путь — в ADMIN_HTML_PATH), и запрос на /admin.html гарантированно идёт через наш код.
  if (urlPath === '/admin' || urlPath === '/admin.html') {
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
    return fs.stat(ADMIN_HTML_PATH, (err, st) => {
      if (err || !st.isFile()) return notFound(req, res);
      sendFile(req, res, ADMIN_HTML_PATH);
    });
  }

  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  if (!path.extname(urlPath)) urlPath += '.html'; // /cases -> /cases.html

  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT + path.sep)) return notFound(req, res); // защита от ../
  const forbidden = new Set(['server.js', '_admin.html', '.live-data.json', '.env']);
  if (forbidden.has(path.basename(filePath))) return notFound(req, res);

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    sendFile(req, res, filePath);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Site running on port ${PORT}. Admin password ${ADMIN_PASSWORD ? 'is set' : 'NOT set — admin disabled'}.`);
});
