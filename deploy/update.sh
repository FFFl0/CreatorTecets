#!/usr/bin/env bash
# Обновление до последней версии из репозитория: sudo bash /opt/creatortecets/deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
if [ -f .env ] && grep -q "^DOMAIN=" .env; then
  docker compose -f docker-compose.yml -f deploy/docker-compose.https.yml up -d --build
else
  docker compose up -d --build
fi
docker image prune -f >/dev/null
echo "Обновлено."
