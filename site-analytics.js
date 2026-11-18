// Anonymous interaction events for Yandex Metrika. Never send form field values.
(function () {
  const counter = 111261477;
  const direction = location.pathname.startsWith('/svadby') ? 'wedding'
    : location.pathname.startsWith('/korporativy') ? 'corporate'
    : location.pathname.startsWith('/prazdniki-i-shou') ? 'entertainment' : 'general';
  const pending = [];

  function flush() {
    if (typeof window.ym !== 'function') return;
    while (pending.length) {
      const [goal, details] = pending.shift();
      try {
        window.ym(counter, 'reachGoal', goal, { event: details });
      } catch (_) {
        // Analytics must never interrupt navigation or a successful request.
      }
    }
  }

  function track(goal, details) {
    pending.push([goal, details || {}]);
    flush();
  }

  window.siteAnalytics = { track, direction };
  document.addEventListener('DOMContentLoaded', flush, { once: true });
  window.addEventListener('load', flush, { once: true });

  document.addEventListener('click', function (event) {
    const link = event.target.closest && event.target.closest('a[href]');
    if (!link) return;
    const url = new URL(link.href, location.href);
    if (url.origin === location.origin) {
      if (location.pathname === '/' || location.pathname === '/index.html') {
        const chosen = { '/svadby': 'wedding', '/korporativy': 'corporate', '/prazdniki-i-shou': 'entertainment' }[url.pathname];
        if (chosen) track('direction_select', { direction: chosen });
      }
      const specialistId = url.searchParams.get('specialist');
      if (specialistId && url.hash === '#zayavka') {
        track('profile_contact', { specialist_id: specialistId, direction, action: 'open_form' });
      }
      return;
    }
    if (!/\/specialist\.html$/.test(location.pathname)) return;
    const specialistId = new URLSearchParams(location.search).get('id');
    if (!specialistId) return;
    const channel = url.protocol === 'tel:' ? 'phone'
      : url.hostname === 't.me' ? 'telegram'
      : /(^|\.)max\.ru$/.test(url.hostname) ? 'max' : '';
    if (channel) track('profile_contact', { specialist_id: specialistId, direction, action: 'contact_click', channel });
  }, { capture: true });
})();
