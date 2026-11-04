# v0.6.5 升级说明

本版本主要整理 WebUI 目录与部署路由。升级前备份 `server/.env`、MySQL 数据卷和 `server/recordings/`。

1. 解压完整 v0.6.5 项目并覆盖旧项目源码；保留 `.env`、MySQL 卷和录像目录。
2. 确认项目根目录存在 `web/`、`webui/admin.html`、`backend/` 和 `server/`。
3. 执行：

```bash
cd CongLive/server
docker compose config -q
docker compose up -d --build backend web
```

4. 验证：

```bash
curl -I http://127.0.0.1:8081/
curl -I http://127.0.0.1:8081/admin
curl -I http://127.0.0.1:8081/admin/
curl -s http://127.0.0.1:3000/api/health
```

`/admin/` 应重定向到 `/admin`；用户端和管理后台 HTML 应返回 200；健康检查应返回 `ok: true`。域名模式将 `http://127.0.0.1:8081` 换为 `https://你的域名`。

后台入口使用 `server/.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，默认用户名为 `admin`；普通用户账号不能登录管理后台。

本项目升级包不包含 Docker 构建产物，必须在目标 VPS 上执行上述 Compose 重建。
