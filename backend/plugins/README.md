# CongLive Backend Plugins

只放置可信的本地插件。后台可以对已安装插件进行运行时启用/停用；默认启动状态仍由 `server/.env` 的 `PLUGIN_ENABLED` 决定，后台切换会保存到 MySQL `plugin_settings` 并覆盖默认值。

插件入口需要导出 `register(context)`。上下文包括：
- `app`：带启停保护的 Express 路由注册接口
- `db`：MySQL2 promise pool
- `auth`：现有 JWT 用户身份验证中间件
- `hooks.on(eventName, handler)`：订阅直播事件，禁用时钩子不会执行
- `logger`：服务端日志对象
- `dataDir`：持久化插件数据目录（容器内 `/app/data`）
- `plugin`：插件 id/name/version

支持事件：`stream.created`、`stream.published`、`stream.unpublished`。

开发方式：复制 `plugin-template` 目录，修改 `plugin.json` 的 id/name/version，再重建 API 镜像使新目录进入容器。随后可在后台打开插件。

**安全：** 插件代码在后端 Node.js 进程内执行，不是沙箱。不要安装陌生插件；不要记录密码、JWT、直播推流密钥或用户私密数据。
