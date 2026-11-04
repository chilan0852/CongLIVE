# 从 CongLive v0.5 升级到 v0.6

本次是 Android 用户端与配套 API 的升级。

## 升级内容

- Android Kotlin 客户端升级至 0.6.0，保留原录屏/推流服务。
- 新增直播大厅、HLS 观看、实时弹幕、个人录像列表、在线回放和账号状态提示。
- `GET /api/streams` 增加 `playUrl` 字段，不再将 RTMP `stream_key` 暴露给普通访客。
- 新增 `GET /api/recordings/mine`，只返回当前登录用户自己直播的录像。

## 升级服务端

建议先备份 `server/.env`、`server/recordings/` 和 MySQL 数据卷。不要使用 `docker compose down -v`。

将 v0.6 项目部署到原项目目录后执行：

```bash
cd CongLive/server
sudo bash install.sh
```

新接口不需要破坏性数据库迁移。

## 构建 Android

使用 Android Studio 打开 `android/`，配置 JDK 17、Android SDK Platform 35，等待 Gradle Sync 后构建 `app`。目前交付的是源代码，未附带 APK。

## 注意

旧 v0.5 服务端没有 `GET /api/recordings/mine`，旧直播列表也没有 `playUrl` 字段；只安装新版 Android 客户端而不升级服务端，会导致录像列表为空或直播大厅无法自动播放。
