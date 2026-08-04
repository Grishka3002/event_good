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
// Загруженные фото специалистов — обычные файлы на диске, а не base64 внутри /api/data
// (как раньше): каждое фото весило ~200КБ и раздувало JSON, который целиком грузила
// каждая страница сайта. Держим вне публичной папки по той же причине, что и выше —
// иначе на хостингах со статической раздачей файлов в обход Node (см. ADMIN_HTML_PATH)
// удаление/подмену файла мимо пароля админки было бы не проконтролировать; отдаём их
// сами через /uploads/… (см. ниже).
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(__dirname, 'uploads'));
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

// Превью для ссылок на видео (YouTube — напрямую по предсказуемому адресу картинки,
// Vimeo/Rutube — через их официальный oEmbed; у VK публичного oEmbed нет, поэтому для
// vk.com превью не получить — ссылка всё равно сохранится, просто без картинки).
// Запрос идёт с сервера (не из браузера), поэтому CORS не мешает; ответы кэшируем
// в памяти на сутки, чтобы не дёргать чужой API на каждое открытие админки.
const VIDEO_THUMB_TTL = 24 * 60 * 60 * 1000;
const videoThumbCache = new Map();

function oembedUrlFor(videoUrl) {
  let host;
  try { host = new URL(videoUrl).hostname.replace(/^www\./, ''); } catch { return null; }
  const u = encodeURIComponent(videoUrl);
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') return 'https://www.youtube.com/oembed?format=json&url=' + u;
  if (host === 'vimeo.com') return 'https://vimeo.com/api/oembed.json?url=' + u;
  if (host === 'rutube.ru') return 'https://rutube.ru/api/oembed/?format=json&url=' + u;
  return null;
}

async function resolveVideoThumb(videoUrl) {
  const cached = videoThumbCache.get(videoUrl);
  if (cached && Date.now() - cached.ts < VIDEO_THUMB_TTL) return cached.thumb;
  const endpoint = oembedUrlFor(videoUrl);
  let thumb = null;
  if (endpoint) {
    try {
      const r = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
      if (r.ok) {
        const j = await r.json();
        thumb = (j && j.thumbnail_url) || null;
      }
    } catch { /* провайдер недоступен/не поддерживает — просто без превью */ }
  }
  videoThumbCache.set(videoUrl, { thumb, ts: Date.now() });
  if (videoThumbCache.size > 3000) videoThumbCache.clear();
  return thumb;
}

async function handleVideoThumb(req, res, videoUrl) {
  if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) {
    return send(req, res, 400, '{"ok":false}', { 'Content-Type': 'application/json' });
  }
  const thumb = await resolveVideoThumb(videoUrl);
  send(req, res, 200, JSON.stringify({ ok: !!thumb, thumb }), { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
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

// Слияние списков (специалисты, кейсы, отзывы…) по id/slug вместо перезаписи целиком —
// так два человека, редактирующие РАЗНЫЕ карточки одновременно, не затирают друг друга.
// base — то, что редактор загрузил в начале своей сессии; data — его текущая версия;
// current — то, что на сервере прямо сейчас (могло уже поменяться из-за другого человека).
// Элемент считается «изменённым мной», если он отличается от base — тогда моя версия
// побеждает; если я его не трогал — беру то, что сейчас на сервере (чужие правки не теряю).
// Если оба одновременно поменяли ОДИН И ТОТ ЖЕ элемент — выигрывает тот, чьё сохранение
// дошло до сервера последним (только для этого элемента, не для всех данных сайта).
function mergeArrayByKey(base, data, current, key) {
  base = Array.isArray(base) ? base : [];
  data = Array.isArray(data) ? data : [];
  current = Array.isArray(current) ? current : [];
  const baseMap = new Map(base.map(x => [x[key], x]));
  const currentMap = new Map(current.map(x => [x[key], x]));
  const result = [];
  const seen = new Set();
  for (const item of data) {
    const id = item[key];
    seen.add(id);
    const baseItem = baseMap.get(id);
    const changedByMe = !baseItem || JSON.stringify(baseItem) !== JSON.stringify(item);
    if (changedByMe) { result.push(item); continue; }
    if (currentMap.has(id)) { result.push(currentMap.get(id)); continue; }
    // не трогал, а на сервере элемент к этому моменту удалили — не восстанавливаем
  }
  for (const item of current) {
    const id = item[key];
    if (seen.has(id)) continue;
    const deletedByMe = baseMap.has(id); // был у меня при загрузке, но я его убрал из data
    if (!deletedByMe) result.push(item); // не знал о нём — значит, добавлен кем-то другим
  }
  return result;
}

// То же самое для объекта «по полям» (contacts): каждое поле — отдельная единица слияния.
function mergeObjectByKeys(base, data, current) {
  base = base && typeof base === 'object' ? base : {};
  data = data && typeof data === 'object' ? data : {};
  current = current && typeof current === 'object' ? current : {};
  const result = { ...current };
  for (const key of Object.keys(data)) {
    if (JSON.stringify(base[key]) !== JSON.stringify(data[key])) result[key] = data[key];
  }
  return result;
}

const ARRAY_FIELDS_BY_KEY = {
  specialists: 'id', cases: 'id', reviews: 'id', videos: 'id',
  calcServices: 'id', articles: 'id', packages: 'id', mediaCats: 'id', categories: 'slug',
};

function mergeLiveData(base, data, current) {
  base = base && typeof base === 'object' ? base : {};
  data = data && typeof data === 'object' ? data : {};
  current = current && typeof current === 'object' ? current : {};
  const result = { ...current, ...data }; // на случай полей, которых сервер ещё не знает
  for (const [field, key] of Object.entries(ARRAY_FIELDS_BY_KEY)) {
    if (data[field] || current[field] || base[field]) {
      result[field] = mergeArrayByKey(base[field], data[field], current[field], key);
    }
  }
  result.contacts = mergeObjectByKeys(base.contacts, data.contacts, current.contacts);
  return result;
}

// Живые данные сайта: GET отдаёт всем (то же самое, что раньше было в data.js через
// localStorage). POST — только с паролем админки; обычный режим — «merge» (см. выше,
// так оба админа могут одновременно править разные карточки без потери чужих правок),
// «overwrite» — принудительная полная замена (используется только для импорта/сброса
// в админке, где так и задумано — заменить всё содержимое целиком). Пишет атомарно
// (через временный файл + переименование), чтобы не повредить файл при обрыве записи;
// чтение current и запись — синхронные, без await между ними, поэтому два одновременных
// сохранения не могут «пересечься» на середине (Node однопоточный).
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
    // Совместимость со старой вкладкой админки, открытой ещё до обновления сервера (у неё
    // в памяти старый JS, который шлёт данные сайта прямо телом запроса, без обёртки
    // {mode,data}) — иначе после каждого такого обновления сервера её сохранения ловили бы
    // 400 и человек видел бы «не сохранилось», не понимая, что просто нужно обновить страницу.
    const isLegacyPayload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && !('data' in parsed) && ('specialists' in parsed || 'contacts' in parsed);
    const incoming = isLegacyPayload ? parsed : (parsed && parsed.data);
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('bad-shape');
    let merged;
    if (isLegacyPayload || parsed.mode === 'overwrite') {
      merged = incoming;
    } else {
      let current = {};
      try { current = JSON.parse(fs.readFileSync(LIVE_DATA_PATH, 'utf8')); } catch { /* первое сохранение — файла ещё нет */ }
      merged = mergeLiveData(parsed.base, incoming, current);
    }
    const tmpPath = LIVE_DATA_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(merged));
    fs.renameSync(tmpPath, LIVE_DATA_PATH);
    return send(req, res, 200, JSON.stringify({ ok: true, data: merged }), { 'Content-Type': 'application/json' });
  } catch (e) {
    return send(req, res, 400, '{"ok":false,"reason":"bad-body"}', { 'Content-Type': 'application/json' });
  }
}

const IMAGE_EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

// Имя файла из /uploads/<name> — только базовое имя, без переходов по каталогам.
function safeUploadPath(name) {
  const base = path.basename(String(name || ''));
  if (!base || base === '.' || base === '..') return null;
  const full = path.join(UPLOADS_DIR, base);
  if (!full.startsWith(UPLOADS_DIR + path.sep)) return null;
  return full;
}

// Принимает то же самое, что раньше клали прямо в s.photo (data:image/...;base64,...),
// но теперь сохраняет как файл и отдаёт короткую ссылку — её и кладут в s.photo.
async function handleUploadPhoto(req, res) {
  if (req.method !== 'POST') return send(req, res, 405, '{"ok":false}', { 'Content-Type': 'application/json' });
  if (!ADMIN_PASSWORD || !adminAuthorized(req)) {
    return send(req, res, 401, '{"ok":false,"reason":"unauthorized"}', {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
    });
  }
  try {
    const body = await readBody(req, 8 * 1024 * 1024); // сжатое на клиенте фото — с большим запасом
    const parsed = JSON.parse(body);
    const m = /^data:(image\/[a-z0-9+.-]+);base64,(.+)$/i.exec(String(parsed.dataUrl || ''));
    if (!m) throw new Error('bad-data-url');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length || buf.length > 6 * 1024 * 1024) throw new Error('bad-size');
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    const ext = IMAGE_EXT_BY_MIME[m[1].toLowerCase()] || '.jpg';
    const name = 'p' + Date.now() + Math.random().toString(36).slice(2, 8) + ext;
    fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
    return send(req, res, 200, JSON.stringify({ ok: true, url: '/uploads/' + name }), { 'Content-Type': 'application/json' });
  } catch (e) {
    return send(req, res, 400, '{"ok":false}', { 'Content-Type': 'application/json' });
  }
}

// Чистит файл при замене/удалении фото в админке — некритично, если файла уже нет.
async function handleDeletePhoto(req, res) {
  if (req.method !== 'POST') return send(req, res, 405, '{"ok":false}', { 'Content-Type': 'application/json' });
  if (!ADMIN_PASSWORD || !adminAuthorized(req)) {
    return send(req, res, 401, '{"ok":false,"reason":"unauthorized"}', {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
    });
  }
  try {
    const body = await readBody(req, 4096);
    const parsed = JSON.parse(body);
    const u = String(parsed.url || '');
    if (!u.startsWith('/uploads/')) throw new Error('bad-url');
    const full = safeUploadPath(u.slice('/uploads/'.length));
    if (!full) throw new Error('bad-path');
    fs.unlink(full, () => {});
    return send(req, res, 200, '{"ok":true}', { 'Content-Type': 'application/json' });
  } catch (e) {
    return send(req, res, 400, '{"ok":false}', { 'Content-Type': 'application/json' });
  }
}

function serveUpload(req, res, urlPath) {
  const full = safeUploadPath(urlPath.slice('/uploads/'.length));
  if (!full) return notFound(req, res);
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    sendFile(req, res, full);
  });
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

  // www.домен и домен без www отдавали один и тот же контент как два разных адреса —
  // для поисковиков это дубли; склеиваем 301-редиректом на версию без www (она везде
  // и так прописана как канонический адрес в canonical/og/sitemap).
  const hostHeader = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  if (hostHeader.toLowerCase().startsWith('www.')) {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    res.writeHead(301, { Location: `${proto}://${hostHeader.slice(4)}${req.url}` });
    return res.end();
  }

  if (urlPath === '/api/lead') return handleLead(req, res);
  if (urlPath === '/api/data') return handleData(req, res);
  if (urlPath === '/api/video-thumb') return handleVideoThumb(req, res, urlObj.searchParams.get('url'));
  if (urlPath === '/api/upload-photo') return handleUploadPhoto(req, res);
  if (urlPath === '/api/delete-photo') return handleDeletePhoto(req, res);
  if (urlPath.startsWith('/uploads/')) return serveUpload(req, res, urlPath);
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
