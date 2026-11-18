// Anonymous interaction events for Yandex Metrika and Google Analytics. Never send form field values.
(function () {
  const counter = 111261477;
  const googleMeasurementId = 'G-82BRBRPK9N';
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  window.gtag('js', new Date());
  window.gtag('config', googleMeasurementId);
  const googleTag = document.createElement('script');
  googleTag.async = true;
  googleTag.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(googleMeasurementId);
  document.head.appendChild(googleTag);
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
    const anonymousDetails = details || {};
    pending.push([goal, anonymousDetails]);
    flush();
    try {
      window.gtag('event', goal, { ...anonymousDetails, send_to: googleMeasurementId });
    } catch (_) {
      // Analytics must never interrupt navigation or a successful request.
    }
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
