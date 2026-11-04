# CongLive v0.7.1 Camera2 摄像头功能验收报告

验收日期：2026-11-04  
基线：用户上传的 CongLive v0.6.5 全源码，经 v0.7.0 WebRTC 重构后添加 Camera2 摄像头采集。

## 已完成的功能接入

- Android 开播页可选择「屏幕直播」或「摄像头直播」。
- 摄像头模式在用户主动开始后才请求 `CAMERA` 运行时权限；权限拒绝时不会启动 CameraCapturer。
- 优先使用 `Camera2Enumerator`；若设备 Camera2 支持等级不满足要求，则回退 `Camera1Enumerator`。
- 支持前/后摄切换；本地 `SurfaceViewRenderer` 预览挂接同一条 WebRTC `VideoTrack`。
- 摄像头/屏幕共用 WHIP endpoint 和现有服务端录制链路；视频源互斥。
- 停止时停止并释放 capturer、清理预览 sink、video/audio track、source、SurfaceTextureHelper、PeerConnectionFactory 和 EGL。
- 增加 `CAMERA`、`FOREGROUND_SERVICE_CAMERA` 权限和 camera 前台服务类型；Android 10 的前台服务类型采用版本兼容分支。
- Android 版本号更新为 `0.7.1` / `versionCode 13`。

## 自动化检查

- `cd backend && npm test`：**23/23 通过**，0 失败。新增 6 项摄像头专项静态回归测试。
- `bash -n server/install.sh server/manage.sh server/fix-live-status.sh`：通过。
- AndroidManifest XML：解析通过。
- Docker Compose YAML：解析通过。
- Kotlin 源文件经本机 `kotlinc` 解析尝试：未发现 `expecting` / `unexpected tokens` 等语法解析错误；编译因环境缺少 Android SDK、AndroidX、OkHttp、Media3 和 WebRTC SDK classpath 而失败，不能视为 Android 编译通过。
- ZIP 文件完整性：交付打包后使用 `unzip -t` 检查。

## 未完成的真实环境验证

- 未执行 `:app:assembleDebug`：虚拟环境没有 Android SDK/Gradle 与依赖缓存。
- 未在真实手机打开摄像头、进行前后摄切换、测量帧率或验证横竖屏方向。
- 未通过 VPS/SRS 真正 WHIP 推流并由另一台设备 WHEP 观看摄像头画面。
- 未验证不同厂商 Camera2 实现及 Android 10–14/15 前台服务限制的真机行为。

## 协议与功能边界

WHIP RFC 9725 规定单个 MediaStream 不得包含两个相同媒体类型的 MediaStreamTrack。本版因此复用一条视频轨道，在屏幕采集与摄像头采集之间选择；不把两个视频轨道并行塞入 WHIP，也没有实现屏幕+摄像头画中画合成。

## 建议真机验收步骤

1. 安装 v0.7.1 APK，登录测试账号并创建直播间。
2. 选择摄像头直播，确认 Android 系统弹出 CAMERA 权限请求。
3. 拒绝权限，确认摄像头没有启动；重新授权后再次开始。
4. 确认本机预览显示，切换前摄/后摄。
5. 用另一台设备进入直播大厅，确认 WHEP 能看到摄像头画面和麦克风声音。
6. 停止直播，确认摄像头指示灯关闭、前台通知消失、录像正常生成。
7. 再测试屏幕直播，确认原 MediaProjection 流程未受影响。
