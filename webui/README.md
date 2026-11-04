# CongLive Web 管理后台

本目录 `admin.html` 是管理后台单页源码，构建 API 镜像时复制为 `/app/public/admin.html`，Express 路由通过 `/admin` 提供。

访问：
- 域名 HTTPS：`https://你的域名/admin`
- IP 测试：`http://服务器IP:8081/admin`

管理员凭据由 `server/install.sh` 写入 `server/.env`（`ADMIN_USERNAME` / `ADMIN_PASSWORD`），与普通用户账号分开。

功能：仪表盘、直播封禁/解封/软删除、用户封禁/解封、录像列表/在线回放/删除、插件启停、操作审计日志。

## 中英双语（i18n）

管理后台内置中英双语，登录页和顶栏都有 `中文 / English` 切换按钮，切换即时生效、无需刷新：

- 语言选择保存在 `localStorage` 的 `conglive.admin.lang`（值为 `zh` / `en`）。
- 首次访问按浏览器语言决定：`navigator.language` 为中文（`zh*`）时显示中文，其余显示英文。
- 文案字典内嵌在 `admin.html` 的 `<script>` 中（`DICT` 对象，`data-i18n` / `data-i18n-html` 标记静态文案），无构建步骤、无外部依赖。
- 动态数据（直播标题、用户名、录像文件名、插件名称/描述、审计日志内容等）不做翻译；后端返回的中文错误在英文界面会映射为英文，未知错误保留原文。
- 新增文案时在 `DICT.zh` 与 `DICT.en` 同时添加 key，静态元素加 `data-i18n="key"`，JS 生成的文案用 `t('key')`。

更新后台页面后，在 `server/` 目录执行：

```bash
docker compose up -d --build backend
```
