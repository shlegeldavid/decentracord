# Установка Decentracord

Инструкция разворачивает приложение, PostgreSQL и Caddy на одном VPS. Браузер подключается к Caddy по HTTPS; только Caddy публикует порты. Приложение и PostgreSQL доступны только во внутренней сети Compose.

## Требования

- Linux VPS с Docker Engine и доступом к Docker Compose plugin **2.17.0 или новее**. Минимальная версия нужна для `docker compose up --wait`; проверка этого проекта выполнена с Compose 5.7.0 и Docker Engine 29.9.3.
- DNS-имя, A-запись которого указывает на VPS. Добавляйте AAAA-запись только если VPS принимает IPv6 на тех же портах.
- Входящие TCP-порты 80 и 443. Порт 80 нужен для проверки домена и перенаправления на HTTPS; UDP 443 можно открыть для HTTP/3.
- Свободное место для образов, данных PostgreSQL и сертификатов Caddy.
- Node.js 26.13+ нужен только для локального запуска `scripts/verify-install.mjs`; само приложение работает в контейнере.

## DNS и секрет

В каталоге установки скопируйте пример и укажите реальный DNS-host без схемы и порта. `APP_ORIGIN` должен быть этим же host с `https://` и без завершающего `/`.

```sh
cp .env.example .env
```

Создайте файл пароля PostgreSQL. Каталог секретов исключён из Docker build context и Git; сам файл останется открытым на диске VPS, поэтому ограничьте его права:

```sh
mkdir -p ./secrets
chmod 700 ./secrets
umask 077
openssl rand -hex 32 | tr -d '\n' > ./secrets/db_password
chmod 600 ./secrets/db_password
# Контейнер приложения работает от UID 1000; Compose монтирует файл с его владельцем.
sudo chown 1000:1000 ./secrets/db_password
```

В `.env` задаются только путь к файлу секрета и несекретная конфигурация. Compose подключит пароль как `/run/secrets/db_password`; Caddy не получает доступ к секрету. Compose secrets не шифрует host-файл. Если храните секрет вне каталога установки, укажите абсолютный путь в `DB_PASSWORD_SECRET_FILE`.

Перед запуском проверьте, что `PUBLIC_HOST` и `APP_ORIGIN` совпадают с DNS, а файл из `DB_PASSWORD_SECRET_FILE` существует и имеет права `600`.

## Запуск и bootstrap

Из каталога установки выполните проверку конфигурации и единственную production-команду запуска:

```sh
docker compose -f compose.yaml config --quiet
docker compose -f compose.yaml up -d --build --wait
```

Команда `up` всегда запускает Caddy, app и PostgreSQL. Она ожидает готовность приложения и валидность конфигурации proxy. Caddy сам получает и обновляет сертификат, выполняет HTTP → HTTPS redirect и проксирует Socket.IO polling/WebSocket через `/realtime`. Для этого домен должен уже указывать на VPS, а порты 80/443 должны быть доступны из интернета.

Создайте первого администратора локальной CLI-командой. Пароль вводится через скрытый stdin:

```sh
docker compose -f compose.yaml exec -it app node apps/server/dist/cli.js bootstrap-admin --login LOGIN
```

После bootstrap откройте `https://<PUBLIC_HOST>` и войдите. Проверить состояние контейнеров можно командами:

```sh
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs --tail=100 app proxy db
```

После изменения `.env` повторите `docker compose -f compose.yaml up -d --build --wait`. Если приложение или proxy не готовы, Compose завершится с ошибкой; проверьте DNS, доступность портов и права secret-файла.

## Сетевые и приватные границы

Браузер загружает интерфейс и обращается к API и Socket.IO только с установленного HTTPS-host. Внешние шрифты, CDN, аналитика и автоматический предпросмотр ссылок не используются. Приложение и PostgreSQL находятся во внутренней сети Compose; опубликованных портов у них нет, и для их работы не требуется исходящий доступ в интернет.

Caddy использует исходящий доступ к ACME-центру сертификации для выпуска и обновления TLS-сертификата. Для этого центру передаётся публичное DNS-имя и данные проверки домена; передача сообщений и учётных данных для выдачи сертификата не нужна. TLS завершается на Caddy, который проксирует запросы в приложение по внутренней сети.

Проверки в репозитории запускаются из каталога проекта:

```sh
npm run build
npm run lint
npm run typecheck
npm run test:integration
npm run test:e2e
node scripts/test-tls.mjs --project decentracord-tls-check --spec tests/e2e/tls-session.spec.ts --spec tests/e2e/installation-privacy.spec.ts
```

## Проверка HTTPS

После получения сертификата запустите проверку с узла, который видит публичный адрес:

```sh
TEST_ORIGIN="https://chat.example.com" node scripts/verify-install.mjs
```

Замените пример в `TEST_ORIGIN` на значение `APP_ORIGIN` из `.env`.

Скрипт проверяет TLS обычной проверкой сертификата Node.js, `/healthz`, HTTP redirect и безопасные атрибуты pre-auth CSRF cookie. Он не отключает проверку TLS и не печатает cookie, токен или пароль. Для тестового CA можно передать `NODE_EXTRA_CA_CERTS=/path/to/test-ca.pem` при запуске Node.js.

## Восстановление доступа к сервисам

Приложение и PostgreSQL не имеют опубликованных портов. Не добавляйте им `ports` и не отключайте внутреннюю сеть `backend`; внешний трафик должен поступать через proxy. Host-секреты не помещайте в `.env`, Dockerfile или логи.
