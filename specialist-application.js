import { DEFAULTS, EVENT_TYPES } from '/data.js';

const admin = location.pathname.startsWith('/admin/');
const token = location.hash.slice(1);
const api = admin ? '/admin/specialist-applications/api' : '/api/specialist-application';
const content = document.querySelector('#content');
const title = document.querySelector('#title');
const intro = document.querySelector('#intro');
const message = document.querySelector('#message');
const statuses = {
  open: 'Ждёт заполнения', pending: 'На модерации', published: 'Опубликована',
  rejected: 'Отклонена', cancelled: 'Ссылка отозвана', expired: 'Срок ссылки истёк',
};

function element(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return Object.assign(node, attrs);
}

function button(text, handler, primary = false) {
  const node = element('button', text, { type: 'button', className: primary ? 'primary' : '' });
  if (handler) node.addEventListener('click', handler);
  return node;
}

async function request(action, body, key = token) {
  const url = new URL(api, location.origin);
  if (key) url.searchParams.set('token', key);
  if (action) url.searchParams.set('action', action);
  const response = await fetch(url, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
  });
  if (!response.ok) {
    const errors = {
      400: 'Проверьте поля, фото и ссылки. Ссылки должны начинаться с https:// или http://.',
      404: 'Ссылка не найдена. Проверьте адрес или попросите редактора прислать новую ссылку.',
      409: 'Статус анкеты изменился. Обновите страницу.',
      413: 'Слишком много фотографий. Уберите несколько снимков и повторите отправку.',
    };
    throw new Error(errors[response.status] || 'Не удалось связаться с сайтом. Попробуйте ещё раз.');
  }
  return response.json();
}

const invitation = key => location.origin + '/anketa-specialista#' + key;
const adminUrl = '/admin/specialist-applications/';

async function copyInvitation(key, container) {
  const url = invitation(key);
  try {
    await navigator.clipboard.writeText(url);
    message.textContent = 'Ссылка скопирована.';
  } catch {
    const field = element('input', '', { value: url, readOnly: true, ariaLabel: 'Ссылка для специалиста' });
    container.append(field);
    field.select();
    message.textContent = 'Скопируйте выделенную ссылку.';
  }
}

async function showQueue() {
  title.textContent = 'Анкеты специалистов';
  intro.textContent = 'Создайте ссылку для специалиста. Она действует 14 дней и принимает одну заявку.';
  const { records } = await request();
  content.replaceChildren();
  const tools = element('div', '', { className: 'actions' });
  tools.append(button('Создать ссылку', async e => {
    e.currentTarget.disabled = true;
    try {
      const record = await request('create', '{}');
      await showQueue();
      await copyInvitation(record.token, content);
    } catch (error) { message.textContent = error.message; }
    finally { tools.firstChild.disabled = false; }
  }, true), button('Обновить список', () => showQueue().catch(error => { message.textContent = error.message; })));
  content.append(tools);
  if (!records.length) content.append(element('p', 'Анкет пока нет.', { className: 'panel' }));
  records.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
  for (const record of records) {
    const row = element('section', '', { className: 'panel' });
    row.append(element('h2', record.name || 'Приглашение'),
      element('p', statuses[record.status] + ' · ' + new Date(record.created).toLocaleDateString('ru-RU')));
    const actions = element('div', '', { className: 'actions' });
    if (record.status === 'open') {
      actions.append(button('Скопировать ссылку', () => copyInvitation(record.token, actions)),
        button('Отозвать', async e => {
          if (!confirm('Отозвать эту ссылку?')) return;
          const target = e.currentTarget;
          target.disabled = true;
          try { await request('cancel', '{}', record.token); await showQueue(); }
          catch (error) { message.textContent = error.message; }
          finally { target.disabled = false; }
        }));
    }
    if (record.status === 'pending') actions.append(element('a', 'Проверить анкету', {
      href: adminUrl + '#' + record.token, className: 'button primary',
    }));
    if (record.specId) actions.append(element('a', 'Открыть карточку', {
      href: '/specialist.html?id=' + encodeURIComponent(record.specId),
    }));
    row.append(actions);
    content.append(row);
  }
}

async function resizePhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1400 / Math.max(image.width, image.height));
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const value = canvas.toDataURL('image/jpeg', .8);
    if (!value.startsWith('data:image/jpeg;base64,') || value.length > 950000) throw new Error('size');
    return value;
  } catch {
    throw new Error('Не удалось обработать фото. Выберите файл JPG, PNG или WebP.');
  } finally { URL.revokeObjectURL(url); }
}

function profileEditor(label, initial, categories, general, form, generalName) {
  const pane = element('fieldset');
  pane.append(element('legend', label));
  const hero = element('div', '', { className: 'hero' });
  const imageArea = element('div');
  const portrait = element('div', '', { className: 'portrait' });
  const heroCopy = element('div', '', { className: 'hero-copy' });
  const heroName = element('h3');
  const heroRole = element('p');
  heroCopy.append(heroName, heroRole);
  hero.append(imageArea, heroCopy);
  pane.append(hero);
  const fields = {};
  const grid = element('div', '', { className: 'fields' });
  const field = (key, label, maxLength, required = false, multiline = false) => {
    const control = element(multiline ? 'textarea' : 'input', '', { required, maxLength, value: initial[key] || '' });
    if (multiline) control.rows = key === 'about' ? 5 : 3;
    const wrap = element('label', label, { className: multiline ? 'wide' : '' });
    wrap.append(control);
    grid.append(wrap);
    fields[key] = control;
    return control;
  };
  const name = general ? field('name', 'Имя или название команды', 100, true) : generalName;
  const role = field('role', 'Роль или жанр', 120, true);
  const updateHero = () => {
    heroName.textContent = name.value.trim() || 'Имя специалиста';
    heroRole.textContent = role.value.trim() || 'Роль или жанр';
  };
  name.addEventListener('input', updateHero);
  role.addEventListener('input', updateHero);
  updateHero();
  const select = (key, label) => {
    const control = element('select');
    const wrap = element('label', label);
    wrap.append(control);
    grid.append(wrap);
    fields[key] = control;
    return control;
  };
  const category = select('cat', 'Категория');
  category.required = true;
  category.append(new Option('Выберите категорию', ''), ...categories.map(c => new Option(c.name, c.slug)));
  category.value = initial.cat || '';
  const subcat = select('subcat', 'Подгруппа');
  const updateSubcat = value => {
    const list = categories.find(c => c.slug === category.value)?.subcats || [];
    subcat.replaceChildren(new Option('Без подгруппы', ''), ...list.map(c => new Option(c.name, c.slug)));
    subcat.value = list.some(c => c.slug === value) ? value : '';
    subcat.parentElement.hidden = !list.length;
  };
  updateSubcat(initial.subcat);
  category.addEventListener('change', () => updateSubcat(''));
  field('exp', 'Опыт', 80);
  field('price', 'Стоимость', 100);
  field('about', 'О себе и своей работе', 4000, true, true);
  field('feats', 'Достижения и особенности, по одному на строку', 2500, false, true);
  field('videos', 'Ссылки на видео, по одной на строку', 3000, false, true);
  field('links', 'Ссылки на портфолио, по одной на строку', 3000, false, true);
  pane.append(grid);

  let photo = initial.photo || '';
  let photos = [...(initial.photos || [])];
  const gallery = element('div', '', { className: 'gallery' });
  const portraitPicker = element('input', '', { type: 'file', accept: 'image/jpeg,image/png,image/webp' });
  const galleryPicker = element('input', '', { type: 'file', accept: portraitPicker.accept, multiple: true });
  const removePortrait = button('Убрать фото', () => { photo = ''; renderPhotos(); });
  const renderPhotos = () => {
    portrait.replaceChildren(photo ? element('img', '', { src: photo, alt: 'Фото профиля' }) :
      element('span', general ? 'Фото профиля' : 'Фото из общей анкеты'));
    portraitPicker.required = general && !photo;
    removePortrait.hidden = !photo;
    gallery.replaceChildren(...photos.map((src, i) => {
      const item = element('div');
      const remove = button('×', () => { photos.splice(i, 1); renderPhotos(); });
      remove.ariaLabel = 'Убрать фото ' + (i + 1);
      item.append(element('img', '', { src, alt: 'Фото портфолио ' + (i + 1) }), remove);
      return item;
    }));
  };
  const pick = (input, multiple) => input.addEventListener('change', async () => {
    const files = [...input.files];
    if (!files.length) return;
    if (multiple && photos.length + files.length > 6) {
      input.value = '';
      message.textContent = 'В одном профиле можно добавить до 6 фотографий портфолио.';
      return;
    }
    form.processing++;
    input.disabled = true;
    message.textContent = 'Подготавливаем фотографии…';
    try {
      const images = [];
      for (const file of files) images.push(await resizePhoto(file));
      if (multiple) photos.push(...images);
      else photo = images[0];
      renderPhotos();
      message.textContent = '';
    } catch (error) { message.textContent = error.message; }
    finally { input.value = ''; input.disabled = false; form.processing--; }
  });
  const portraitLabel = element('label', general ? 'Загрузить фото профиля' : 'Другое фото для этого раздела');
  portraitLabel.append(portraitPicker);
  imageArea.append(portrait, portraitLabel, removePortrait);
  const galleryLabel = element('label', 'Фото портфолио');
  galleryLabel.append(galleryPicker);
  pane.append(galleryLabel, element('small', 'До 6 фотографий на профиль. JPG, PNG или WebP.'), gallery);
  pick(portraitPicker, false);
  pick(galleryPicker, true);
  renderPhotos();
  return { pane, name, values: () => ({
    ...Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()])), photo, photos,
  }) };
}

function showForm(profile, categories) {
  title.textContent = admin ? 'Модерация анкеты' : 'Ваша карточка специалиста';
  intro.textContent = admin
    ? 'Проверьте карточку и выбранные направления. Можно отредактировать данные и фотографии перед публикацией.'
    : 'Заполните общий профиль и отметьте, в каких разделах каталога показывать вашу карточку.';
  const form = element('form');
  form.processing = 0;
  const general = profileEditor('Общий профиль', profile?.general || {}, categories, true, form);
  form.append(general.pane);
  const section = element('fieldset');
  section.append(element('legend', 'Направления'));
  const events = EVENT_TYPES.map(event => {
    const current = profile?.events[event.id];
    const enabled = element('input', '', { type: 'checkbox', checked: !!current });
    const separate = element('input', '', { type: 'checkbox', checked: !!current && current !== true });
    const eventLabel = element('label', event.name);
    const separateLabel = element('label', 'Заполнить отдельный профиль');
    eventLabel.prepend(enabled);
    separateLabel.prepend(separate);
    const group = element('div', '', { className: 'panel' });
    group.append(eventLabel, separateLabel);
    let editor;
    const update = () => {
      separateLabel.hidden = !enabled.checked;
      const visible = enabled.checked && separate.checked;
      if (visible && !editor) {
        const { photo, photos, ...fields } = general.values();
        editor = profileEditor(event.name, current && current !== true ? current : fields, categories, false, form, general.name);
        group.append(editor.pane);
      }
      if (editor) {
        editor.pane.hidden = !visible;
        editor.pane.disabled = !visible;
      }
    };
    enabled.addEventListener('change', update);
    separate.addEventListener('change', update);
    update();
    section.append(group);
    return { id: event.id, value: () => enabled.checked && (separate.checked ? editor.values() : true) };
  });
  form.append(section);
  const contact = element('input', '', { required: true, maxLength: 160, value: profile?.contact || '' });
  const contactLabel = element('label', 'Контакт для редактора');
  contactLabel.append(contact, element('small', 'Телефон, email или Telegram. Видит только редактор.'));
  const contactPanel = element('div', '', { className: 'panel' });
  contactPanel.append(contactLabel);
  const consentCheck = element('input', '', { type: 'checkbox', required: true });
  if (!admin) {
    const consent = element('label', 'Разрешаю опубликовать данные карточки и загруженные фотографии после проверки.');
    consent.prepend(consentCheck);
    contactPanel.append(consent, element('a', 'Политика конфиденциальности', { href: '/privacy.html', target: '_blank', rel: 'noopener' }));
  }
  form.append(contactPanel);
  const actions = element('div', '', { className: 'actions' });
  const submit = button(admin ? 'Опубликовать карточку' : 'Отправить на модерацию', null, true);
  submit.type = 'submit';
  actions.append(submit);
  if (admin) actions.append(button('Отклонить', async () => {
    if (!confirm('Отклонить анкету и удалить её материалы?')) return;
    await finish('reject', '{}');
  }), element('a', 'К списку анкет', { href: adminUrl }));
  form.append(actions);
  content.replaceChildren(form);

  async function finish(action, body) {
    for (const control of actions.querySelectorAll('button')) control.disabled = true;
    message.textContent = admin ? 'Сохраняем решение…' : 'Отправляем анкету…';
    try {
      const result = await request(action, body);
      content.replaceChildren();
      message.textContent = '';
      title.textContent = admin ? (result.specId ? 'Карточка опубликована' : 'Анкета отклонена') : 'Анкета отправлена';
      intro.textContent = admin ? '' : 'Редактор проверит данные и опубликует карточку после одобрения.';
      if (result.specId) content.append(element('a', 'Открыть карточку на сайте', {
        href: '/specialist.html?id=' + encodeURIComponent(result.specId),
      }), element('br'));
      if (admin) content.append(element('a', 'К списку анкет', { href: adminUrl }));
    } catch (error) { message.textContent = error.message; }
    finally { for (const control of actions.querySelectorAll('button')) control.disabled = false; }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled) return;
    if (form.processing) { message.textContent = 'Дождитесь подготовки фотографий.'; return; }
    if (admin && !confirm('Опубликовать карточку на сайте?')) return;
    const body = JSON.stringify({
      general: general.values(), contact: contact.value.trim(),
      consent: consentCheck.checked,
      events: Object.fromEntries(events.map(event => [event.id, event.value()])),
    });
    if (new Blob([body]).size > 10 * 1024 * 1024) {
      message.textContent = 'Слишком много фотографий. Уберите несколько снимков и повторите отправку.';
      return;
    }
    await finish(admin ? 'publish' : 'submit', body);
  });
}

async function init() {
  document.querySelector('#admin-back').hidden = !admin;
  content.replaceChildren();
  message.textContent = '';
  if (admin && !location.hash) return showQueue();
  if (!/^[0-9a-f]{48}$/.test(token)) throw new Error('Откройте полную ссылку, которую прислал редактор.');
  const record = await request();
  if (record.status !== (admin ? 'pending' : 'open')) {
    title.textContent = statuses[record.status];
    intro.textContent = record.status === 'pending' ? 'Анкета уже отправлена редактору.' : '';
    if (admin) content.append(element('a', 'К списку анкет', { href: adminUrl }));
    return;
  }
  if (!admin) intro.textContent = 'Загружаем анкету…';
  const response = await fetch('/api/data', { cache: 'no-store' });
  if (!response.ok) throw new Error('Не удалось загрузить категории. Обновите страницу.');
  const data = await response.json();
  showForm(record.profile, data.categories || DEFAULTS.categories);
}

init().catch(error => { message.textContent = error.message; });
window.addEventListener('hashchange', () => location.reload());
