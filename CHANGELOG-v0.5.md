# CongLive v0.5 更新记录

- 新增用户端 WebSocket 实时弹幕、消息持久化、单用户发送频率限制。
- 新增直播封禁/解封/软删除、用户封禁/解封。
- 通过 SRS HTTP API 查询直播发布客户端 CID 并尝试断开推流客户端。
- 新增录像文件列表、带 HTTP Range 的在线回放、管理员永久删除。
- 回放改为限时签名 URL；SRS HTTP 服务端口限制在本机绑定。
- 新增插件运行时启用/停用，状态保存在 MySQL。
- 新增管理员操作日志。
- 新增 Web 容器、Nginx 代理和 Caddy 用户端路由。
- 修复 backend Dockerfile 未复制 `public/admin.html` 的问题。
- 为 v0.4 数据库增加自动迁移。
