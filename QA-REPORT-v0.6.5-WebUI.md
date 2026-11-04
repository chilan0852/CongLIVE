# CongLive v0.6.5 WebUI QA 报告

## 本次交付修正

- 将管理后台页面作为独立源文件放到 `webui/admin.html`，不再让用户去 `backend/public/` 中寻找。
- 明确 `web/` 是普通用户网页端，`webui/admin.html` 是管理后台。
- backend Docker 构建上下文改为项目根目录，构建时复制 `webui/admin.html` 到容器 `/app/public/admin.html`。
- Express 提供 `/admin` 与 `/admin/`。
- Web Nginx 对 `/admin` 代理到 backend，对 `/admin/` 返回 308 到 `/admin`。
- 安装脚本检查 WebUI 两个入口文件，并打印源码路径和服务访问地址。
- 新增部署说明、目录说明、升级步骤与 WebUI 自动化测试。

## 已执行并通过

| 检查 | 结果 |
|---|---|
| Node backend 自动化测试 | 11/11 通过 |
| 后端 JavaScript 语法 | 通过 |
| WebUI 内嵌 JavaScript 语法 | 通过 |
| React TSX 语法解析（TypeScript parser-only） | 通过 |
| Web UI 页面文件/路由/文档映射测试 | 通过 |
| Docker Compose YAML 结构解析 | 通过 |
| Compose backend build context 与 Dockerfile 路径静态检查 | 通过 |
| Nginx 配置语法（使用临时本机 upstream 地址进行解析） | 通过 |
| Shell 安装/管理脚本语法 | 通过 |
| Android Manifest XML | 通过 |
| ZIP 内容完整性 | 打包后检查 |

## 未能在当前环境完成

- `npm install` 在当前环境等待超时，未成功安装 React/Vite 依赖；因此没有执行 `vite build`。
- 当前环境没有 Docker CLI/daemon；没有执行真实 `docker compose config`、镜像构建或容器启动。
- 没有运行中的 MySQL、SRS 和浏览器端到端环境；未完成后台登录、API 操作和录像播放的实际联调。
- Android SDK/Gradle 不可用；本次也未重新构建 Android APK。

## 部署后验收命令

```bash
cd CongLive/server
docker compose config -q
docker compose up -d --build backend web
curl -I http://127.0.0.1:8081/
curl -I http://127.0.0.1:8081/admin
curl -I http://127.0.0.1:8081/admin/
curl -s http://127.0.0.1:3000/api/health
```

预期：用户端返回 HTTP 200；`/admin` 返回 HTTP 200；`/admin/` 重定向到 `/admin`；健康检查返回 `ok: true`。域名模式请使用 `https://你的域名/` 和 `https://你的域名/admin`。

## 结论

v0.6.5 已在源码和静态配置层面明确交付 Web 用户端与管理后台，并有自动化测试覆盖文件、路由、代理和 Compose build context。它仍然是源代码版本，不代表已通过真实 VPS 的 Docker/browser E2E 验收。
