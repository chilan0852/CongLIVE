#!/usr/bin/env bash
# Copy Caddy's Let's Encrypt certificate for the web domain into coturn and
# enable TURN over TLS on port 5349. Run after Caddy has issued the certificate:
#   sudo bash server/sync-turn-cert.sh
# Add a daily cron entry to pick up renewals:
#   0 3 * * * cd /opt/conglive/server && ./sync-turn-cert.sh >> /var/log/conglive-turn-cert.log 2>&1
set -euo pipefail
cd "$(dirname "$0")"

DOMAIN="${TURN_CERT_DOMAIN:-$(grep -E '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)}"
DOMAIN="${DOMAIN:-xinglan.work}"
CERT_DIR="$PWD/turn-certs"
mkdir -p "$CERT_DIR"

CRT_PATH=$(docker exec conglive-caddy sh -c "find /data/caddy/certificates -type f -path '*/$DOMAIN/$DOMAIN.crt' 2>/dev/null | head -1")
KEY_PATH=$(docker exec conglive-caddy sh -c "find /data/caddy/certificates -type f -path '*/$DOMAIN/$DOMAIN.key' 2>/dev/null | head -1")
if [ -z "$CRT_PATH" ] || [ -z "$KEY_PATH" ]; then
  echo "Caddy certificate for $DOMAIN not found yet (is the https profile running?)" >&2
  exit 1
fi
docker cp "conglive-caddy:$CRT_PATH" "$CERT_DIR/turn.crt"
docker cp "conglive-caddy:$KEY_PATH" "$CERT_DIR/turn.key"
chown -R 65534:65534 "$CERT_DIR"
chmod 750 "$CERT_DIR"
chmod 644 "$CERT_DIR/turn.crt"
chmod 640 "$CERT_DIR/turn.key"

# Patch the generated runtime config (never the committed template).
if [ ! -s turn.runtime.conf ]; then
  echo "turn.runtime.conf is missing; run server/install.sh first" >&2
  exit 1
fi
sed -i '/^no-tls$/d' turn.runtime.conf
sed -i '/^tls-listening-port=/d;/^cert=/d;/^pkey=/d' turn.runtime.conf
cat >> turn.runtime.conf <<'CFG'

# TLS for networks that only allow TLS. Certificate is synced from Caddy.
tls-listening-port=5349
cert=/etc/coturn/certs/turn.crt
pkey=/etc/coturn/certs/turn.key
CFG

# Advertise turns: to clients and recreate backend/coturn with the new env.
if grep -q '^TURN_TLS=' .env; then
  sed -i 's/^TURN_TLS=.*/TURN_TLS=1/' .env
else
  echo 'TURN_TLS=1' >> .env
fi
if grep -q '^TURN_TLS_PORT=' .env; then
  sed -i 's/^TURN_TLS_PORT=.*/TURN_TLS_PORT=5349/' .env
else
  echo 'TURN_TLS_PORT=5349' >> .env
fi
docker compose up -d coturn backend >/dev/null
echo "TURN TLS enabled on turns:$DOMAIN:5349?transport=tcp"
