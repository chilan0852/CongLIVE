# CongLive v0.6.5

## WebUI 交付整理

- 新增明确的 `webui/` 目录，管理后台页面正式源文件位于 `webui/admin.html`。
- `web/` 目录明确作为普通用户 React 网页端；新增 `web/README.md`。
- backend Docker 构建上下文调整为项目根目录，从 `webui/admin.html` 将后台页面复制到 API 容器 `/app/public/admin.html`。
- Web Nginx 明确代理 `/admin` 到 API；`/admin/` 使用 308 规范跳转至 `/admin`。
- Express 同时响应 `/admin` 与 `/admin/`，并为后台 HTML 设置 `Cache-Control: no-store`。
- 安装脚本启动前检查用户端和管理后台页面文件，安装输出明确列出两个入口和源码位置。
- 新增 `WEBUI-部署说明.md`，补齐页面功能、源码位置、访问 URL、部署结构、账号区分和故障检查。

## 保留内容

- 不更改 Android 0.6.4 的版本号和录屏推流逻辑。
- 不修改现有 MySQL 用户、直播和录像数据结构。
- 不改动 `.env`、数据库卷或录像目录。
