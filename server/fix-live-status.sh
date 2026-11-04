#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
[[ -f .env ]] || { echo "缺少 server/.env；请先确认当前服务器已安装 CongLive。" >&2; exit 1; }
[[ -f srs.conf && -f docker-compose.yml ]] || { echo "请在 CongLive/server 目录中运行此脚本。" >&2; exit 1; }
docker compose config -q
echo "正在重建 API 并重新加载 SRS 回调配置……"
docker compose up -d --build backend
docker compose restart srs
echo "正在检查容器状态……"
docker compose ps
echo
echo "最近 SRS / API 日志："
docker compose logs --tail=60 srs backend
echo
echo "现在请在 Android v0.6.2 中创建一条新直播，再点击开始。"
