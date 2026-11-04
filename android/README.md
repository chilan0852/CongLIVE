# CongLive Android v0.7.7 — 中英双语 + 暗色 UI + 封面上传 + Live2D 看板娘

Kotlin 原生 Android 客户端。实时直播推流由 WHIP 完成，实时观看使用 WHEP；保留账号、个人直播、WebSocket 弹幕和 MP4 录像播放。

## 功能与限制

- 注册、登录、服务器 API 地址配置。
- **中英双语界面**：默认跟随系统语言（中文环境中文，其余英文）；可在「我的」页切换 中文 / English，切换后立即重建界面并保存到 SharedPreferences `app_language`。
- 直播大厅仅显示服务端确认在线的直播。
- 创建直播后由系统 MediaProjection 弹窗授权屏幕采集。
- `ScreenStreamService` 可选择 `ScreenCapturerAndroid` 或 `Camera2Enumerator`，通过同一个 WebRTC PeerConnection / WHIP 推送单条视频轨道。
- 摄像头模式支持前置/后置切换，并在 Android 页面提供本地预览；摄像头默认关闭，只在点击「摄像头直播」并明确授予 CAMERA 权限后启动。
- 摄像头采集运行于带 `camera|microphone` 类型的前台服务；停止直播、采集失败或服务关闭时会停止并释放 Camera2 capturer。
- 视频优先协商 H.264，编码器固定为 Baseline（`DefaultVideoEncoderFactory(egl, true, false)`，关闭 High Profile）。
- 开播页可选择分辨率与帧率，选择结果通过 SharedPreferences 持久化（默认 720p / 24fps）：
  - 分辨率：720p 1280×720 / 2 Mbps、540p 960×540 / 1.2 Mbps、360p 640×360 / 800 kbps。
  - 帧率：30 / 24 / 15 fps。
  - 摄像头直播按横屏尺寸采集，屏幕直播按竖屏尺寸采集（服务端交换宽高），码率与帧率写入视频 RTP sender。
- 麦克风由 `org.webrtc.audio.JavaAudioDeviceModule` 提供。
- WHEP 客户端接收音视频，直播不使用 HLS/HTTP-FLV。
- WebSocket 弹幕、个人录像列表、Media3 MP4 回放保留。

**本版尚未实现 Android AudioPlaybackCapture 系统内录音频到 WebRTC 自定义 ADM 的 PCM 注入/混音**，目前可推送麦克风音频；不要把录屏授权等同于系统声音已推送。

## 构建环境

- Android Studio；JDK 17。
- Android SDK Platform 35 / Build Tools 35.0.0。
- Android Gradle Plugin 8.7.3，使用 Gradle 8.9 或兼容版本（建议使用 Gradle Wrapper 管理版本）。
- Kotlin Gradle Plugin 2.3.21（沿用项目配置）。
- 最低 Android 10 / API 29。
- WebRTC SDK：`io.github.webrtc-sdk:android:150.7871.04`（Maven Central）。

本包不包含 Gradle Wrapper 和 APK。Android Studio Sync 后执行 `:app:assembleDebug`，或：

```bash
gradle :app:assembleDebug
```

输出：`app/build/outputs/apk/debug/app-debug.apk`。

## 服务端地址

首次启动默认 `http://10.0.2.2:3000` 仅用于 Android 模拟器。实体手机应填写真实 API 根地址，不要添加 `/api`：

- 域名 HTTPS：`https://live.example.com`
- IP 测试：`http://203.0.113.10:3000`（只建议受控测试）

## 推流步骤

1. 登录普通用户账号。
2. 在「开播」页创建直播间。
3. 在「屏幕直播」与「摄像头直播」之间选择视频源，并选择分辨率（720p / 540p / 360p）与帧率（30 / 24 / 15 fps）；默认 720p / 24fps，选择会立即保存到 SharedPreferences，下一次开播生效。
4. 点击开始：屏幕模式会请求系统录屏授权；摄像头模式会请求 Android CAMERA 权限。摄像头直播可预览并切换前/后摄。
5. Android 建立 PeerConnection、收集 ICE candidates、把 SDP offer 发送到 `POST /api/streams/:id/whip`。
6. API 检查 JWT 和直播归属，再由内网访问 SRS WHIP API。
7. SRS HTTP `on_publish` hook 验证短时签名 token 后更新 `is_live`；大厅只显示服务器确认在线的流。
7. 停止直播会关闭 PeerConnection，SRS `on_unpublish` hook 更新数据库并结束录像会话。

## 观看步骤

选择直播间后，客户端向 `POST /api/streams/:id/whep` 提交 WHEP SDP offer；API 校验登录和直播状态，代理至 SRS。播放通过 WebRTC 音视频轨道，不走 HLS。

## 常见问题

- **WHIP HTTP 401/403**：检查账号登录状态、直播所有权、SRS hook secret 和 `on_publish` 日志。
- **WHIP/WHEP HTTP 502**：检查 `docker compose ps` 和 SRS 内部 HTTP API `1985`。
- **ICE failed / 一直 connecting**：先确认 `server/.env` 的 `CANDIDATE` 是公网可达 IP，再确认安全组和 UFW 放行 UDP/TCP 8000；检查手机网络是否屏蔽 UDP/TCP。必要时部署 TURN。
- **直播不出现在大厅**：看 `docker compose logs -f srs backend`，必须收到 `on_publish` 且数据库 `is_live` 为 true。
- **没有系统声音**：当前 v0.7.0 Android WebRTC 版只接入麦克风，系统内录尚未完成。
- **录像没有生成**：检查 SRS `rtc_to_rtmp on` 和 DVR 配置、Android 是否协商 H.264、录像目录写权限与磁盘空间。


## 摄像头采集说明（v0.7.1）

- 「屏幕直播」使用 MediaProjection；「摄像头直播」使用 Camera2。两种视频源互斥，必须停止当前直播后才能切换。
- 摄像头模式会在用户点击开始后请求 CAMERA 运行时权限；未授权时不启动摄像头。Android 系统隐私指示器会显示摄像头使用状态。
- 支持前置/后置摄像头切换与本机预览。预览只显示本机采集画面，不会创建额外的视频轨道。
- WHIP 当前限制单个 MediaStream 中同一媒体类型不能有多个轨道，因此本版不把屏幕与摄像头作为两条视频轨道同时推送，也暂未提供画中画合成。
- 摄像头默认使用 1280×720、24 FPS 请求值；设备不支持时由 Camera2/WebRTC 设备能力决定是否能协商成功。

## v0.7.6 新增

- **暗色渐变 UI**：渐变背景、圆角卡片 + 阴影、统一间距、五栏底部导航（大厅 / 开播 / 录像 / 我的 / 看板娘）与按钮按下/禁用状态；0.7.5 的画质设置与 0.7.4 的预览修复原样保留。
- **直播封面上传**：开播页创建直播间后、以及「我的直播记录」里均可点击「从相册选择封面」，通过 `ACTION_OPEN_DOCUMENT` 选图（无需存储权限）；图片自动缩放到长边 ≤1280、JPEG 压缩并转为 ≤2MB 的 `data:image/jpeg;base64,...`，调用 `POST /api/streams/:id/cover`（`{imageData}` → `{coverUrl}`）。
- **封面展示**：大厅卡片显示服务端返回的 `coverUrl`；封面用 `HttpURLConnection` + `BitmapFactory` + LRU 缓存下载，不引入 Glide/Coil。无封面或下载失败时显示渐变 + 标题首字。
- **Live2D 看板娘**：新增底部「看板娘」入口。本地 `assets/live2d/viewer.html` 通过 CDN 加载 pixi.js 与 pixi-live2d-display（不内置模型），输入 `.model3.json` 公网地址即可加载 / 显示 / 隐藏，加载失败有明确提示；模型资源需允许 CORS。看板娘只用于界面显示，**不会合成进 WebRTC 直播画面**。
- **版本**：versionCode 18 / versionName 0.7.6，minSdk 29 / targetSdk 34。

## v0.7.7 新增（中英双语）

- **新文件 `L10n.kt`**：`Lang`（zh / en）+ `L10n` 字符串字典与持久化；默认按 `Locale.getDefault()` 选择中文或英文，选择结果写入 SharedPreferences `app_language`。
- **语言切换**：「我的」页新增「语言 / Language」卡片（中文 / English）。切换后立即重建整个界面（导航、头部、状态栏、当前页面），无需重启 App。
- **全部界面翻译**：登录注册、直播大厅、弹幕、开播（画质 / 封面 / 推流状态）、录像、看板娘、服务器设置、空状态、错误提示、Toast 与按钮。
- **服务与播放状态按语言输出**：`ScreenStreamService` 读取 SharedPreferences `app_language`（并接受 Activity 传入的 `EXTRA_LANGUAGE` Intent extra），通知栏文案、摄像头/ICE/WHIP 状态与错误均按当前语言输出；同时广播机器可读的 `EXTRA_STATUS_CODE`，Activity 不再依赖中文字符串判断状态。`WebRtcPlaybackClient`、`CameraPreviewBridge`、`Live2DViewer` 及 `viewer.html` 的用户可见状态同样支持中英双语。
- **后端中文错误映射**：英文模式下对常见后端错误做客户端映射（如需要登录、直播不存在、封禁、封面超限等），未知错误保留原文。
- **版本**：versionCode 19 / versionName 0.7.7，minSdk 29 / targetSdk 34。0.7.6 的分辨率/帧率、setZOrderOnTop、init-before-addView、Baseline H.264、封面与 Live2D 入口全部保留。
