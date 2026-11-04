# CongLive v0.7.3 — 黑屏修复

本版修复 v0.7.1/0.7.2 摄像头预览与 WHEP 观看黑屏。

## 根因
- `SurfaceViewRenderer` 先 `addView` 到窗口、后 `init(EGL)`，部分机型不会再触发 `surfaceCreated`，导致预览和播放器全黑。服务端录像正常，证明采集/推流本身成功。
- 同时把 H.264 编码器的高 Profile 选项关闭，避免推流实际为 High Profile、SDP 协商为 Baseline 的错配。
- 停止在每条状态广播时重建预览 Renderer，避免反复 release/init。

## 改动
- 摄像头预览、WHEP 播放器均改为 **先 init，再 addView**。
- `DefaultVideoEncoderFactory(..., true, false)`，优先 H.264 Baseline。
- 状态广播只在摄像头预览显示状态变化时重绘。
- 增加首帧 `/logcat` 诊断：`CongLive: camera preview first frame`、`whep first frame rendered`。
- versionCode 15，versionName 0.7.3。

## 验证
- `assembleDebug` 成功，APK 约 63 MB。
- 后端测试 24/24。
- 真机安装后检查：预览有画面、WHEP 出画面、SRS 新推流 profile 应为 Baseline（若厂商仍强制 High，需要自定义 VideoEncoderFactory）。

## 注意
- 本包需要重新构建并覆盖安装 APK；服务端无需改动。
