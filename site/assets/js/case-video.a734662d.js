/* Кейсы, где вместо главной картинки идёт свой ролик: без звука, по кругу, запускается сам.
   Ролик кладётся поверх картинки (она остаётся в HTML — для поисковиков и как заставка).
   Чтобы добавить кейс: слаг → файлы в /assets/videos (mp4 H.264 без звука + кадр-заставка jpg).
   mobile — необязательный отдельный вариант для телефона (до 810px): свой файл и пропорции блока. */
(() => {
  const VIDEOS = {
    'ai-kv-new-year': { src: '/assets/videos/vk-ng-kv.4cf0cd36.mp4', poster: '/assets/videos/vk-ng-kv.4e0e554c.jpg' },
    'ai-kv-rk': {
      src: '/assets/videos/vk-ai-rk-wide.74002212.mp4', poster: '/assets/videos/vk-ai-rk-wide.7e897f75.jpg',
      mobile: { src: '/assets/videos/vk-ai-rk-tall.12438628.mp4', poster: '/assets/videos/vk-ai-rk-tall.3649837e.jpg', ratio: '972 / 1080' },
    },
  };
  const phone = matchMedia('(max-width: 809.98px)');
  const clear = (box) => {
    const old = box.querySelector('video[data-case-video]');
    if (!old) return;
    old.pause(); old.remove();
    box.style.aspectRatio = ''; box.style.height = '';
  };
  const tick = () => {
    const m = location.pathname.match(/\/projects\/([^/]+)\/?$/);
    const cfg = m && VIDEOS[m[1]];
    const v = cfg && (phone.matches && cfg.mobile ? cfg.mobile : cfg);
    document.querySelectorAll('[data-framer-name="Project Image"]').forEach((box) => {
      const cur = box.querySelector('video[data-case-video]');
      if (!v) return clear(box);                       // другой кейс в том же блоке (переход без перезагрузки)
      if (cur && cur.dataset.caseVideo === v.src) return;
      clear(box);
      if (!box.offsetParent) return;
      if (v.ratio) { box.style.aspectRatio = v.ratio; box.style.height = 'auto'; }
      const el = document.createElement('video');
      el.dataset.caseVideo = v.src;
      el.muted = true; el.defaultMuted = true; el.loop = true; el.autoplay = true; el.playsInline = true;
      el.setAttribute('muted', ''); el.setAttribute('playsinline', ''); el.setAttribute('aria-hidden', 'true');
      el.preload = 'auto'; el.poster = v.poster; el.src = v.src;
      el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:inherit;pointer-events:none';
      box.appendChild(el);
      const p = el.play(); if (p && p.catch) p.catch(() => {});
    });
  };
  tick(); setInterval(tick, 500);
})();
