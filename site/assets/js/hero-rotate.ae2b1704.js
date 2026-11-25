/* Главная: заголовок-герой по очереди показывает направления. Каждый — в две строки.
   Меняем только текст в уже существующих узлах (их держит React), сам <h1> в HTML остаётся «Дизайн поддержка». */
(() => {
  const SETS = {
    ru: [['Дизайн', 'поддержка'], ['ИИ', 'генерации'], ['Моушен', 'дизайн'], ['Веб-дизайн', 'и верстка'], ['Операционные', 'задачи']],
    en: [['Design', 'Support'], ['AI', 'Generation'], ['Motion', 'Design'], ['Web Design', '& Development'], ['Operational', 'Tasks']],
  };
  const HOLD = 2600, FADE = 320;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let i = 0, busy = false;
  const nodes = (h1) => {
    const w = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT), out = [];
    for (let n; (n = w.nextNode());) if (n.data.trim()) out.push(n);
    return out;
  };
  const tick = async () => {
    if (busy || document.hidden) return;
    const path = location.pathname.replace(/\/+$/, '');
    if (path !== '' && path !== '/en') { i = 0; return; }
    const set = SETS[path === '/en' ? 'en' : 'ru'];
    const h1 = document.querySelector('h1');
    if (!h1) return;
    const t = nodes(h1);
    if (t.length !== 2) return;
    const now = [t[0].data.trim(), t[1].data.trim()];
    const at = set.findIndex((s) => s[0] === now[0] && s[1] === now[1]);
    if (at < 0) return;                       // это не наш заголовок (другая страница / другой текст)
    if (at !== i) i = at;                     // React перерисовал исходный текст — продолжаем с него
    const next = set[(i + 1) % set.length];
    busy = true;
    try {
      if (!reduce && h1.animate) await h1.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-12px)' }], { duration: FADE, easing: 'ease-in', fill: 'forwards' }).finished;
      h1.style.whiteSpace = 'nowrap';
      t[0].data = next[0]; t[1].data = next[1];
      h1.style.marginInline = '';
      const over = h1.scrollWidth - h1.clientWidth;   // длинная строка шире колонки — расширяем поровну в обе стороны
      if (over > 0) h1.style.marginInline = -Math.ceil(over / 2) + 'px';
      i = (i + 1) % set.length;
      if (!reduce && h1.animate) {
        h1.getAnimations().forEach((a) => a.cancel());
        await h1.animate([{ opacity: 0, transform: 'translateY(12px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: FADE, easing: 'ease-out' }).finished;
      }
    } catch (e) {} finally { busy = false; }
  };
  setTimeout(() => setInterval(tick, HOLD + 2 * FADE), 1200);
})();
