# v0.6.4 → v0.6.5 升级说明

v0.6.5 将 Web 管理后台源文件单独整理到 `webui/admin.html`，并调整 backend Docker build context。升级前备份 `server/.env`、MySQL 数据卷和 `server/recordings/`。

1. 解压完整 v0.6.5 项目并覆盖旧项目源码；保留 `.env`、MySQL 数据卷和录像目录。
2. 确认项目根目录包含 `web/`、`webui/admin.html`、`backend/` 和 `server/`。
3. 在服务器执行：

```bash
cd CongLive/server
docker compose config -q
docker compose up -d --build backend web
```

4. 验证用户端与管理后台：

```bash
curl -I http://127.0.0.1:8081/
curl -I http://127.0.0.1:8081/admin
curl -I http://127.0.0.1:8081/admin/
curl -s http://127.0.0.1:3000/api/health
```

`/admin/` 应重定向至 `/admin`；用户端和管理后台应能加载；健康检查应返回 `ok: true`。域名模式请将 `http://127.0.0.1:8081` 替换为 `https://你的域名`。

管理员凭据见 `server/.env` 的 `ADMIN_USERNAME` 与 `ADMIN_PASSWORD`。普通用户账号不能登录管理后台。不要删除 MySQL 数据卷，也不要覆盖 `.env` 或录像目录。
