// Сервер для Railway (и любого Node-хостинга): раздаёт статику,
// закрывает admin.html паролем (Basic Auth, переменная ADMIN_PASSWORD),
// подставляет реальный домен в canonical/og:url/sitemap/robots,
// сжимает ответы (gzip) и ставит заголовки кэширования.
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createHash, randomBytes } = require('crypto');

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
// По той же причине (см. выше) — иначе подстановка контактных ссылок (см.
// injectContactHrefs) на статической раздаче в обход Node не сработает.
const INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.join(__dirname, 'index.html');
const SPECIALISTS_HTML_PATH = process.env.SPECIALISTS_HTML_PATH || path.join(__dirname, 'specialists.html');
const CASES_HTML_PATH = process.env.CASES_HTML_PATH || path.join(__dirname, 'cases.html');
const PRIVACY_HTML_PATH = process.env.PRIVACY_HTML_PATH || path.join(__dirname, 'privacy.html');
// data.js — общий модуль с данными и логикой сайта, его правят чуть ли не в каждой
// новой фиче. По той же причине, что и specialist.html/blog.html выше, на хостингах со
// статической раздачей файлов в обход Node запрос до него не доходит — а значит, не
// доходит и заголовок Cache-Control: no-cache, и раздающий слой отдаёт файл со своим
// собственным (многодневным!) кэшем: у части посетителей/админов долго держится старая
// версия файла, рассинхронизированная с остальным кодом сайта — вплоть до ошибок вида
// «функция не найдена». Путь к «настоящему» файлу — здесь же, вне публичной папки.
const DATA_JS_PATH = process.env.DATA_JS_PATH || path.join(__dirname, 'data.js');
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

// Базовые security-заголовки — на все ответы сразу, независимо от типа контента.
// Не влияют напрямую на позиции в выдаче, но входят в общую оценку доверия к сайту
// у поисковиков и убирают предупреждения браузеров про небезопасные заголовки.
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function send(req, res, code, body, headers) {
  headers = { ...SECURITY_HEADERS, ...(headers || {}) };
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
    if (ext === '.html') data = Buffer.from(injectContactHrefs(data.toString('utf8')), 'utf8');
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
// vk.com превью не получить — ссылка всё равно сохранится, просто без картинки.
// Запрос идёт с сервера (не из браузера), поэтому CORS не мешает. Кэшируем только
// найденные обложки: временный отказ видеосервиса не должен оставлять видео без кадра на сутки.
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
  if (thumb) videoThumbCache.set(videoUrl, { thumb, ts: Date.now() });
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

// Ссылки на контакты (шапка, футер, кнопки "Написать") на всех страницах — вида
// href="{{ mainHref }}" — подставляются только клиентским JS после загрузки данных.
// Поисковый бот при первом обходе видит СЫРОЙ HTML (без выполнения JS) и буквально
// находит там ссылку на несуществующую страницу "/{{ mainHref }}" — переходит по ней,
// получает 404, и это тратит краулинговый бюджет впустую. Подставляем реальные
// значения прямо на сервере — та же логика, что дублируется в renderVals() каждой
// страницы (specialists.html, specialist.html и т.д.), только на стороне Node.
const DEFAULT_CONTACTS = { person: 'Сергей Зеленский', phone: '+7 918 206 29 11', tg: 'sazelenskiy', email: 'ser-zelenskiy@yandex.ru', max: '' };
function readContacts() {
  const d = readLiveData();
  return (d && d.contacts) ? { ...DEFAULT_CONTACTS, ...d.contacts } : DEFAULT_CONTACTS;
}
function contactHrefs(contacts) {
  const tgHref = 'https://t.me/' + String(contacts.tg || '').replace(/^@/, '');
  const maxRaw = String(contacts.max || '').trim();
  const maxHref = maxRaw ? (maxRaw.startsWith('http') ? maxRaw : 'https://' + maxRaw.replace(/^\/+/, '')) : '';
  const mainHref = maxHref || tgHref;
  const phoneHref = 'tel:' + String(contacts.phone || '').replace(/[^+\d]/g, '');
  const mailHref = 'mailto:' + (contacts.email || '');
  return { mainHref, tgHref, phoneHref, mailHref, maxHref };
}
function injectContactHrefs(html) {
  const hrefs = contactHrefs(readContacts());
  return html
    .split('href="{{ mainHref }}"').join(`href="${escapeHtml(hrefs.mainHref)}"`)
    .split('href="{{ tgHref }}"').join(`href="${escapeHtml(hrefs.tgHref)}"`)
    .split('href="{{ phoneHref }}"').join(`href="${escapeHtml(hrefs.phoneHref)}"`)
    .split('href="{{ mailHref }}"').join(`href="${escapeHtml(hrefs.mailHref)}"`)
    .split('href="{{ maxHref }}"').join(`href="${escapeHtml(hrefs.maxHref)}"`);
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
const SITE_ORIGIN = 'https://eventspecialists.ru';
const siteDataModule = fs.promises.readFile(DATA_JS_PATH)
  .then(source => import('data:text/javascript;base64,' + source.toString('base64')))
  .catch(error => {
    console.error('Unable to load SEO defaults:', error.message);
    return null;
  });

async function readSeoData() {
  const { mergeWithDefaults = live => live } = await siteDataModule || {};
  const live = readLiveData();
  const data = mergeWithDefaults(live || { specialists: [] });
  return { categories: [], specialists: [], articles: [], ...data };
}

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
  if (seo.ld) html = html.replace('<!--SEO_JSONLD-->', () => `<script type="application/ld+json"${seo.ld['@type'] === 'Person' ? ' id="server-person-seo"' : ''}>${escapeJsonLd(seo.ld)}</script>`);
  if (seo.body) html = html.replace('<!--SEO_CONTENT-->', () => seo.body);
  return html;
}

// В страницах направлений SEO и данные профиля берутся из соответствующего eventProfile.
function buildSpecialistSeo(s, categories, origin, ctx) {
  const eventType = ctx && ctx.eventType;
  const profile = getEventProfile(s, eventType) || s;
  const eventNames = { wedding: 'свадебных событий', corporate: 'деловых мероприятий', entertainment: 'праздников' };
  const cat = (categories || []).find(c => c.slug === profile.cat);
  const catName = cat ? cat.name : '';
  const eventLabel = eventNames[eventType] || '';
  const title = clamp(`${profile.name} — ${profile.role}, Владивосток | Хорошее решение`, 100);
  const description = clamp(`${profile.name}${catName ? ' (' + catName + (profile.exp ? ', опыт ' + profile.exp : '') + ')' : ''}${eventLabel ? ' — специалист: ' + eventLabel : ''} — профиль, портфолио и видео работ. Бронирование напрямую, ${profile.price || 'цена по запросу'}, без агентской наценки.`, 200);
  const sectionPath = eventType === 'wedding' ? '/svadby' : eventType === 'corporate' ? '/korporativy' : eventType === 'entertainment' ? '/prazdniki-i-shou' : '';
  const url = `${origin}${sectionPath}${sectionPath ? '/' : '/'}specialist.html?id=${encodeURIComponent(s.id)}`;
  return {
    title, description, url,
    ogTitle: clamp(`${profile.name} — ${profile.role}`, 90),
    ogDescription: description,
    ld: {
      '@context': 'https://schema.org', '@type': 'Person', name: profile.name, jobTitle: profile.role,
      description: profile.about || undefined,
      memberOf: { '@type': 'Organization', name: 'Объединение ивент-специалистов «Хорошее решение»' },
      url,
    },
  };
}

// Поддерживаем старые живые данные до их первого сохранения из обновлённой админки.
function getEventProfile(s, eventType) {
  if (!s || !eventType) return s || null;
  const current = s.eventProfiles && s.eventProfiles[eventType];
  if (current) return current;
  const common = {
    name: s.name || '', role: s.role || '', exp: s.exp || '', price: s.price || '',
    cat: s.cat || '', subcat: s.subcat || '', photo: s.photo || '', about: s.about || '',
    feats: Array.isArray(s.feats) ? s.feats : [], links: Array.isArray(s.links) ? s.links : [],
    videos: Array.isArray(s.videos) ? s.videos : [], photos: Array.isArray(s.photos) ? s.photos : [],
    mediaCats: Array.isArray(s.mediaCats) ? s.mediaCats : [],
  };
  if (eventType === 'wedding') return {
    ...common, ...(s.weddingProfile || {}), enabled: s.wedding === true,
  };
  const text = [s.name, s.role, s.cat].join(' ').toLowerCase();
  const weddingOnly = /свадеб|свадьб|невест|венчан/.test(text)
    || ['keitering', 'konditery', 'ploshchadki'].includes(s.cat);
  return { ...common, enabled: s.wedding !== true && !weddingOnly };
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

// Статические страницы без per-request SEO (у них уже свои корректные title/description
// в самом файле) — но всё равно через Node, чтобы сработала подстановка контактных ссылок.
function homeCasePreview(data) {
  const cases = Array.isArray(data?.cases) ? data.cases : [];
  const sections = { wedding: '/svadby/cases', corporate: '/korporativy/cases', entertainment: '/prazdniki-i-shou/cases' };
  const items = Object.entries(sections).map(([type, href]) => {
    const item = cases.find(c => c.title && c.desc && !c.hidden && !/заполните описание/i.test(c.desc)
      && Array.isArray(c.eventTypes) && c.eventTypes.includes(type));
    if (!item) return '';
    const details = [item.format, item.city, item.guests && ('гостей: ' + item.guests)].filter(Boolean).join(' · ');
    return `<li><a href="${href}">${escapeHtml(item.title)}</a><p>${escapeHtml(details)}</p></li>`;
  }).filter(Boolean);
  return items.length ? `<section class="home-cases" aria-labelledby="home-cases-title"><h2 id="home-cases-title">Наши проекты</h2><ul>${items.join('')}</ul></section>` : '';
}

function servePlainPage(req, res, filePath, directory = '') {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return notFound(req, res);
    if (filePath === INDEX_HTML_PATH) {
      html = html.replace('<!-- published-case-preview -->', () => homeCasePreview(readLiveData()));
      html = html.replace(/<!--SEO_CONTENT_START-->[\s\S]*?<!--SEO_CONTENT_END-->/, () => directory);
    }
    html = injectContactHrefs(html);
    send(req, res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
}

function servePageWithSeo(req, res, filePath, seo) {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return notFound(req, res);
    if (seo) html = injectHead(html, seo);
    html = injectContactHrefs(html);
    send(req, res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  });
}

// Отдаём безусловно (с id и без) — не только чтобы подставить SEO-теги, но и чтобы
// путь гарантированно шёл через Node, а не через возможную статическую раздачу файла.
// ctx — необязательный контекст (см. buildSpecialistSeo), напр. { wedding: true } для /svadby/specialist.html.
async function serveSpecialistPage(req, res, id, ctx) {
  const d = await readSeoData();
  const s = id && d && Array.isArray(d.specialists) ? d.specialists.find(x => x.id === id && x.hidden !== true) : null;
  if (id && !s) return notFound(req, res);
  const profile = s && ctx && ctx.eventType ? getEventProfile(s, ctx.eventType) : null;
  if (ctx && ctx.eventType && (!profile || profile.enabled !== true)) return notFound(req, res);
  const seo = s ? buildSpecialistSeo(s, d.categories, SITE_ORIGIN, ctx) : null;
  servePageWithSeo(req, res, SPECIALIST_HTML_PATH, seo);
}

// Свадебный каталог (/svadby) — та же страница specialists.html (она сама, по location.pathname,
// переключается в свадебный режим — фильтр по s.wedding и плитки из WEDDING_CATALOG, см. data.js),
// только заголовок/описание для соцсетей и поисковиков — под свадебную тематику.
function weddingCatalogSeo(origin) {
  const o = origin || 'https://eventspecialists.ru';
  const description = 'Свадебные специалисты «Хорошего решения»: ведущие, фотографы, видеографы, декораторы и флористы, кейтеринг, кондитеры, визажисты и стилисты, площадки — заточены именно под свадьбы.';
  return {
    title: 'Специалисты на свадьбу | Хорошее решение',
    description,
    url: `${o}/svadby`,
    ogTitle: 'Специалисты на свадьбу',
    ogDescription: description,
  };
}

async function serveArticlePage(req, res, slug) {
  const d = await readSeoData();
  const a = slug && d && Array.isArray(d.articles) ? d.articles.find(x => x.slug === slug) : null;
  const seo = a ? buildArticleSeo(a, SITE_ORIGIN) : null;
  servePageWithSeo(req, res, BLOG_HTML_PATH, seo);
}

// Карта сайта собирается на лету: базовые страницы + каждый специалист и каждая статья
// блога из живых данных — так новые карточки из админки сами попадают в sitemap.
const localCatalogs = new Map([
  ['/organizatory', ['organizatory', 'Организаторы мероприятий во Владивостоке', 'Подбор команды, площадки и программы для корпоративов, деловых и частных событий.']],
  ['/prokatchiki', ['prokatchiki', 'Прокат оборудования для мероприятий во Владивостоке', 'Подберите оборудование и технических специалистов для вашей площадки и программы.']],
  ['/fotografy', ['fotografy', 'Фотографы во Владивостоке', 'Репортажная и постановочная съёмка свадеб, корпоративов и частных событий. Посмотрите портфолио фотографов и уточните стоимость и свободную дату.']],
  ['/vedushchie', ['vedushchie', 'Ведущие мероприятий во Владивостоке', 'Ведущие для свадеб, корпоративов и частных праздников. Посмотрите видео и программы, чтобы выбрать стиль ведения вашего события.']],
  ['/videografy', ['videografy', 'Видеографы во Владивостоке', 'Видеосъёмка свадеб, деловых мероприятий и праздников. Посмотрите примеры роликов и уточните условия съёмки на вашу дату.']],
]);

function localProfiles(data, category) {
  return (Array.isArray(data?.specialists) ? data.specialists : [])
    .filter(s => s.hidden !== true && s.cat === category && s.id && s.name);
}

function seoCatalogs(data) {
  const catalogs = new Map(localCatalogs);
  for (const category of Array.isArray(data.categories) ? data.categories : []) {
    if (category.weddingOnly || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category.slug) || !category.name) continue;
    if (!catalogs.has('/' + category.slug)) {
      catalogs.set('/' + category.slug, [category.slug, category.name + ' во Владивостоке', category.desc || 'Посмотрите портфолио специалистов и уточните условия на вашу дату.']);
    }
  }
  return catalogs;
}

function directoryLinks(data) {
  const links = [...seoCatalogs(data)]
    .filter(([, [category]]) => localProfiles(data, category).length)
    .map(([route, [, heading]]) => `<li><a href="${route}" style="color:inherit;text-decoration:underline">${escapeHtml(heading)}</a></li>`);
  return links.length ? `<section style="max-width:1180px;margin:32px auto;padding:0 24px"><h2>Специалисты для мероприятий во Владивостоке</h2><ul style="display:flex;flex-wrap:wrap;gap:12px 28px;padding:0;list-style:none">${links.join('')}</ul></section>` : '';
}

function serveLocalCatalog(req, res, route, data, config) {
  const [category, heading, description] = config;
  const profiles = localProfiles(data, category);
  const origin = SITE_ORIGIN;
  const cards = profiles.map(s => {
    const profileUrl = '/specialist.html?id=' + encodeURIComponent(s.id);
    const price = /[0-9]/.test(s.price || '') ? s.price : 'Стоимость по запросу';
    return `<li><a href="${profileUrl}">${escapeHtml(s.name)}</a><br>${escapeHtml(s.role)}<br>${escapeHtml(price)}</li>`;
  }).join('');
  const body = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)} — Хорошее решение</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(origin + route)}"><link rel="icon" href="/favicon.svg">
${cards ? '' : '<meta name="robots" content="noindex,follow">'}
<style>
body{margin:0;background:#0c1117;color:#f2f5f8;font:1rem/1.6 system-ui,sans-serif}
main{max-width:70rem;margin:auto;padding:2rem 1.25rem 4rem}
h1{font-size:clamp(2rem,5vw,3.75rem);line-height:1.12;margin:1rem 0}
p{max-width:65ch;color:#c7d0d9}a{color:#ff9c55}
ul{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:1rem}
li{padding:1rem;border:1px solid #35404d;background:#121a26;border-radius:.75rem}
li a{font-weight:700}.cta{display:inline-block;background:#ee7f2d;color:#0c1117;padding:.65rem 1rem;border-radius:.5rem;font-weight:700}
</style></head><body><main><nav aria-label="Навигация"><a href="/">Хорошее решение</a> · <a href="/specialists.html">Все специалисты</a></nav>
<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(description)}</p>
${cards ? '<ul>' + cards + '</ul>' : '<p>Свяжитесь с командой, чтобы подобрать специалиста под ваш формат.</p>'}
<a class="cta" href="/specialists.html?cat=${category}#zayavka">Помочь с подбором</a>
</main></body></html>`;
  send(req, res, 200, body, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function serveSitemap(req, res) {
  const origin = SITE_ORIGIN;
  const d = await readSeoData();
  const urls = [
    { loc: origin + '/', priority: '1.0' },
    { loc: origin + '/specialists.html', priority: '0.9' },
    { loc: origin + '/svadby', priority: '0.85' },
    { loc: origin + '/korporativy', priority: '0.85' },
    { loc: origin + '/prazdniki-i-shou', priority: '0.85' },
    { loc: origin + '/svadby/cases', priority: '0.75' },
    { loc: origin + '/korporativy/cases', priority: '0.75' },
    { loc: origin + '/prazdniki-i-shou/cases', priority: '0.75' },
    { loc: origin + '/cases.html', priority: '0.8' },
    { loc: origin + '/blog.html', priority: '0.7' },
  ];
  for (const [route, [category]] of seoCatalogs(d)) {
    if (localProfiles(d, category).length) urls.push({ loc: origin + route, priority: '0.8' });
  }
  if (d && Array.isArray(d.specialists)) d.specialists.filter(s => s.hidden !== true).forEach(s => {
    urls.push({ loc: origin + '/specialist.html?id=' + encodeURIComponent(s.id), priority: '0.6' });
    const paths = { wedding: '/svadby', corporate: '/korporativy', entertainment: '/prazdniki-i-shou' };
    for (const [type, basePath] of Object.entries(paths)) if (getEventProfile(s, type).enabled === true)
      urls.push({ loc: origin + basePath + '/specialist.html?id=' + encodeURIComponent(s.id), priority: '0.6' });
  });
  if (d && Array.isArray(d.articles)) d.articles.forEach(a => urls.push({ loc: origin + '/blog.html?post=' + encodeURIComponent(a.slug), priority: '0.6' }));
  const body = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map(u => `  <url><loc>${escapeHtml(u.loc)}</loc></url>`).join('\n')
    + '\n</urlset>\n';
  send(req, res, 200, body, { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' });
}

// Читает тело запроса целиком, обрывая соединение при превышении лимита.
// ВАЖНО: копим сырые Buffer-куски и собираем строку ОДНИМ вызовом toString('utf8') в
// самом конце — а не через body += chunk на каждый кусок. Русские буквы в UTF-8 занимают
// по 2 байта; если такая буква попадает ровно на границу двух сетевых пакетов, а куски
// декодируются в текст по отдельности, каждый байт превращается в свой «битый» символ —
// одна буква на глазах становится двумя «?». Именно так портился текст в данных сайта.
function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) { tooBig = true; req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8')); });
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
  specialists: 'id', cases: 'id', reviews: 'id', specReviews: 'id', videos: 'id',
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

// Подстраховка: перед каждой записью данных сайта копируем то, что было ДО нее, в папку
// с бэкапами (внутри private/, наружу не отдаётся). Это не история версий и не отменяет
// правки в один клик — но если когда-нибудь снова случится непредвиденная потеря данных
// (баг, чужая случайная перезапись и т.п.), нужное состояние можно будет найти в одном из
// последних файлов и восстановить вручную. Храним последние 500 снимков — при типичном
// размере файла данных (десятки КБ, фото теперь отдельно) это единицы мегабайт на диске.
const DATA_BACKUPS_DIR = path.join(path.dirname(LIVE_DATA_PATH), 'backups');
const MAX_DATA_BACKUPS = 500;
function backupLiveData() {
  try {
    if (!fs.existsSync(LIVE_DATA_PATH)) return;
    fs.mkdirSync(DATA_BACKUPS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);
    fs.copyFileSync(LIVE_DATA_PATH, path.join(DATA_BACKUPS_DIR, `data-${stamp}.json`));
    const files = fs.readdirSync(DATA_BACKUPS_DIR).filter(f => f.startsWith('data-')).sort();
    while (files.length > MAX_DATA_BACKUPS) fs.unlinkSync(path.join(DATA_BACKUPS_DIR, files.shift()));
  } catch (e) { /* бэкап — это подстраховка, не должен ронять само сохранение */ }
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
      // Отзывы, ещё не одобренные в админке, не должны доходить до посетителей: этот
      // ответ читает каждая страница сайта, и всё, что в нём есть, видно любому через
      // «Просмотр кода». Админке (она за паролем) отдаём данные целиком — иначе там
      // нечего будет модерировать.
      if (!adminAuthorized(req)) {
        try {
          const j = JSON.parse(data);
          if (Array.isArray(j.specReviews)) {
            j.specReviews = j.specReviews.filter(r => r && r.status === 'ok');
            data = JSON.stringify(j);
          }
        } catch { /* файл повреждён — отдаём как есть, как и раньше */ }
      }
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
    // ВАЖНО: раньше здесь было автопринятие старого формата (без обёртки {mode,data}) как
    // «полная замена данных» — это оказалось опасно. У вкладки со старой закэшированной
    // версией data.js (баг статической раздачи, см. DATA_JS_PATH выше) старая функция
    // syncData принимает один аргумент; свежая admin.html вызывает её с двумя — и в старую
    // функцию попадает только ПЕРВЫЙ (это устаревший снимок данных на момент открытия
    // вкладки, а не текущие правки), который она без обёртки и отправляла. Сервер трактовал
    // это как «полностью заменить данные» и тихо откатывал базу к старому снимку, стирая
    // всё добавленное другими с тех пор. Теперь при таком формате — явная ошибка вместо
    // тихой потери чужих данных; лечится обновлением страницы админки.
    const incoming = parsed && parsed.data;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('bad-shape');
    let merged;
    if (parsed.mode === 'overwrite') {
      merged = incoming;
    } else {
      let current = {};
      try { current = JSON.parse(fs.readFileSync(LIVE_DATA_PATH, 'utf8')); } catch { /* первое сохранение — файла ещё нет */ }
      merged = mergeLiveData(parsed.base, incoming, current);
    }
    backupLiveData();
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

function serveDataJs(req, res) {
  fs.readFile(DATA_JS_PATH, (err, data) => {
    if (err) return notFound(req, res);
    send(req, res, 200, data, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
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

  const chunks = [];
  let total = 0;
  req.on('data', chunk => {
    total += chunk.length;
    if (total > 8192) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8'); // см. readBody выше — то же самое, одним куском
    let text, source;
    try { const j = JSON.parse(body); text = String(j.text || '').trim(); source = String(j.source || '').trim(); } catch { text = ''; source = ''; }
    if (!text || text.length > 3500) return send(req, res, 400, '{"ok":false,"reason":"bad-text"}', { 'Content-Type': 'application/json' });
    // Помечаем заявки со свадебного раздела прямо в тексте сообщения — отдельного хранилища
    // заявок нет, единственный канал их получения — телеграм (см. tgSend ниже).
    if (source === 'wedding') text = '💍 Источник: Свадьбы\n' + text;
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

// Отзыв о специалисте, оставленный гостем прямо на его странице. На сайт он не попадает
// сразу: сохраняем со статусом 'new' (в /api/data такие не отдаются никому, кроме админки,
// см. handleData) и пишем в тот же телеграм, куда уходят заявки. Публикуется одобрением
// в админке. Защита от мусора: ловушка-поле для ботов, ограничение по частоте с одного
// IP, лимиты длины и потолок на число неодобренных отзывов.
const REVIEW_MAX_PENDING = 300;
// Считаем только ДОШЕДШИЕ до сохранения отзывы: иначе человек, ошибившийся в форме
// пару раз, исчерпал бы лимит и не смог отправить исправленный отзыв.
const reviewLog = new Map();
function reviewsRecently(ip) {
  const now = Date.now();
  return (reviewLog.get(ip) || []).filter(t => now - t < 3600000).length;
}
function reviewRecord(ip) {
  const now = Date.now();
  const arr = (reviewLog.get(ip) || []).filter(t => now - t < 3600000);
  arr.push(now);
  reviewLog.set(ip, arr);
  if (reviewLog.size > 5000) reviewLog.clear();
}

function writeLiveData(data) {
  backupLiveData();
  const tmpPath = LIVE_DATA_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data));
  fs.renameSync(tmpPath, LIVE_DATA_PATH);
}

async function handleReview(req, res) {
  if (req.method !== 'POST') return send(req, res, 405, '{"ok":false}', { 'Content-Type': 'application/json' });
  const json = (code, obj) => send(req, res, code, JSON.stringify(obj), { 'Content-Type': 'application/json' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (reviewsRecently(ip) >= 3) return json(429, { ok: false, reason: 'rate-limit' });
  try {
    const parsed = JSON.parse(await readBody(req, 16 * 1024));
    // Поле-ловушка: в форме оно спрятано от людей, но бот его послушно заполняет.
    // Отвечаем «принято», чтобы он не искал обход, — на деле просто ничего не сохраняем.
    if (String(parsed.website || '').trim()) return json(200, { ok: true });

    const specId = String(parsed.specId || '').trim();
    const author = String(parsed.author || '').trim().slice(0, 60);
    const event = String(parsed.event || '').trim().slice(0, 80);
    const text = String(parsed.text || '').trim();
    const rating = Math.round(Number(parsed.rating));
    if (author.length < 2) return json(400, { ok: false, reason: 'bad-author' });
    if (text.length < 10 || text.length > 2000) return json(400, { ok: false, reason: 'bad-text' });
    if (!(rating >= 1 && rating <= 5)) return json(400, { ok: false, reason: 'bad-rating' });

    const current = readLiveData() || {};
    const spec = Array.isArray(current.specialists) ? current.specialists.find(x => x.id === specId) : null;
    if (!spec) return json(400, { ok: false, reason: 'bad-specialist' });

    const list = Array.isArray(current.specReviews) ? current.specReviews : [];
    if (list.filter(r => r && r.status === 'new').length >= REVIEW_MAX_PENDING) {
      return json(429, { ok: false, reason: 'too-many-pending' });
    }
    // Двойное нажатие кнопки или повторная отправка той же формы — не плодим копии.
    if (list.some(r => r && r.specId === specId && r.text === text && r.author === author)) {
      return json(200, { ok: true });
    }
    list.push({
      id: 'rv' + Date.now() + Math.random().toString(36).slice(2, 6),
      specId, author, event, rating, text,
      date: new Date().toISOString().slice(0, 10),
      status: 'new', src: 'site',
    });
    current.specReviews = list;
    writeLiveData(current);
    reviewRecord(ip);

    if (TG_BOT_TOKEN) {
      const msg = '🆕 Новый отзыв (ждёт одобрения)\n'
        + 'Специалист: ' + spec.name + (spec.role ? ' — ' + spec.role : '') + '\n'
        + 'Автор: ' + author + (event ? ' · ' + event : '') + '\n'
        + 'Оценка: ' + '★'.repeat(rating) + '☆'.repeat(5 - rating) + ' (' + rating + ' из 5)\n\n'
        + text + '\n\n'
        + 'Опубликовать: админ-панель → Отзывы → На модерации';
      tgSend(LEAD_MAIN_ID, msg).catch(() => {});
      for (const id of extraLeadIds()) {
        if (id !== LEAD_MAIN_ID) tgSend(id, msg).catch(() => {});
      }
    }
    return json(200, { ok: true });
  } catch (e) {
    return json(400, { ok: false, reason: 'bad-body' });
  }
}

const applicationsDir = path.resolve(path.dirname(LIVE_DATA_PATH), '.specialist-applications');
const tokenPattern = /^[0-9a-f]{48}$/;
const applicationEvents = ['wedding', 'corporate', 'entertainment'];
const applicationMax = 10 * 1024 * 1024;

function readApplication(token) {
  try { return JSON.parse(fs.readFileSync(path.join(applicationsDir, token + '.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function saveApplication(record) {
  fs.mkdirSync(applicationsDir, { recursive: true, mode: 0o700 });
  const file = path.join(applicationsDir, record.token + '.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function applicationSummary({ token, status, created, name, specId }) {
  if (status === 'open' && Date.now() - created >= 14 * 86400000) status = 'expired';
  return { token, status, created, name, specId };
}

function applicationImage(value) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(value || ''));
  if (!match || match[1].length > 950000) throw new Error('photo');
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length < 5 || !bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) throw new Error('photo');
  return bytes;
}

function normalizeApplication(input, categories) {
  const field = (value, limit) => {
    if (typeof value !== 'string' || value.length > limit) throw new Error('field');
    return value.trim();
  };
  const urls = value => field(value, 3000).split(/\r?\n/).map(s => s.trim()).filter(Boolean).map(s => {
    const url = new URL(s);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('url');
    return url.href;
  }).join('\n');
  const clean = (p, general) => {
    const cat = field(p.cat, 100);
    const subcat = field(p.subcat, 100);
    const category = categories.find(c => c.slug === cat);
    if (!category || (subcat && !category.subcats?.some(c => c.slug === subcat))) throw new Error('category');
    const name = general ? field(p.name, 100) : '';
    const role = field(p.role, 120);
    const about = field(p.about, 4000);
    if (!role || !about || (general && !name)) throw new Error('required');
    const photo = p.photo || '';
    if (photo || general) applicationImage(photo);
    if (!Array.isArray(p.photos) || p.photos.length > 6) throw new Error('photo');
    p.photos.forEach(applicationImage);
    return { name, role, cat, subcat, about, exp: field(p.exp, 80), price: field(p.price, 100),
      feats: field(p.feats, 2500), videos: urls(p.videos), links: urls(p.links), photo, photos: p.photos };
  };
  const general = clean(input.general, true);
  const contact = field(input.contact, 160);
  if (!contact) throw new Error('required');
  const events = {};
  for (const type of applicationEvents) {
    const entry = input.events?.[type];
    if (entry) events[type] = entry === true ? true : clean(entry, false);
  }
  return { general, events, contact };
}

function publishApplication(token, profile, defaults) {
  let index = 0;
  const written = [];
  const id = 'app-' + createHash('sha256').update(token).digest('hex').slice(0, 24);
  const raw = fs.existsSync(LIVE_DATA_PATH) ? JSON.parse(fs.readFileSync(LIVE_DATA_PATH, 'utf8')) : {};
  const specialists = raw.specialists || defaults;
  if (specialists.some(s => s.id === id)) return id;
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const savePhoto = value => {
    const name = id + '-' + (++index) + '.jpg';
    const file = path.join(UPLOADS_DIR, name);
    written.push(file);
    fs.writeFileSync(file, applicationImage(value));
    return '/uploads/' + name;
  };
  const lines = s => s.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const toProfile = p => ({
    ...p, name: profile.general.name,
    feats: lines(p.feats),
    videos: lines(p.videos).map(url => ({ url, title: '' })),
    links: lines(p.links).map(url => ({ url, title: '' })),
    photo: p.photo ? savePhoto(p.photo) : '',
    photos: p.photos.map(value => ({ url: savePhoto(value) })),
    mediaCats: [],
  });
  try {
    const general = toProfile(profile.general);
    const eventProfiles = Object.fromEntries(applicationEvents.map(type => {
      const row = profile.events[type];
      const entry = row && row !== true ? toProfile(row) : general;
      return [type, { ...entry, photo: entry.photo || general.photo, enabled: !!row, syncGeneral: row === true }];
    }));
    writeLiveData({ ...raw, specialists: [{ ...general, id, tg: '', hidden: false,
      wedding: !!profile.events.wedding, eventProfiles }, ...specialists] });
  } catch (error) {
    for (const file of written) {
      try { fs.rmSync(file, { force: true }); } catch (cleanupError) { console.error(cleanupError.message); }
    }
    throw error;
  }
  return id;
}

async function handleApplications(req, res, url, admin) {
  const json = (code, body, headers) => send(req, res, code, JSON.stringify(body), {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers,
  });
  if (!ADMIN_PASSWORD || (admin && !adminAuthorized(req))) return json(401, { error: 'unauthorized' }, {
    ...(admin && { 'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"' }),
  });
  const token = url.searchParams.get('token');
  const action = url.searchParams.get('action');
  try {
    if (admin && !token && req.method === 'GET') {
      const files = fs.existsSync(applicationsDir) ? fs.readdirSync(applicationsDir) : [];
      const records = files.filter(file => file.endsWith('.json') && tokenPattern.test(file.slice(0, -5)))
        .map(file => applicationSummary(readApplication(file.slice(0, -5))));
      return json(200, { records: records.sort((a, b) => b.created - a.created) });
    }
    if (req.method === 'POST' && req.headers['content-type'] !== 'application/json') return json(415, { error: 'format' });
    if (admin && action === 'create' && req.method === 'POST') {
      const record = { token: randomBytes(24).toString('hex'), created: Date.now(), status: 'open' };
      saveApplication(record);
      return json(201, applicationSummary(record));
    }
    if (!tokenPattern.test(token || '')) return json(404, { error: 'missing' });
    const initial = readApplication(token);
    if (!initial) return json(404, { error: 'missing' });
    if (req.method === 'GET') {
      const summary = applicationSummary(initial);
      return json(200, admin ? { ...summary, profile: initial.profile } : { status: summary.status });
    }
    if (req.method !== 'POST') return json(405, { error: 'method' });
    const expected = admin && action !== 'cancel' ? 'pending' : 'open';
    if (applicationSummary(initial).status !== expected) return json(409, { error: 'closed' });
    if (Number(req.headers['content-length']) > applicationMax) return json(413, { error: 'size' });
    let input;
    try { input = JSON.parse(await readBody(req, applicationMax)); }
    catch { return json(400, { error: 'format' }); }
    const defaults = (await siteDataModule)?.DEFAULTS;
    const record = readApplication(token);
    if (!record || applicationSummary(record).status !== expected) return json(409, { error: 'closed' });
    if (admin && ['cancel', 'reject'].includes(action)) {
      const { profile, ...rest } = record;
      saveApplication({ ...rest, status: action === 'cancel' ? 'cancelled' : 'rejected' });
      return json(200, { ok: true });
    }
    if (admin && action !== 'publish') return json(400, { error: 'action' });
    if (!admin && input?.consent !== true) return json(400, { error: 'consent' });
    const categories = readLiveData()?.categories || defaults?.categories || [];
    let profile;
    try { profile = normalizeApplication(input, categories); }
    catch { return json(400, { error: 'invalid' }); }
    if (admin) {
      const specId = publishApplication(token, profile, defaults?.specialists || []);
      saveApplication({ token, created: record.created, submitted: record.submitted, name: profile.general.name, status: 'published', specId });
      return json(200, { ok: true, specId });
    }
    saveApplication({ ...record, submitted: Date.now(), name: profile.general.name, status: 'pending', profile });
    return json(200, { ok: true });
  } catch (error) {
    console.error('Specialist application:', error.message);
    return json(500, { error: 'server' });
  }
}

http.createServer(async (req, res) => {
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
  if (urlPath === '/api/review') return handleReview(req, res);
  if (urlPath === '/api/specialist-application') return handleApplications(req, res, urlObj, false);
  if (urlPath === '/admin/specialist-applications/api') return handleApplications(req, res, urlObj, true);
  if (urlPath === '/anketa-specialista' || urlPath === '/admin/specialist-applications/') {
    if (urlPath.startsWith('/admin/') && (!ADMIN_PASSWORD || !adminAuthorized(req))) return send(req, res, 401, 'Admin login required', {
      'WWW-Authenticate': 'Basic realm="Admin", charset="UTF-8"',
    });
    return sendFile(req, res, path.join(ROOT, 'specialist-application.html'));
  }
  if (urlPath === '/api/video-thumb') return handleVideoThumb(req, res, urlObj.searchParams.get('url'));
  if (urlPath === '/api/upload-photo') return handleUploadPhoto(req, res);
  if (urlPath === '/api/delete-photo') return handleDeletePhoto(req, res);
  if (urlPath.startsWith('/uploads/')) return serveUpload(req, res, urlPath);
  if (urlPath === '/data.js') return serveDataJs(req, res);
  if (urlPath === '/sitemap.xml') return serveSitemap(req, res);

  // Дубли главной склеиваем 301-редиректом на «/» — для SEO
  if (urlPath === '/index.html' || urlPath === '/index') {
    res.writeHead(301, { Location: '/' });
    return res.end();
  }
  // Главная и другие статические страницы — тоже всегда через Node (см. INDEX_HTML_PATH и
  // соседние константы выше): физических файлов в публичной папке больше нет, иначе на
  // хостингах со статической раздачей в обход Node (см. ADMIN_HTML_PATH) не сработает
  // подстановка контактных ссылок (см. injectContactHrefs).
  if (urlPath === '/') {
    const data = await readSeoData();
    return servePlainPage(req, res, INDEX_HTML_PATH, directoryLinks(data));
  }
  if (urlPath === '/specialists.html' || urlPath === '/specialists') {
    const data = await readSeoData();
    const cat = urlObj.searchParams.get('cat');
    const route = '/' + cat;
    const canonical = cat && seoCatalogs(data).has(route) && localProfiles(data, cat).length ? SITE_ORIGIN + route : SITE_ORIGIN + '/specialists.html';
    return servePageWithSeo(req, res, SPECIALISTS_HTML_PATH, { url: canonical, body: directoryLinks(data) });
  }
  if (urlPath === '/cases.html' || urlPath === '/cases') {
    return servePlainPage(req, res, CASES_HTML_PATH);
  }
  if (urlPath === '/privacy.html') {
    return servePlainPage(req, res, PRIVACY_HTML_PATH);
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
  // Каталоги и кейсы каждого направления используют те же шаблоны, сохраняя отдельные профили.
  const eventRoutes = {
    '/svadby': { id: 'wedding', name: 'Свадебные события' },
    '/korporativy': { id: 'corporate', name: 'Деловые мероприятия' },
    '/prazdniki-i-shou': { id: 'entertainment', name: 'Праздники' },
  };
  const eventRoute = eventRoutes[urlPath.replace(/\/$/, '')];
  if (eventRoute) {
    const origin = SITE_ORIGIN;
    const desc = `Специалисты и портфолио для направления «${eventRoute.name}» во Владивостоке. Подбор команды и бронирование напрямую.`;
    const routePath = urlPath.replace(/\/$/, '');
    const seo = eventRoute.id === 'wedding' ? weddingCatalogSeo(origin) : {
      title: `${eventRoute.name} во Владивостоке | Хорошее решение`, description: desc,
      url: `${origin}${routePath}`,
      ogTitle: eventRoute.name, ogDescription: desc,
    };
    return servePageWithSeo(req, res, SPECIALISTS_HTML_PATH, seo);
  }
  if (urlPath === '/svadby/cases' || urlPath === '/korporativy/cases' || urlPath === '/prazdniki-i-shou/cases')
    return servePlainPage(req, res, CASES_HTML_PATH);
  if (urlPath === '/svadby/specialist.html' || urlPath === '/svadby/specialist')
    return serveSpecialistPage(req, res, urlObj.searchParams.get('id'), { eventType: 'wedding' });
  if (urlPath === '/korporativy/specialist.html' || urlPath === '/korporativy/specialist')
    return serveSpecialistPage(req, res, urlObj.searchParams.get('id'), { eventType: 'corporate' });
  if (urlPath === '/prazdniki-i-shou/specialist.html' || urlPath === '/prazdniki-i-shou/specialist')
    return serveSpecialistPage(req, res, urlObj.searchParams.get('id'), { eventType: 'entertainment' });
  // Старый свадебный маршрут сохраняется.
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

  if (/^\/[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(urlPath)) {
    const route = urlPath.replace(/\/$/, '');
    const data = await readSeoData();
    const config = seoCatalogs(data).get(route);
    if (config) return serveLocalCatalog(req, res, route, data, config);
  }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  if (!path.extname(urlPath)) urlPath += '.html'; // /cases -> /cases.html

  if (urlPath.split(/[\\/]/).some(segment => segment.startsWith('.'))) return notFound(req, res);
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT + path.sep)) return notFound(req, res); // защита от ../
  const forbidden = new Set(['server.js', '_admin.html', '.live-data.json', '.env', 'index.html', 'specialists.html', 'cases.html', 'privacy.html']);
  if (forbidden.has(path.basename(filePath))) return notFound(req, res);

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return notFound(req, res);
    sendFile(req, res, filePath);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Site running on port ${PORT}. Admin password ${ADMIN_PASSWORD ? 'is set' : 'NOT set — admin disabled'}.`);
});
