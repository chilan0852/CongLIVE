#!/usr/bin/env bash
set -Eeuo pipefail
DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
usage() {
  cat <<'HELP'
葱直播服务管理
用法：bash server/manage.sh <命令>

命令：
  status           查看容器状态
  logs [服务名]    查看日志（默认 backend、srs）
  restart          重启所有服务
  restart-api      仅重启 API（插件配置变更后使用）
  update           重新构建并更新 API 与 Web 镜像
  plugins          查看已加载插件
  health           检查 API 健康状态
HELP
}
cmd="${1:-help}"
case "$cmd" in
  status) docker compose ps ;;
  logs) shift || true; if [[ $# -eq 0 ]]; then docker compose logs -f backend srs; else docker compose logs -f "$@"; fi ;;
  restart) docker compose restart ;;
  restart-api) docker compose restart backend ;;
  update) docker compose up -d --build backend web ;;
  plugins)
    curl -fsS http://127.0.0.1:3000/api/plugins || { echo "无法读取插件状态；可运行 docker compose logs backend" >&2; exit 1; }
    ;;
  health)
    curl -fsS http://127.0.0.1:3000/api/health || { echo "API 未通过健康检查" >&2; exit 1; }
    ;;
  help|-h|--help) usage ;;
  *) usage; exit 2 ;;
esac
