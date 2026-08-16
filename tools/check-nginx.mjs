// Поднимает настоящий nginx с боевым deploy/locations.conf и проверяет правила
// запросами. TLS и редирект на https в тесте не участвуют — проверяются
// маршрутизация, канонизация URL, статусы и заголовки, то есть всё, что можно
// сломать правкой правил.
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const run = promisify(execFile);
const PORT = Number(process.env.PORT || 8899);
const ROOT = resolve('site');
const DIR = resolve('.work/nginx');

const CASES = [
  // [метод-описание, путь, ожидаемый статус, ожидаемый Location (или null)]
  ['корень', '/', 200, null],
  ['корень EN со слэшем', '/en/', 200, null],
  ['EN без слэша → со слэшем', '/en', 301, '/en/'],
  ['страница без слэша', '/projects', 200, null],
  ['страница со слэшем → без', '/projects/', 301, '/projects'],
  ['вложенная страница', '/projects/w24', 200, null],
  ['вложенная со слэшем → без', '/projects/w24/', 301, '/projects/w24'],
  ['категория', '/categories/ui', 200, null],
  ['EN-страница', '/en/projects', 200, null],
  ['EN-страница со слэшем → без', '/en/projects/', 301, '/en/projects'],
  ['EN-проект', '/en/projects/w24', 200, null],
  ['index.html → каноничный вид', '/projects/index.html', 301, '/projects'],
  ['index.html в корне', '/index.html', 301, '/'],
  ['index.html корня EN', '/en/index.html', 301, '/en/'],
  ['index.html EN-страницы', '/en/projects/index.html', 301, '/en/projects'],
  ['несуществующий путь', '/nope', 404, null],
  ['несуществующий вложенный', '/projects/nope', 404, null],
  ['ресурс', '/assets/js/framer.KNQD3WMr.mjs', 200, null],
  ['несуществующий ресурс', '/assets/js/nope.mjs', 404, null],
  ['robots.txt', '/robots.txt', 200, null],
  ['sitemap', '/sitemap.xml', 200, null],
  ['sitemap локали', '/sitemap_ru.xml', 200, null],
  ['выход за корень', '/../../etc/passwd', 404, null],
];

const HEADER_CASES = [
  ['ресурс кэшируется навсегда', '/assets/js/framer.KNQD3WMr.mjs', 'cache-control', /immutable/],
  ['шрифт отдаётся с CORS', '/assets/fonts/gstatic-dmsans-rP2Wp2ywxg089UriCZaSExd86J3t9jz86MvyyKK58VXh.woff2', 'access-control-allow-origin', /\*/],
  ['страница не кэшируется', '/', 'cache-control', /must-revalidate/],
  ['страница с nosniff', '/', 'x-content-type-options', /nosniff/],
  ['html как utf-8', '/', 'content-type', /charset=utf-8/],
  ['mjs как javascript', '/assets/js/framer.KNQD3WMr.mjs', 'content-type', /javascript/],
  ['woff2 как шрифт', '/assets/fonts/gstatic-dmsans-rP2Wp2ywxg089UriCZaSExd86J3t9jz86MvyyKK58VXh.woff2', 'content-type', /font\/woff2/],
  ['jpg как изображение', '/assets/images/OdBnVMdFnIb8X9qySnm70nzssFk.jpg', 'content-type', /image\/jpeg/],
  ['css как стиль', '/assets/vendor/lenis-1.3.17-framer/lenis.css', 'content-type', /text\/css/],
  ['ресурс без двойного Cache-Control', '/assets/js/framer.KNQD3WMr.mjs', 'cache-control', /^public, max-age=31536000, immutable$/],
];

async function main() {
  await rm(DIR, { recursive: true, force: true });
  await mkdir(`${DIR}/logs`, { recursive: true });
  await mkdir(`${DIR}/tmp`, { recursive: true });

  // Отдельный полный конфиг: системный трогать нельзя, а нам нужен свой порт и root.
  const conf = `
daemon off;
pid ${DIR}/nginx.pid;
error_log ${DIR}/logs/error.log warn;
events { worker_connections 64; }
http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log ${DIR}/logs/access.log;
  client_body_temp_path ${DIR}/tmp;
  proxy_temp_path ${DIR}/tmp/proxy;
  fastcgi_temp_path ${DIR}/tmp/fastcgi;
  uwsgi_temp_path ${DIR}/tmp/uwsgi;
  scgi_temp_path ${DIR}/tmp/scgi;
  gzip on;
  gzip_static on;
  server {
    listen 127.0.0.1:${PORT};
    server_name localhost;
    root ${ROOT};
    index index.html;
    charset utf-8;
    include ${resolve('deploy/locations.conf')};
  }
}
`;
  await writeFile(`${DIR}/nginx.conf`, conf);

  await run('nginx', ['-t', '-c', `${DIR}/nginx.conf`]).catch((e) => {
    console.log('конфиг не прошёл проверку:\n', e.stderr || e.message);
    process.exit(1);
  });
  console.log('nginx -t: конфиг валиден');

  const proc = (await import('node:child_process')).spawn('nginx', ['-c', `${DIR}/nginx.conf`], {
    stdio: 'ignore',
    detached: true,
  });
  await new Promise((r) => setTimeout(r, 800));

  let failed = 0;
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (const [name, path, wantStatus, wantLocation] of CASES) {
      const res = await fetch(base + path, { redirect: 'manual' });
      const loc = res.headers.get('location');
      const locPath = loc ? new URL(loc, base).pathname : null;
      const schemeOk = !loc || loc.startsWith('https://');
      const ok = res.status === wantStatus && (wantLocation === null || locPath === wantLocation) && schemeOk;
      if (!ok) failed++;
      console.log(
        `  ${ok ? '✓' : '✗'} ${name.padEnd(34)} ${path.padEnd(30)} ${res.status}` +
          (locPath ? ` → ${locPath}` : '') +
          (ok ? '' : `   ОЖИДАЛОСЬ ${wantStatus}${wantLocation ? ` → ${wantLocation}` : ''}${schemeOk ? '' : ' (схема не https!)'}`),
      );
    }

    console.log('\nзаголовки:');
    for (const [name, path, header, re] of HEADER_CASES) {
      const res = await fetch(base + path);
      const v = res.headers.get(header) || '';
      const ok = re.test(v);
      if (!ok) failed++;
      console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(34)} ${header}: ${v || '(нет)'}`);
    }

    // Отдача предсжатого .gz вместо исходника.
    const gz = await fetch(`${base}/assets/js/framer.KNQD3WMr.mjs`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const enc = gz.headers.get('content-encoding');
    const gzOk = enc === 'gzip';
    if (!gzOk) failed++;
    console.log(`  ${gzOk ? '✓' : '✗'} предсжатый gzip отдаётся${' '.repeat(11)}content-encoding: ${enc || '(нет)'}`);

    // Запрос «из-за CDN»: TLS терминирован снаружи, к серверу пришли по http.
    // Редирект всё равно обязан вести на https, иначе посетитель получит лишний
    // хоп, а при агрессивной настройке CDN — петлю.
    const viaCdn = await fetch(`${base}/projects/`, {
      redirect: 'manual',
      headers: { 'x-forwarded-proto': 'https' },
    });
    const cdnLoc = viaCdn.headers.get('location') || '';
    const cdnOk = viaCdn.status === 301 && cdnLoc.startsWith('https://');
    if (!cdnOk) failed++;
    console.log(`  ${cdnOk ? '✓' : '✗'} редирект за CDN ведёт на https${' '.repeat(7)}${viaCdn.status} → ${cdnLoc || '(нет)'}`);

    // 404 должна отдавать саму страницу, а не пустой ответ.
    const nf = await fetch(`${base}/nope`);
    const body = await nf.text();
    const nfOk = nf.status === 404 && body.includes('<html') && body.length > 1000;
    if (!nfOk) failed++;
    console.log(`  ${nfOk ? '✓' : '✗'} 404 отдаёт страницу${' '.repeat(15)}${nf.status}, ${body.length} байт`);
  } finally {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {}
    await run('pkill', ['-f', `${DIR}/nginx.conf`]).catch(() => {});
  }

  console.log(failed === 0 ? '\n✓ все проверки конфига пройдены' : `\n✗ провалено: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
