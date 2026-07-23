// «Хорошее решение» — данные сайта. Правки: через Admin.dc.html (localStorage) или прямо здесь.
// Порядковый номер (num) не хранится — считается по позиции в списке при отображении,
// чтобы при добавлении/удалении категорий в админке нумерация всегда оставалась 01..N.
export const CATEGORIES = [
  { slug: 'organizatory', name: 'Организаторы', desc: 'Продюсируют событие целиком: идея, смета, площадка, тайминг' },
  { slug: 'fotografy', name: 'Фотографы', desc: 'Репортаж и постановка; снимали концерты российских и зарубежных звёзд' },
  { slug: 'videografy', name: 'Видеографы', desc: 'Операторы федеральных каналов, режиссёры и гаферы' },
  { slug: 'vedushchie', name: 'Ведущие', desc: 'Актёры, КВНщики, стендап-комики, теле- и радиоведущие' },
  { slug: 'didzhei', name: 'Диджеи', desc: 'Танцпол любого формата: от гала-ужина до фестиваля' },
  { slug: 'muzykanty', name: 'Музыканты', desc: 'Кавер-группы, вокалисты, инструменталисты' },
  { slug: 'dekoratory', name: 'Декораторы', desc: 'Оформление площадок, флористика, свет и сцена' },
  { slug: 'animatory', name: 'Аниматоры', desc: 'Детские и взрослые интерактивы, welcome-зоны' },
  { slug: 'stilisty', name: 'Стилисты', desc: 'Образы для героев события и команд' },
  { slug: 'vizazhisty', name: 'Визажисты', desc: 'Макияж и укладки на площадке в любое время' },
  { slug: 'prokatchiki', name: 'Прокатчики', desc: 'Звук, свет, экраны, сцены и спецэффекты' },
  { slug: 'artisty', name: 'Артисты оригинального жанра', desc: 'Шоу-номера, цирк, иллюзия, перформансы' },
];

// Транслитерация имени категории в URL-слаг; при коллизии добавляется числовой суффикс.
export function slugify(name, existingSlugs) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  let base = String(name || '').toLowerCase().split('').map(ch => map[ch] !== undefined ? map[ch] : ch).join('');
  base = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'kategoriya';
  const taken = new Set(existingSlugs || []);
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(base + '-' + i)) i++;
  return base + '-' + i;
}

// Что уместно показывать/запрашивать в профиле специалиста по категориям —
// video: 'reel' (одна визитка), 'few' (несколько роликов) или 'none';
// links: ссылки на внешний сайт/папку с работами (в основном фото/видеографам).
export const CATEGORY_PORTFOLIO = {
  vedushchie: { video: 'reel', links: false },
  organizatory: { video: 'reel', links: false },
  muzykanty: { video: 'few', links: false },
  fotografy: { video: 'few', links: true },
  videografy: { video: 'none', links: true },
  dekoratory: { video: 'none', links: false },
  animatory: { video: 'few', links: false },
  didzhei: { video: 'none', links: false },
  stilisty: { video: 'few', links: false },
  vizazhisty: { video: 'few', links: false },
  prokatchiki: { video: 'none', links: false },
  artisty: { video: 'few', links: false },
};
export const DEFAULT_PORTFOLIO_CFG = { video: 'few', links: false };

export const DEFAULTS = {
  contacts: { person: 'Сергей Зеленский', phone: '+7 918 206 29 11', tg: 'sazelenskiy', email: 'ser-zelenskiy@yandex.ru', max: '', leadIds: '' },
  categories: CATEGORIES,
  mediaCats: [
    { id: 'svadby', name: 'Свадьбы' },
    { id: 'korporativy', name: 'Корпоративы' },
    { id: 'chastnye', name: 'Частные праздники' },
    { id: 'koncerty', name: 'Концерты и фестивали' },
  ],
  specialists: [
    { id: 's1', cat: 'vedushchie', name: 'Имя Фамилия', role: 'Ведущий · стендап-комик', exp: '10+ лет', price: 'от — ₽', tg: '' },
    { id: 's2', cat: 'vedushchie', name: 'Имя Фамилия', role: 'Ведущая · теле- и радиоведущая', exp: '12 лет', price: 'от — ₽', tg: '' },
    { id: 's3', cat: 'vedushchie', name: 'Имя Фамилия', role: 'Ведущий · актёр, КВНщик', exp: '10 лет', price: 'от — ₽', tg: '' },
    { id: 's4', cat: 'vedushchie', name: 'Имя Фамилия', role: 'Ведущий · режиссёр', exp: '15 лет', price: 'от — ₽', tg: '' },
    { id: 's5', cat: 'fotografy', name: 'Имя Фамилия', role: 'Репортажный фотограф', exp: '16 лет', price: 'от — ₽', tg: '' },
    { id: 's6', cat: 'fotografy', name: 'Имя Фамилия', role: 'Постановочный фотограф', exp: '9 лет', price: 'от — ₽', tg: '' },
    { id: 's7', cat: 'fotografy', name: 'Имя Фамилия', role: 'Свадебный фотограф', exp: '11 лет', price: 'от — ₽', tg: '' },
    { id: 's8', cat: 'videografy', name: 'Имя Фамилия', role: 'Оператор-постановщик', exp: '14 лет', price: 'от — ₽', tg: '' },
    { id: 's9', cat: 'videografy', name: 'Имя Фамилия', role: 'Режиссёр · монтаж', exp: '10 лет', price: 'от — ₽', tg: '' },
    { id: 's10', cat: 'organizatory', name: 'Имя Фамилия', role: 'Продюсер событий', exp: '16 лет', price: 'от — ₽', tg: '' },
    { id: 's11', cat: 'organizatory', name: 'Имя Фамилия', role: 'Координатор площадки', exp: '8 лет', price: 'от — ₽', tg: '' },
    { id: 's12', cat: 'didzhei', name: 'Имя Фамилия', role: 'DJ · открытый формат', exp: '12 лет', price: 'от — ₽', tg: '' },
    { id: 's13', cat: 'didzhei', name: 'Имя Фамилия', role: 'DJ · lounge / гала', exp: '9 лет', price: 'от — ₽', tg: '' },
    { id: 's14', cat: 'muzykanty', name: 'Имя Фамилия', role: 'Кавер-группа', exp: '10 лет', price: 'от — ₽', tg: '' },
    { id: 's15', cat: 'muzykanty', name: 'Имя Фамилия', role: 'Вокалистка', exp: '7 лет', price: 'от — ₽', tg: '' },
    { id: 's16', cat: 'dekoratory', name: 'Имя Фамилия', role: 'Декоратор · флорист', exp: '9 лет', price: 'от — ₽', tg: '' },
    { id: 's17', cat: 'animatory', name: 'Имя Фамилия', role: 'Аниматор · интерактивы', exp: '6 лет', price: 'от — ₽', tg: '' },
    { id: 's18', cat: 'stilisty', name: 'Имя Фамилия', role: 'Стилист образов', exp: '8 лет', price: 'от — ₽', tg: '' },
    { id: 's19', cat: 'vizazhisty', name: 'Имя Фамилия', role: 'Визажист', exp: '10 лет', price: 'от — ₽', tg: '' },
    { id: 's20', cat: 'prokatchiki', name: 'Имя Фамилия', role: 'Свет · звук · экраны', exp: '12 лет', price: 'от — ₽', tg: '' },
    { id: 's21', cat: 'artisty', name: 'Имя Фамилия', role: 'Иллюзионист', exp: '11 лет', price: 'от — ₽', tg: '' },
    { id: 's22', cat: 'artisty', name: 'Имя Фамилия', role: 'Шоу-балет', exp: '9 лет', price: 'от — ₽', tg: '' },
  ],
  cases: [
    { id: 'c1', title: 'Корпоратив промышленной компании', format: 'Корпоратив · гала-ужин', guests: '450', city: 'Владивосток', year: '2025', team: '12', desc: 'Полный состав: ведущий, кавер-группа, DJ, фото и видео, декор зала, шоу-номера. Заполните описание в админ-панели.', video: '' },
    { id: 'c2', title: 'Свадьба на побережье', format: 'Частное событие', guests: '120', city: 'Приморье', year: '2025', team: '9', desc: 'Церемония, банкет, артисты оригинального жанра, салют. Заполните описание в админ-панели.', video: '' },
    { id: 'c3', title: 'Открытие торгового центра', format: 'Рекламная акция', guests: '3000', city: 'Владивосток', year: '2024', team: '25', desc: 'Сцена, звук, ведущие, аниматоры, промо-персонал, съёмка репортажа. Заполните описание в админ-панели.', video: '' },
    { id: 'c4', title: 'Форум предпринимателей', format: 'Форум · конференция', guests: '800', city: 'Дальний Восток', year: '2024', team: '14', desc: 'Модерация, техническое обеспечение, фотоотчёт дня, афтепати. Заполните описание в админ-панели.', video: '' },
    { id: 'c5', title: 'Юбилей — закрытый вечер', format: 'Частное событие', guests: '60', city: 'Владивосток', year: '2025', team: '6', desc: 'Камерный формат: ведущий, живая музыка, персональные подарки гостям. Заполните описание в админ-панели.', video: '' },
    { id: 'c6', title: 'Городской фестиваль', format: 'Фестиваль', guests: '2500', city: 'Владивосток', year: '2023', team: '30', desc: 'Две сцены, 12 часов программы, артисты, спорт-активности, дрон-съёмка. Заполните описание в админ-панели.', video: '' },
  ],
  packages: [
    { id: 'p1', name: 'Точечно', price: 'от — ₽', desc: 'Один-два специалиста под задачу', items: ['Подбор под формат и бюджет', 'Прямая цена специалиста, без наценки', 'Замена при форс-мажоре — бесплатно'] },
    { id: 'p2', name: 'Команда', price: 'от — ₽', desc: 'Полный состав на ваше событие', items: ['Ведущий, DJ, фото, видео, декор — единой командой', 'Смета без статьи «организация»', 'Координация состава в день события', 'Сработанные связки специалистов'] },
    { id: 'p3', name: 'Под ключ', price: 'от — ₽', desc: 'Организуем событие целиком', items: ['Идея, сценарий, площадка, смета', 'Вся команда и техника', 'Дорогие подарки гостям — от нас', 'Кэшбек 100% оплаты на будущие события'] },
  ],
  reviews: [
    { id: 'r1', author: 'Имя клиента', event: 'Корпоратив · 2025', text: 'Место для отзыва — добавьте текст в админ-панели.' },
    { id: 'r2', author: 'Имя клиента', event: 'Свадьба · 2025', text: 'Место для отзыва — добавьте текст в админ-панели.' },
    { id: 'r3', author: 'Имя клиента', event: 'Форум · 2024', text: 'Место для отзыва — добавьте текст в админ-панели.' },
  ],
  videos: [
    { id: 'v1', title: 'Шоурил объединения', url: '' },
    { id: 'v2', title: 'Корпоратив — афтемуви', url: '' },
    { id: 'v3', title: 'Фестиваль — репортаж', url: '' },
  ],
  calcServices: [
    { id: 'vedushchij', name: 'Ведущий', price: 40000, hint: 'программа вечера + сценарий' },
    { id: 'dj', name: 'DJ', price: 25000, hint: 'танцпол и фоновое сопровождение' },
    { id: 'foto', name: 'Фотограф', price: 25000, hint: 'репортаж + обработка' },
    { id: 'video', name: 'Видеограф', price: 35000, hint: 'репортаж + афтемуви' },
    { id: 'cover', name: 'Кавер-группа', price: 90000, hint: 'живой звук, 2–3 сета' },
    { id: 'dekor', name: 'Декор и флористика', price: 60000, hint: 'оформление зала и фотозона' },
    { id: 'tech', name: 'Звук и свет', price: 50000, hint: 'комплект под площадку' },
    { id: 'show', name: 'Шоу-номер', price: 30000, hint: 'артисты оригинального жанра' },
    { id: 'anim', name: 'Аниматоры / welcome', price: 15000, hint: 'встреча гостей, интерактивы' },
    { id: 'koord', name: 'Координатор', price: 20000, hint: 'тайминг и подрядчики в день события' },
  ],
  articles: [
    { id: 'a1', slug: 'kak-vybrat-vedushchego', title: 'Как выбрать ведущего на корпоратив: 7 вопросов до брони', date: '2026-06-18', minutes: '6', tag: 'Корпоративы', lead: 'Ведущий определяет 70% атмосферы вечера. Разбираем, что спросить до внесения предоплаты — и какие ответы должны насторожить.', body: 'Проверьте живое видео с похожего формата|Попросите не шоурил, а 10–15 минут непрерывной записи с реального события: видно темп, реакцию зала и работу с накладками.\nУточните, кто пишет сценарий|Хороший ведущий адаптирует программу под вашу компанию: имена, инсайды, специфику отрасли. Шаблонный сценарий слышно с первой минуты.\nОбсудите замену при форс-мажоре|У нас в объединении замена бесплатна: на событие выйдет коллега того же уровня с готовым сценарием. Спросите, как это устроено у вашего кандидата.\nЗафиксируйте тайминг и райдер письменно|Продолжительность, перерывы, техтребования — всё в договоре. Устные договорённости к вечеру события забываются.' },
    { id: 'a2', slug: 'byudzhet-korporativa', title: 'Из чего складывается бюджет корпоратива на 100 гостей', date: '2026-05-27', minutes: '8', tag: 'Бюджет', lead: 'Площадка, банкет, команда, техника — показываем реальную структуру сметы и объясняем, где наценки прячутся чаще всего.', body: 'Площадка и банкет — 45–55% бюджета|Это самая большая статья. Совет: смотрите будние даты и «несезон» — те же залы стоят на 20–30% дешевле пятниц декабря.\nКоманда специалистов — 25–35%|Ведущий, DJ, фото, видео, артисты. Через агентство к каждой позиции добавляется 15–30% комиссии; при работе с объединением цены прямые.\nТехника — 10–15%|Звук, свет, экраны. Дешевле брать у одного прокатчика комплектом, чем собирать по позициям.\nРезерв — 5–10%|Непредвиденное: доп. час работы, трансфер, замены. Если резерв не потратили — верните его в шоу-программу.' },
    { id: 'a3', slug: 'svadba-bez-agentstva', title: 'Свадьба без агентства: что взять на себя, а что отдать команде', date: '2026-04-30', minutes: '7', tag: 'Свадьбы', lead: 'Организовать свадьбу самим — реально. Рассказываем, какие задачи пара закрывает за один вечер, а где без профессионалов не обойтись.', body: 'Берите на себя: концепцию и список гостей|Никто лучше вас не знает, каким должен быть ваш день. Мудборд, палитра, стилистика — это ваше.\nОтдавайте: тайминг дня и координацию|Координатор избавит вас от 40+ звонков в день свадьбы. Это самая недооценённая позиция в смете.\nОтдавайте: фото и видео|Переснять нельзя. Смотрите полные свадьбы в портфолио, а не нарезки лучших кадров.\nСчитайте вместе: декор и флористику|Декоратор покажет, что из пинтереста реально в вашем зале и бюджете, и предложит замену дорогим позициям без потери картинки.' },
  ],
};

export const STORE_KEY = 'hr-site-data-v1';
export function loadData() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      const d = { ...DEFAULTS, ...saved, contacts: { ...DEFAULTS.contacts, ...(saved.contacts || {}) } };
      // миграция: подтягиваем новые поля из DEFAULTS в ранее сохранённые записи
      if (Array.isArray(d.cases)) d.cases = d.cases.map(k => ({ team: '', ...(DEFAULTS.cases.find(x => x.id === k.id) || {}), ...k }));
      if (!Array.isArray(d.articles) || !d.articles.length) d.articles = JSON.parse(JSON.stringify(DEFAULTS.articles));
      if (!Array.isArray(d.calcServices) || !d.calcServices.length) d.calcServices = JSON.parse(JSON.stringify(DEFAULTS.calcServices));
      if (Array.isArray(d.specialists)) d.specialists = d.specialists.map(s => ({ about: '', feats: [], videos: [], mediaCats: [], photo: '', links: [], ...(DEFAULTS.specialists.find(x => x.id === s.id) || {}), ...s }));
      if (!Array.isArray(d.mediaCats)) d.mediaCats = JSON.parse(JSON.stringify(DEFAULTS.mediaCats));
      if (!Array.isArray(d.categories) || !d.categories.length) d.categories = JSON.parse(JSON.stringify(DEFAULTS.categories));
      return d;
    }
  } catch (e) { console.warn('loadData', e); }
  return JSON.parse(JSON.stringify(DEFAULTS));
}
export function saveData(d) { localStorage.setItem(STORE_KEY, JSON.stringify(d)); }
export function tgUrl(handle) { return 'https://t.me/' + String(handle || '').replace(/^@/, ''); }
