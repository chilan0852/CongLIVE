#!/usr/bin/env bash
# CongLive local LAN host (PC runs Docker; phones connect over Wi-Fi).
# Usage: bash local/start.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
command -v docker >/dev/null || { echo "需要 Docker Desktop（或 docker + compose 插件）" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "需要 docker compose v2" >&2; exit 1; }

# Pick the first non-loopback IPv4 address. Override with LOCAL_IP=192.168.x.x.
LAN_IP="${LOCAL_IP:-}"
if [ -z "$LAN_IP" ]; then
  if command -v ip >/dev/null 2>&1; then
    LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
fi
if [ -z "$LAN_IP" ] && command -v ipconfig >/dev/null 2>&1; then
  LAN_IP="$(ipconfig 2>/dev/null | awk '/IPv4/{print $NF; exit}' | tr -d '\r')"
fi
LAN_IP="${LAN_IP:-127.0.0.1}"

ENV_FILE=local/.env.local
if [ ! -f "$ENV_FILE" ]; then
  echo "生成 $ENV_FILE …"
  random() { node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))"; }
  cat > "$ENV_FILE" <<CFG
PUBLIC_HOST=$LAN_IP
CANDIDATE=$LAN_IP
PUBLIC_API_SCHEME=http
PUBLIC_API_PORT=8081
API_BIND=127.0.0.1
WEB_BIND=0.0.0.0
RTC_BIND=0.0.0.0
WEB_PORT=8081
SRS_HTTP_BIND=127.0.0.1
JWT_SECRET=$(random)
MYSQL_ROOT_PASSWORD=$(random)
MYSQL_PASSWORD=$(random)
SRS_HOOK_SECRET=$(random)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$(random)
TURN_SECRET=
CFG
else
  # Keep the user's stored settings, but follow the current LAN address.
  sed -i.bak "s/^PUBLIC_HOST=.*/PUBLIC_HOST=$LAN_IP/; s/^CANDIDATE=.*/CANDIDATE=$LAN_IP/" "$ENV_FILE"
  rm -f "$ENV_FILE.bak"
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
mkdir -p server/covers server/recordings server/plugin-data
# SRS template requires the hook secret/candidate at runtime.
sed -e "s|\$CANDIDATE|${CANDIDATE}|g" -e "s|\$SRS_HOOK_SECRET|${SRS_HOOK_SECRET}|g" \
  server/srs.conf > server/srs.runtime.conf
chmod 644 server/srs.runtime.conf
grep -qE '\$(CANDIDATE|SRS_HOOK_SECRET)' server/srs.runtime.conf && { echo "SRS 配置变量未替换" >&2; exit 1; }

docker compose -p conglive-local --env-file "$ENV_FILE" -f server/docker-compose.yml up -d --build mysql srs backend web
echo
echo "CongLive 本地主机已启动"
echo "  电脑/手机访问：http://$LAN_IP:${WEB_PORT:-8081}"
echo "  管理员：$ADMIN_USERNAME / $ADMIN_PASSWORD"
echo "  SRS 媒体端口：8000/tcp+udp；手机需与 PC 同一 Wi-Fi，并在防火墙放行 8081/8000。"
echo "  停止：docker compose -p conglive-local --env-file $ENV_FILE -f server/docker-compose.yml down"
