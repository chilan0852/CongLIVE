# CongLive v0.6.2

## 修复
- 启用 SRS 5 HTTP hooks，并将 hooks 配置移入 `vhost __defaultVhost__`。
- Android 推流成功时刷新个人直播清单，并轮询服务端 `is_live` 状态。
- SRS `on_publish` / `on_unpublish` 写入不含 stream key 的诊断日志。
- 更新一键安装脚本，显式重启 SRS 以重新加载 bind-mounted 配置。
