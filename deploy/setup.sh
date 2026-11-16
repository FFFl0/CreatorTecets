#!/usr/bin/env bash
# Установка CreatorTecets на чистый сервер Ubuntu/Debian.
#   Без домена:  sudo bash setup.sh
#   С доменом:   sudo DOMAIN=tickets.example.ru bash setup.sh
#   Администратор: добавьте ADMIN_EMAILS=you@example.ru (иначе — первый зарегистрированный)
#   Политика конфиденциальности: SITE_OPERATOR="Иванов Иван Иванович" SITE_CONTACT_EMAIL=pd@example.ru
#   Реклама РСЯ:   YANDEX_RTB_SIDEBAR=R-A-…-1 YANDEX_RTB_BOTTOM=R-A-…-2 YANDEX_METRIKA_ID=…
set -euo pipefail

REPO="${REPO:-https://github.com/FFFl0/CreatorTecets.git}"
BRANCH="${BRANCH:-ccr-cc297434-iob7x1}"
DIR="${DIR:-/opt/creatortecets}"

if [ "$(id -u)" -ne 0 ]; then echo "Запустите через sudo"; exit 1; fi

echo "==> Обновление пакетов и установка git"
apt-get update -y
apt-get install -y git curl ca-certificates

# На серверах с 1 ГБ памяти сборке образа нужен файл подкачки.
if [ "$(swapon --show | wc -l)" -eq 0 ]; then
  echo "==> Создание файла подкачки 2 ГБ"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

if ! command -v docker >/dev/null; then
  echo "==> Установка Docker"
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Загрузка приложения в $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull --ff-only
else
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

echo "==> Сборка и запуск (первый раз — несколько минут)"
: > .env
for var in ADMIN_EMAILS YANDEX_RTB_SIDEBAR YANDEX_RTB_BOTTOM YANDEX_METRIKA_ID SITE_OPERATOR SITE_CONTACT_EMAIL; do
  [ -n "${!var:-}" ] && printf '%s="%s"\n' "$var" "${!var}" >> .env
done
if [ -n "${DOMAIN:-}" ]; then
  echo "DOMAIN=$DOMAIN" >> .env
  docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml up -d --build
  URL="https://$DOMAIN"
else
  docker compose up -d --build
  URL="http://$(curl -fsS https://ipv4.icanhazip.com 2>/dev/null || hostname -I | awk '{print $1}'):8000"
fi

echo "==> Ежедневная резервная копия базы в $DIR/backups (хранится 14 дней)"
mkdir -p "$DIR/backups"
cat > /etc/cron.daily/creatortecets-backup <<CRON
#!/bin/sh
docker exec creatortecets python -c "import sqlite3; s=sqlite3.connect('/data/creatortecets.db'); d=sqlite3.connect('/data/backup.db'); s.backup(d); d.close()" \
  && docker cp creatortecets:/data/backup.db "$DIR/backups/creatortecets-\$(date +%F).db"
find "$DIR/backups" -name '*.db' -mtime +14 -delete
CRON
chmod +x /etc/cron.daily/creatortecets-backup

echo
echo "Готово! Откройте: $URL"
