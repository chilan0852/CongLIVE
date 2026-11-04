#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
cd "$SCRIPT_DIR"

log()  { printf '\033[1;32m[CongLive]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[提示]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[错误]\033[0m %s\n' "$*" >&2; exit 1; }

[[ "${EUID}" -eq 0 ]] || die "请使用 root 执行：sudo bash server/install.sh"
[[ -f "$PROJECT_DIR/backend/Dockerfile" && -f "$SCRIPT_DIR/docker-compose.yml" ]] || die "未找到 CongLive 项目文件，请勿单独移动 install.sh。"

. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "当前脚本支持 Ubuntu / Debian。检测到系统：${PRETTY_NAME:-unknown}" ;;
esac

get_env() {
  local key="$1"
  if [[ -f .env ]]; then
    grep -E "^${key}=" .env | tail -n 1 | cut -d= -f2- || true
  fi
}
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .env 2>/dev/null; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "$key" "$value" >> .env
  fi
}
random_secret() { openssl rand -hex 32; }
is_ip() {
  local value="$1"
  [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$value" == *:* ]]
}

log "检查并安装 Docker Engine 与 Compose 插件……"
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg openssl ufw
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH="$(dpkg --print-architecture)"
  CODENAME="${VERSION_CODENAME:-$(. /etc/os-release && echo "$VERSION_CODENAME")}" 
  [[ -n "$CODENAME" ]] || die "无法识别系统代号，不能配置 Docker 软件源。"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$ARCH" "$ID" "$CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

auto_ip="$(curl -4 -fsS --max-time 6 https://api.ipify.org 2>/dev/null || true)"
existing_host="$(get_env PUBLIC_HOST)"
existing_domain="$(get_env DOMAIN)"
PUBLIC_HOST="${PUBLIC_HOST:-${existing_host:-$auto_ip}}"
DOMAIN="${DOMAIN:-$existing_domain}"

if [[ -t 0 ]]; then
  read -r -p "服务器公网 IP 或域名 [${PUBLIC_HOST:-请填写}]: " input_host || true
  PUBLIC_HOST="${input_host:-$PUBLIC_HOST}"
  read -r -p "已解析到本服务器的域名（有域名可填；没有直接回车）[${DOMAIN:-无}]: " input_domain || true
  DOMAIN="${input_domain:-$DOMAIN}"
fi

[[ -n "$PUBLIC_HOST" ]] || die "未能自动获取公网 IP，请重新运行并设置 PUBLIC_HOST，例如：PUBLIC_HOST=1.2.3.4 sudo -E bash server/install.sh"
[[ "$PUBLIC_HOST" != *" "* && "$PUBLIC_HOST" != *"/"* ]] || die "PUBLIC_HOST 格式无效。"
if [[ -z "$DOMAIN" ]] && ! is_ip "$PUBLIC_HOST"; then DOMAIN="$PUBLIC_HOST"; fi
if [[ -n "$DOMAIN" ]]; then
  [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ && "$DOMAIN" == *.* ]] || die "DOMAIN 格式无效，请填写类似 live.example.com 的域名。"
  PUBLIC_HOST="$DOMAIN"
fi

if [[ ! -f .env ]]; then
  touch .env
  chmod 600 .env
fi
MYSQL_ROOT_PASSWORD="$(get_env MYSQL_ROOT_PASSWORD)"
MYSQL_PASSWORD="$(get_env MYSQL_PASSWORD)"
JWT_SECRET="$(get_env JWT_SECRET)"
ADMIN_PASSWORD="$(get_env ADMIN_PASSWORD)"
SRS_HOOK_SECRET="$(get_env SRS_HOOK_SECRET)"
TURN_SECRET="$(get_env TURN_SECRET)"
CANDIDATE="${CANDIDATE:-$(get_env CANDIDATE)}"
[[ -n "$MYSQL_ROOT_PASSWORD" && "$MYSQL_ROOT_PASSWORD" != change_this_root_password ]] || MYSQL_ROOT_PASSWORD="$(random_secret)"
[[ -n "$MYSQL_PASSWORD" && "$MYSQL_PASSWORD" != change_this_db_password ]] || MYSQL_PASSWORD="$(random_secret)"
[[ -n "$JWT_SECRET" && "$JWT_SECRET" != replace_with_at_least_32_random_characters ]] || JWT_SECRET="$(random_secret)"
[[ -n "$ADMIN_PASSWORD" && "$ADMIN_PASSWORD" != change_this_admin_password ]] || ADMIN_PASSWORD="$(random_secret)"
[[ -n "$SRS_HOOK_SECRET" && "$SRS_HOOK_SECRET" != replace_with_random_hook_secret ]] || SRS_HOOK_SECRET="$(random_secret)"
[[ -n "$TURN_SECRET" && "$TURN_SECRET" != replace_with_random_turn_secret ]] || TURN_SECRET="$(random_secret)"
[[ -n "$CANDIDATE" && "$CANDIDATE" != YOUR_SERVER_PUBLIC_IPV4 ]] || CANDIDATE="$auto_ip"
[[ -n "$CANDIDATE" && "$CANDIDATE" != "*" ]] || die "无法确定 SRS 公网候选 IP。请设置 CANDIDATE=你的VPS公网IPv4 后重新运行安装脚本。"
[[ "$CANDIDATE" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "CANDIDATE 必须填写公网 IPv4 地址，当前值：$CANDIDATE"

set_env PUBLIC_HOST "$PUBLIC_HOST"
set_env DOMAIN "$DOMAIN"
set_env MYSQL_ROOT_PASSWORD "$MYSQL_ROOT_PASSWORD"
set_env MYSQL_PASSWORD "$MYSQL_PASSWORD"
set_env JWT_SECRET "$JWT_SECRET"
set_env ADMIN_USERNAME "admin"
set_env ADMIN_PASSWORD "$ADMIN_PASSWORD"
set_env SRS_HOOK_SECRET "$SRS_HOOK_SECRET"
set_env TURN_SECRET "$TURN_SECRET"
set_env CANDIDATE "$CANDIDATE"
set_env PLUGIN_ENABLED "${PLUGIN_ENABLED:-$(get_env PLUGIN_ENABLED)}"
[[ -n "$(get_env PLUGIN_ENABLED)" ]] || set_env PLUGIN_ENABLED "welcome,stream-audit"
set_env PUBLIC_API_SCHEME "${DOMAIN:+https}"
if [[ -n "$DOMAIN" ]]; then
  set_env PUBLIC_API_PORT ""
  set_env API_BIND "127.0.0.1"
  set_env WEB_BIND "127.0.0.1"
  set_env PUBLIC_WEB_PORT ""
  set_env SRS_HTTP_BIND "127.0.0.1"
  set_env CORS_ORIGINS "https://${DOMAIN}"
else
  set_env PUBLIC_API_SCHEME "http"
  set_env PUBLIC_API_PORT "3000"
  set_env API_BIND "0.0.0.0"
  set_env WEB_BIND "0.0.0.0"
  set_env PUBLIC_WEB_PORT "8081"
  set_env SRS_HTTP_BIND "127.0.0.1"
  set_env CORS_ORIGINS "*"
fi
chmod 600 .env

# SRS 只对少数特定变量做环境替换，hook 密钥和候选 IP 必须在启动前写入
# 运行时配置；否则 SRS 会把 "$SRS_HOOK_SECRET" 原样当作 URL 发出。
log "生成 SRS 运行时配置（候选地址与 hook 密钥）……"
sed -e "s|\$CANDIDATE|${CANDIDATE}|g" \
    -e "s|\$SRS_HOOK_SECRET|${SRS_HOOK_SECRET}|g" \
    "$SCRIPT_DIR/srs.conf" > "$SCRIPT_DIR/srs.runtime.conf"
chmod 644 "$SCRIPT_DIR/srs.runtime.conf"
grep -qE '\$(CANDIDATE|SRS_HOOK_SECRET)' "$SCRIPT_DIR/srs.runtime.conf" && die "SRS 运行时配置仍有未替换的变量，请检查 server/srs.conf 模板。"

# coturn 的 REST 凭据共享密钥同样不能留在模板中：backend 用 TURN_SECRET 签发短期
# 凭据，coturn 用同一个密钥校验。PUBLIC_HOST 作为 realm，CANDIDATE 作为
# external-ip（云主机 1:1 NAT 时中继候选必须是公网地址）。
log "生成 TURN 运行时配置（短期凭据密钥、公网地址）……"
sed -e "s|\$TURN_SECRET|${TURN_SECRET}|g" \
    -e "s|\$CANDIDATE|${CANDIDATE}|g" \
    -e "s|\$PUBLIC_HOST|${PUBLIC_HOST}|g" \
    "$SCRIPT_DIR/turn.conf" > "$SCRIPT_DIR/turn.runtime.conf"
chmod 644 "$SCRIPT_DIR/turn.runtime.conf"
grep -qE '\$(TURN_SECRET|CANDIDATE|PUBLIC_HOST)' "$SCRIPT_DIR/turn.runtime.conf" && die "TURN 运行时配置仍有未替换的变量，请检查 server/turn.conf 模板。"

mkdir -p recordings/live srs-html/live srs-html/recordings plugin-data covers
chmod 750 recordings plugin-data covers recordings/live srs-html srs-html/live srs-html/recordings
# API 和 SRS 使用同一非特权 UID，便于录像枚举、回放、受控删除和封面上传。
chown -R 1000:1000 recordings srs-html plugin-data covers

log "检查 Docker Compose 配置及 WebUI 文件……"
[[ -s "$PROJECT_DIR/web/index.html" && -s "$PROJECT_DIR/webui/admin.html" ]] || die "WebUI 文件缺失：需要 web/ 用户端和 webui/admin.html 管理后台。"
docker compose config -q

# 浏览器推流需要 HTTPS 安全上下文；IP 模式生成自签名证书（浏览器会提示一次）。
CERT_DIR="$SCRIPT_DIR/certs"
mkdir -p "$CERT_DIR"
if [ ! -s "$CERT_DIR/web.crt" ] || [ ! -s "$CERT_DIR/web.key" ]; then
  openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
    -keyout "$CERT_DIR/web.key" -out "$CERT_DIR/web.crt" \
    -subj "/CN=$PUBLIC_HOST" \
    -addext "subjectAltName=IP:$PUBLIC_HOST" >/dev/null 2>&1 || true
  chmod 600 "$CERT_DIR/web.key" 2>/dev/null || true
fi

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null || true
  ufw allow 8000/udp >/dev/null || true
  ufw allow 8000/tcp >/dev/null || true
  # TURN 中继：coturn 以 host network 直接绑定 3478 与 relay 端口段。
  ufw allow 3478/tcp >/dev/null || true
  ufw allow 3478/udp >/dev/null || true
  ufw allow 5349/tcp >/dev/null || true
  ufw allow 5349/udp >/dev/null || true
  ufw allow 49160:49200/udp >/dev/null || true
  if [[ -n "$DOMAIN" ]]; then
    ufw allow 80/tcp >/dev/null || true
    ufw allow 443/tcp >/dev/null || true
    ufw allow 443/udp >/dev/null || true
  else
    ufw allow 3000/tcp >/dev/null || true
    ufw allow 8081/tcp >/dev/null || true
    ufw allow 8443/tcp >/dev/null || true
  fi
  if ufw status 2>/dev/null | grep -q 'Status: active'; then
    log "UFW 已启用，已添加所需规则。"
  else
    warn "UFW 当前未启用；脚本没有擅自启用防火墙，以免影响 SSH。请按 VPS 提供商文档配置云防火墙。"
  fi
fi

log "构建并启动葱直播服务……"
if [[ -n "$DOMAIN" ]]; then
  docker compose --profile https up -d --build
else
  docker compose up -d --build
fi
# A bind-mounted SRS/TURN config can change without changing the Compose
# service hash. Explicitly restart them so the publish hooks and the new relay
# secret are loaded on upgrades too.
docker compose restart srs coturn >/dev/null

log "等待 API 健康检查……"
health_url="http://127.0.0.1:3000/api/health"
healthy=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 3 "$health_url" >/tmp/conglive-health.json 2>/dev/null; then healthy=1; break; fi
  sleep 3
done
if [[ "$healthy" -ne 1 ]]; then
  warn "API 尚未通过健康检查，下面显示最近日志："
  docker compose logs --tail=80 backend mysql srs || true
  die "安装未能完成健康检查。检查 server/.env、内存和容器日志后执行：cd server && docker compose up -d --build"
fi

log "葱直播服务已启动。"
printf "管理后台管理员账号：admin\\n管理后台管理员密码：%s\\n" "$(get_env ADMIN_PASSWORD)"
printf '\n'
printf "普通用户 WebUI 源码：%s/web/\\n" "$PROJECT_DIR"
printf "管理后台 WebUI 源码：%s/webui/admin.html\\n" "$PROJECT_DIR"
if [[ -n "$DOMAIN" ]]; then
  printf 'Web 用户端：https://%s\n' "$DOMAIN"
  printf '管理后台：  https://%s/admin\n' "$DOMAIN"
  printf 'API 地址：  https://%s\n' "$DOMAIN"
  printf 'WebRTC 媒体：UDP/TCP %s:8000\n' "$CANDIDATE"
  printf 'TURN 中继：  turn:%s:3478?transport=udp / tcp（relay UDP 49160-49200）\n' "$PUBLIC_HOST"
  printf 'TURN 凭据：  https://%s/api/turn-credentials（登录后短期有效）\n' "$DOMAIN"
  warn "请确保域名 A/AAAA 记录指向此服务器；云防火墙开放 80、443、UDP/TCP 8000，以及 TURN 的 UDP/TCP 3478 和 UDP 49160-49200。WebRTC WHIP/WHEP API 通过 HTTPS 域名代理，媒体使用 8000 端口。"
else
  printf 'Web 用户端：http://%s:8081\n' "$PUBLIC_HOST"
  printf '浏览器开播（HTTPS，自签名）：https://%s:8443\n' "$PUBLIC_HOST"
  printf '管理后台：  http://%s:8081/admin\n' "$PUBLIC_HOST"
  printf 'API 地址：  http://%s:3000\n' "$PUBLIC_HOST"
  printf 'WebRTC 信令 API：http://%s:3000/api\n' "$PUBLIC_HOST"
  printf 'WebRTC 媒体：UDP/TCP %s:8000\n' "$CANDIDATE"
  printf 'TURN 中继：  turn:%s:3478?transport=udp / tcp（relay UDP 49160-49200）\n' "$PUBLIC_HOST"
  printf 'TURN 凭据：  http://%s:3000/api/turn-credentials（登录后短期有效）\n' "$PUBLIC_HOST"
  warn "IP 模式使用明文 HTTP，仅用于测试；WebRTC 手机端/浏览器建议使用 HTTPS 域名。请确认公网候选地址 CANDIDATE 正确，云防火墙已开放 UDP/TCP 8000、UDP/TCP 3478 和 UDP 49160-49200。"
fi
printf '插件列表： %s/api/plugins\n' "$(if [[ -n "$DOMAIN" ]]; then printf 'https://%s' "$DOMAIN"; else printf 'http://%s:3000' "$PUBLIC_HOST"; fi)"
printf 'TURN 凭据接口：%s/api/turn-credentials（Bearer 登录，默认 ttl 3600 秒）\n' "$(if [[ -n "$DOMAIN" ]]; then printf 'https://%s' "$DOMAIN"; else printf 'http://%s:3000' "$PUBLIC_HOST"; fi)"
printf '\n常用命令：\n  cd %s/server\n  docker compose ps\n  docker compose logs -f backend srs\n  docker compose restart backend\n\n' "$PROJECT_DIR"

# Best-effort TURN TLS certificate sync (Caddy may need a few seconds).
if [[ -n "$DOMAIN" ]]; then
  sleep 3
  bash "$SCRIPT_DIR/sync-turn-cert.sh" || warn "TURN TLS 证书同步失败；可稍后运行 server/sync-turn-cert.sh"
fi
