# v0.7.1 摄像头功能升级

本次主要升级 Android 客户端；服务端 WHIP/WHEP API、数据库结构和录像链路不需要迁移。

1. 备份现有 Android 工程和服务器配置。
2. 使用本包完整 `android/` 目录在 Android Studio 打开。
3. 使用 JDK 17、Android SDK 35，同步 Gradle。
4. 构建 `:app:assembleDebug` 并安装 versionCode 13 / versionName 0.7.1。
5. 首次选择「摄像头直播」时允许 CAMERA 权限；拒绝后不会开启摄像头。屏幕直播仍按旧流程请求 MediaProjection。

服务器可以继续运行 v0.7.0；摄像头视频复用原 WHIP stream endpoint，无需新增端口或数据库字段。
