// Анимации сайта: scroll-reveal + count-up. Уважает prefers-reduced-motion.
export function setupAnimations() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const ease = 'cubic-bezier(.22,.61,.36,1)';
  const io = window.__revIO || (window.__revIO = new IntersectionObserver(entries => {
    entries.forEach(en => {
      if (!en.isIntersecting) return;
      const el = en.target; window.__revIO.unobserve(el);
      const d = +(el.dataset.revd || 0);
      setTimeout(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; }, d);
      setTimeout(() => { el.style.removeProperty('opacity'); el.style.removeProperty('transform'); el.style.removeProperty('transition'); }, d + 900);
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -36px 0px' }));
  document.querySelectorAll('section').forEach(sec => {
    const targets = [];
    sec.querySelectorAll('h2').forEach(h => targets.push([h, 0]));
    sec.querySelectorAll('div').forEach(dv => {
      if (dv.style.display !== 'grid') return;
      if (dv.parentElement && dv.parentElement.closest('[data-revgrid]')) return;
      dv.setAttribute('data-revgrid', '1');
      Array.prototype.forEach.call(dv.children, (ch, i) => targets.push([ch, Math.min(i, 7) * 75]));
    });
    sec.querySelectorAll('details').forEach((dt, i) => targets.push([dt, Math.min(i, 7) * 55]));
    targets.forEach(([el, d]) => {
      if (el.dataset.rev) return; el.dataset.rev = '1'; el.dataset.revd = String(d);
      if (el.getBoundingClientRect().top < window.innerHeight * 0.92) return;
      el.style.opacity = '0'; el.style.transform = 'translateY(26px)';
      el.style.transition = 'opacity .7s ' + ease + ', transform .7s ' + ease;
      io.observe(el);
    });
  });
  document.querySelectorAll('[data-count]').forEach(el => {
    if (el.dataset.counted) return; el.dataset.counted = '1';
    const target = parseFloat(el.dataset.count), suf = el.dataset.suffix || '', dur = 1200;
    const t0 = performance.now();
    const tick = t => {
      const p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e) + suf;
      if (p < 1) requestAnimationFrame(tick); else el.textContent = el.dataset.count + suf;
    };
    requestAnimationFrame(tick);
  });
}
