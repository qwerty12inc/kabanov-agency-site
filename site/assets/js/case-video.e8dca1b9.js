/* Кейсы, где вместо главной картинки идёт свой ролик: без звука, по кругу, запускается сам.
   Ролик кладётся поверх картинки (она остаётся в HTML — для поисковиков и как заставка).
   Чтобы добавить кейс: слаг → файлы в /assets/videos (mp4 H.264 16:9 без звука + первый кадр jpg). */
(() => {
  const VIDEOS = {
    'ai-kv-new-year': { src: '/assets/videos/vk-ng-kv.4cf0cd36.mp4', poster: '/assets/videos/vk-ng-kv.4e0e554c.jpg' },
  };
  const tick = () => {
    const m = location.pathname.match(/\/projects\/([^/]+)\/?$/);
    const v = m && VIDEOS[m[1]];
    if (!v) return;
    document.querySelectorAll('[data-framer-name="Project Image"]').forEach((box) => {
      if (box.querySelector('video[data-case-video]') || !box.offsetParent) return;
      const el = document.createElement('video');
      el.dataset.caseVideo = '';
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
