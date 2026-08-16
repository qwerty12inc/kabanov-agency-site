# Настройка сервера по SSH

## Текущее развёртывание

| | |
|---|---|
| Провайдер | Yandex Cloud, зона `ru-central1-d` |
| Машина | `kabanov-agency-web` (`fv4ebjfsq864e88sq5h8`) |
| Публичный IP | `158.160.179.74`, статический |
| Внутренний IP | `10.130.0.26` |
| ОС | Ubuntu 24.04 LTS |
| Ресурсы | 2 vCPU (доля 5%, Intel Cascade Lake), 1 ГБ RAM, 10 ГБ SSD |
| Пользователь | `deploy`, вход по ключу |
| Группа безопасности | `kabanov-agency-web-sg` — вход 80/443/22 |

Строка для `~/.ssh/config`, дальше в командах используется алиас `kabanov-web`:

```
Host kabanov-web
    HostName 158.160.179.74
    User deploy
    IdentityFile ~/.ssh/id_ed25519_kabanov_web
    IdentitiesOnly yes
```

Последовательность важна: сертификат Let's Encrypt нельзя получить, пока домен
не указывает на сервер и тот не отвечает по HTTP. Поэтому сначала поднимаем сайт
на временном конфиге, потом выпускаем сертификат, и только затем включаем боевой.

Ниже `SERVER_IP` — статический адрес машины. Сжатие делаем на своей машине:
у сервера гарантированная доля процессора 5%, brotli там считался бы очень долго.

## 1. На своей машине: собрать и сжать

```bash
git clone -b claude/framer-site-offline-copy-o0s251 \
  https://github.com/qwerty12inc/kabanov-agency-site.git
cd kabanov-agency-site
node tools/precompress.mjs
```

Зависимости для этого не нужны: скрипт использует только встроенный `node:zlib`.
`npm install` притащил бы Playwright, который нужен лишь для проверок и на
сервере бесполезен.

## 2. На сервере: поставить nginx и подготовить каталоги

```bash
ssh deploy@SERVER_IP

sudo apt update
sudo apt install -y nginx certbot

sudo mkdir -p /var/www/kabanov.agency /var/www/certbot
sudo chown -R deploy:deploy /var/www/kabanov.agency /var/www/certbot
```

Проверьте заодно версию — конфиг рассчитан на неё:

```bash
nginx -v          # ожидается nginx/1.24.x
```

## 3. На своей машине: залить сайт

```bash
rsync -avz --delete site/ deploy@SERVER_IP:/var/www/kabanov.agency/
```

Около 98 МБ вместе с предсжатыми копиями, одна-две минуты.

## 4. На сервере: временный конфиг и проверка по HTTP

```bash
sudo cp ~/kabanov-agency-site/deploy/nginx-bootstrap.conf \
        /etc/nginx/sites-available/kabanov.agency
sudo ln -sf /etc/nginx/sites-available/kabanov.agency /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

Файлы конфигов проще всего забрать тем же rsync или скопировать содержимое
вручную — репозиторий на сервер клонировать не обязательно.

Проверьте, что сайт отвечает по адресу сервера:

```bash
curl -I http://SERVER_IP/
```

Ожидается `200 OK`.

## 5. Направить домен

A-запись `kabanov.agency` и `www.kabanov.agency` → `SERVER_IP`, у текущего
DNS-провайдера домена. Дождитесь, пока запись разойдётся:

```bash
dig +short kabanov.agency
```

Должен вернуться адрес сервера. Дальше не переходите, пока этого не произошло:
проверка Let's Encrypt ходит именно по домену.

## 6. Выпустить сертификат

```bash
sudo certbot certonly --webroot -w /var/www/certbot \
  -d kabanov.agency -d www.kabanov.agency \
  --agree-tos -m info@kdagency.ru --no-eff-email
```

Сертификаты появятся в `/etc/letsencrypt/live/kabanov.agency/`. Автопродление
certbot ставит сам, проверить можно так:

```bash
sudo certbot renew --dry-run
```

## 7. Переключиться на боевой конфиг

```bash
sudo cp deploy/locations.conf /etc/nginx/kabanov-locations.conf
sudo cp deploy/nginx.conf     /etc/nginx/sites-available/kabanov.agency
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` обязателен: он поймает и опечатку, и отсутствующий файл сертификата.

## 8. Проверить результат

```bash
curl -I https://kabanov.agency/                    # 200
curl -I https://kabanov.agency/projects/           # 301 → https://kabanov.agency/projects
curl -I https://kabanov.agency/en                  # 301 → https://kabanov.agency/en/
curl -sI https://kabanov.agency/assets/js/framer.KNQD3WMr.mjs | grep -i content-type
                                                   # text/javascript, НЕ octet-stream
curl -I http://kabanov.agency/                     # 301 на https
```

Последняя проверка про тип `.mjs` — самая важная. Если там окажется
`application/octet-stream`, браузер откажется исполнять модули: страницы
отрисуются, но останутся неживыми.

Полную проверку можно прогнать уже по боевому адресу со своей машины:

```bash
BASE_URL=https://kabanov.agency npm run audit
BASE_URL=https://kabanov.agency npm run check:nav
```

## 9. Сузить доступ по SSH

Порт 22 при создании открыт всему интернету. Узнайте свой адрес
(`curl -s ifconfig.me`) и в консоли Yandex Cloud в группе безопасности
`kabanov-agency-web-sg` замените источник для правила SSH с `0.0.0.0/0` на него.

Если адрес динамический, оставьте как есть, но тогда стоит хотя бы запретить
вход по паролю — впрочем, при входе по ключу он и так отключён в образе.

## Обновление сайта потом

```bash
# на своей машине
git pull
node tools/precompress.mjs
rsync -avz --delete site/ deploy@SERVER_IP:/var/www/kabanov.agency/
```

Перезагружать nginx не нужно — он отдаёт файлы с диска. Учтите только, что
файлы в `/assets` помечены `immutable` на год: их имена содержат хеш сборки,
поэтому при изменениях появляются новые имена, а старые просто перестают
запрашиваться. HTML же помечен `must-revalidate` и подхватится сразу.
