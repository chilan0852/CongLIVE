# CongLive Web 管理后台

本目录 `admin.html` 是管理后台单页源码，构建 API 镜像时复制为 `/app/public/admin.html`，Express 路由通过 `/admin` 提供。

访问：
- 域名 HTTPS：`https://你的域名/admin`
- IP 测试：`http://服务器IP:8081/admin`

管理员凭据由 `server/install.sh` 写入 `server/.env`（`ADMIN_USERNAME` / `ADMIN_PASSWORD`），与普通用户账号分开。

功能：仪表盘、直播封禁/解封/软删除、用户封禁/解封、录像列表/在线回放/删除、插件启停、操作审计日志。

更新后台页面后，在 `server/` 目录执行：

```bash
docker compose up -d --build backend
```
