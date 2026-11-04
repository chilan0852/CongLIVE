# CongLive v0.6.2：开播状态修复

## 修复内容

1. SRS `http_hooks` 原先没有 `enabled on;`，并且配置块在 `vhost` 外。SRS 5 的 HTTP 回调默认关闭，且示例配置将 `http_hooks` 放在 `vhost` 内。现在已启用 `__defaultVhost__` 的 `on_publish` / `on_unpublish` 回调。
2. Android 收到 RootEncoder 的推流成功回调后，旧版只刷新公开直播大厅，没有刷新“我的直播记录”，列表会保留旧的 `is_live=false`。现在会刷新个人直播列表。
3. 推流成功后，Android 会轮询服务端个人直播记录（最多约 18 秒），只有数据库确认 `is_live=true` 才显示“直播中 · 服务器已确认推流成功”。
4. 服务端增加 SRS 开播/停播回调日志，不输出 RTMP 推流密钥。

## 已安装 v0.6.1 的 VPS 升级步骤

1. 备份 `server/.env`、MySQL 数据卷和录像目录。不要使用 `docker compose down -v`。
2. 将 v0.6.2 项目中的 `server/srs.conf` 和 `backend/src/index.js` 更新到服务器；如更新完整项目，保留现有 `.env`、`recordings/`。
3. 在服务器执行：

```bash
cd CongLive/server
docker compose up -d --build backend
docker compose restart srs
```

4. 查看日志：

```bash
docker compose logs --tail=100 srs backend
```

5. 重新安装 v0.6.2 Android APK/构建版本，创建一个新的测试直播并点开始。成功时，backend 日志应出现类似：

```text
[srs] publish accepted streamId=123 userId=1
```

结束直播后应看到 `unpublish accepted`。Android 状态应变成“直播中 · 服务器已确认推流成功”，个人记录的状态也应为“直播中”。

## 若仍不显示直播中

- 如果 SRS 日志提示连接 backend 回调失败，检查 `docker compose ps` 以及 backend 容器健康状态。
- 如果 SRS 有 `on_publish` 回调，但 backend 没有 `[srs] publish accepted`，检查 `stream` 是否为数据库中的 36 位十六进制 stream_key，以及 backend 错误日志。
- 如果 backend 已出现 `publish accepted`，但旧 Android 客户端仍显示“未开播”，更新到 v0.6.2；旧版没有刷新“我的直播记录”。

## 验证边界

本包已做源码静态检查；当前工作环境未运行真实 SRS Docker 容器、VPS RTMP 推流或 Android 真机测试。
