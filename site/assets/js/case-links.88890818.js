/* Ссылки «Смотреть проект ↗» в кейсах, где их нет в данных CMS (там одно поле под одну ссылку,
   а здесь бывает и две). Блок ставится после описания кейса, в той же разметке, что и у кейсов
   со ссылкой из CMS. Чтобы добавить: слаг → список [подпись RU, подпись EN, адрес]. */
(() => {
  const LINKS = {
    'vk-dating': [['Смотреть проект ↗', 'View project ↗', '/web-projects/vk-dating']],
    'fandom-fest': [
      ['Смотреть проект (v1) ↗', 'View project (v1) ↗', '/web-projects/vk-fandom-fest/v1'],
      ['Смотреть проект (v2) ↗', 'View project (v2) ↗', '/web-projects/vk-fandom-fest/v2'],
    ],
  };
  const tick = () => {
    const m = location.pathname.match(/^(\/en)?\/projects\/([^/]+)\/?$/);
    const links = m && LINKS[m[2]];
    document.querySelectorAll('[data-case-links]').forEach((el) => {
      if (!links || el.dataset.caseLinks !== m[0]) el.remove();   // остался от другого кейса после перехода
    });
    if (!links) return;
    document.querySelectorAll('[data-framer-name="Summary"]').forEach((sum) => {
      if (!sum.offsetParent) return;
      const next = sum.nextElementSibling;
      if (next && (next.hasAttribute('data-case-links') || /↗/.test(next.textContent))) return;
      const box = document.createElement('div');
      box.className = 'framer-e4xd31';
      box.dataset.caseLinks = m[0];
      box.dataset.framerComponentType = 'RichTextContainer';
      box.style.transform = 'none';
      box.style.maxWidth = '100%'; box.style.whiteSpace = 'normal'; box.style.width = 'auto';
      const h = document.createElement('h6');
      h.className = 'framer-text framer-styles-preset-1n2ye3x';
      h.dataset.stylesPreset = 'WGr_GPQz5';
      h.dir = 'auto';
      h.style.whiteSpace = 'normal';
      h.style.setProperty('--framer-text-color', 'var(--token-73d49074-7cb1-4544-8200-13a6de5ede41, rgb(0, 22, 102))');
      const code = document.createElement('code');
      code.className = 'framer-text';
      links.forEach(([ru, en, href], i) => {
        if (i) code.appendChild(document.createTextNode(' • '));
        const a = document.createElement('a');
        a.className = 'framer-text framer-styles-preset-vsqe2c';
        a.dataset.stylesPreset = 'iukXfWOcj';
        a.href = href;
        a.textContent = m[1] ? en : ru;
        a.style.whiteSpace = 'nowrap';
        code.appendChild(a);
      });
      h.appendChild(code); box.appendChild(h);
      sum.after(box);
    });
  };
  const start = () => { tick(); setInterval(tick, 500); };
  if (document.readyState === 'complete') setTimeout(start, 800); else addEventListener('load', () => setTimeout(start, 800));
})();
