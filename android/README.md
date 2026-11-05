# CongLive Android v0.8.1 — 独立直播间 + 全双工语音房（TURN 中继）+ 1080p60 容量门控 + 延迟监控 + 域名服务器

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
  - 分辨率：1080p 1920×1080 / 6 Mbps（受服务器容量门控）、720p 1280×720 / 2 Mbps、540p 960×540 / 1.2 Mbps、360p 640×360 / 800 kbps。
  - 帧率：60 / 30 / 24 / 15 fps（60fps 受服务器容量门控）。
  - 打开开播页与点击开始前都会请求 `GET /api/capacity`；`allow1080p60=false` 时 1080p 与 60fps 按钮禁用并显示原因（当前 2C/2G 服务器会禁用）。
  - 码率夹取：只有 1080p + 60fps 使用高码率（≤8 Mbps），其余组合一律 ≤2 Mbps；Activity 与 Service 双重夹取。
  - 摄像头直播按横屏尺寸采集，屏幕直播按竖屏尺寸采集（服务端交换宽高），码率与帧率写入视频 RTP sender。
- 大厅点击直播卡片进入**独立直播间页面**（全屏替代大厅）：返回按钮、封面/标题/主播、WHEP 播放器、实时弹幕、观看人数；`GET /api/streams/:id` 轮询 + WebSocket `viewers` 更新人数，直播结束或 404 自动回大厅。
- WHEP 播放每秒通过 `getStats` 读取 `jitterBufferDelay / jitterBufferEmittedCount` 与 `currentRoundTripTime`，在房间页显示「延迟≈Xms」；停止播放/离开房间即停止采样并释放 PeerConnection。
- **全双工语音房（v0.8.0 / TURN v0.8.1）**：独立直播间内可「加入语音」，加入时才申请 RECORD_AUDIO 并采集麦克风；基于已登录房间 WebSocket 的 voice 信令协议（与 Web 端 `web/src/voice.ts` 对齐），每个远端参与者一个 audio-only PeerConnection（mesh），小 peerId 发 offer；房间页显示参与者/说话状态，支持静音与离开；离开、切房、下播或销毁时释放全部 PC/麦克风/监听。
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

首次启动默认 `http://10.0.2.2:3000` 仅用于 Android 模拟器。实体手机应填写真实服务器地址，不要添加 `/api`：

- 只填域名会自动补 `https://`：`live.example.com` → `https://live.example.com`
- 保留端口：`live.example.com:8443` → `https://live.example.com:8443`
- IP 测试：`203.0.113.10:3000` → `http://203.0.113.10:3000`（只建议受控测试）
- 显式写 `http://` / `https://` 时原样保留；尾部 `/` 会被去掉，保存后自动请求 `/api/health` 校验。

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

## v0.7.9 新增（独立直播间 / 1080p60 / 延迟 / 域名）

- **独立直播间页面**：大厅点击直播卡片（或「进入直播间」按钮）进入全屏房间页，顶部返回 / 封面 / 标题 / 主播 / 直播状态，下方 WHEP 播放器 + 观看人数 + 延迟 + 实时弹幕与输入框；隐藏 App 头部、状态胶囊和底部导航，返回键/返回按钮/「离开直播间」回到大厅。
- **房间数据**：进入后 `GET /api/streams/:id` 拉取详情（标题、封面、`whepPath`、`viewers`、`is_live`），仅在房间页 5 秒轮询一次；WebSocket 收到 `{type:"viewers",streamId,viewers}` 时即时刷新人数；直播结束或 404 自动回大厅。
- **1080p / 60fps 容量门控**：新增 1080p（1920×1080 / 6 Mbps）与 60fps 选项，保留 720p/540p/360p 与 30/24/15。打开开播页和点击开始前 `GET /api/capacity`，`allow1080p60=false`（当前 2C/2G 服务器）时两个按钮禁用并显示原因；已保存的高画质选择会自动回退 720p/24fps。
- **码率夹取**：只有 1080p + 60fps 使用高码率；其余档位保持低码率（≤2 Mbps）。`ScreenStreamService` 对 Intent 参数和 `prepareVideo` 双重夹取，并支持 1080p 竖屏（屏幕）/横屏（摄像头）采集。
- **延迟监控**：`WebRtcPlaybackClient` 每秒 `getStats` 计算 `jitterBufferDelay / jitterBufferEmittedCount` 平均抖动缓冲 + 候选对 `currentRoundTripTime`，房间页显示「延迟≈Xms」；`close()` 停止采样并释放监听，离开/停止即清理。
- **服务器地址支持域名**：`live.example.com` 自动补 `https://`，裸 IP 默认 `http://`；保留已有协议/端口，校验 http(s)、去掉尾部 `/`；保存后自动请求 `/api/health`，中英双语提示。
- **性能**：直播间之外不创建 PeerConnection、不轮询房间详情、不启动 getStats；大厅刷新不会重建房间页；1080p60 之外不上高码率。
- **保留 0.7.8 的图标 / 中英双语 / 摄像头预览与 setZOrderOnTop / init-before-addView 修复**。
- **版本**：versionCode 21 / versionName 0.7.9，minSdk 29 / targetSdk 34。

## v0.8.0 新增（全双工语音房）

- **房间语音入口**：独立直播间新增「语音房」卡片：未加入时只有「加入语音」；点击后才申请 `RECORD_AUDIO` 并打开麦克风，未加入前不创建 PeerConnection、不占用麦克风。
- **信令协议**：复用已登录房间的 `/ws/chat` WebSocket（auth → ready 后），消息与 Web 端 `web/src/voice.ts`、后端 `backend/src/voice.js` 完全一致：
  `voice-join` / `voice-leave` / `voice-offer` / `voice-answer` / `voice-candidate`（带 `target` peerId）↔ `voice-peers` / `voice-peer-joined` / `voice-peer-left` / `voice-offer/answer/candidate`（带 `from`）/ `voice-error`。
- **Mesh 与 glare**：每个远端参与者一个 audio-only PeerConnection，本地麦克风音轨发布到每条连接；只有 peerId 字典序较小的一方主动发 offer，避免双方同时 offer 的冲突。远端音轨由 WebRTC AudioDeviceModule 自动播放，与房间内 WHEP 播放器使用各自独立的 Factory/ADM，互不冲突。
- **参与者与说话状态**：房间页显示参与者列表与连接状态；每 500ms 通过 `getStats` 的 `audioLevel`（缺省时回退 `totalAudioEnergy`）计算远端说话状态与本地麦克风音量，说话者标「🔊 说话中」。
- **静音 / 离开 / 清理**：支持静音 / 取消静音；离开语音、切换/退出直播间、直播结束、WS 断开或 Activity 销毁时发送 `voice-leave`，关闭所有 PeerConnection、释放 AudioTrack/AudioSource/ADM/EglBase 与信令监听。
- **中英双语**：语音房所有按钮、状态、错误（麦克风拒绝/占用/未找到、信令错误、限流等）均加入 L10n 字典。
- **版本**：versionCode 22 / versionName 0.8.0，minSdk 29 / targetSdk 34。0.7.9 的独立房间、1080p60 门控、延迟监控、域名服务器、图标与双语全部保留。

## v0.8.1 新增（语音房 TURN 中继）

- **TURN 凭据**：加入语音前由 MainActivity 带 Bearer 调用 `GET /api/turn-credentials`；200 时解析 `urls` / `username` / `credential`，为每个 TURN/STUN URL 构造 `PeerConnection.IceServer`（`setUsername` / `setPassword`），交给 `VoiceRoomClient` 供所有 mesh PeerConnection 复用（重连同样复用）。
- **STUN 回退**：接口 503（未配置 TURN_SECRET）、401/403 或网络失败时回退 `stun:stun.l.google.com:19302` + `stun:stun.cloudflare.com:3478` 直连，语音房仍可用。
- **中继状态**：语音卡片显示「正在获取中继凭据… / 中继：TURN（跨 NAT 更稳定） / 直连 / STUN / 无法获取 TURN 凭据（HTTP xxx），已回退 STUN 直连」，中英双语。
- **无硬编码 STUN**：`VoiceRoomClient` 只使用构造参数传入的 ICE 列表，`RTCConfiguration(iceServers)` 每个远端 peer 复用之。
- **版本**：versionCode 23 / versionName 0.8.1；0.8.0 的 lazy mic / 信令 / 说话状态 / 清理逻辑与 0.7.9 功能全部保留。
