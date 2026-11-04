# CongLive v0.7.0 — WebRTC 全面迁移

- Android 直播推流迁移为 WebRTC WHIP + H.264 优先。
- Android 原生观看和 Web 用户端迁移为 WebRTC WHEP。
- SRS 升级/固定为 `ossrs/srs:v6.0.195`，作为 SFU。
- SRS 开启 UDP/TCP 8000、RTC→RTMP 内部转封装和 MP4 DVR。
- WHIP/WHEP SDP 由 Express API 代理，JWT 校验用户，SRS HTTP hooks 决定是否接受发布/播放。
- 移除实时 HLS/HTTP-FLV 客户端依赖和公开 RTMP 端口映射。
- 保留账号、MySQL、WebSocket 弹幕、管理后台、插件、操作日志和已生成 MP4 录像。
- Android 当前已接入麦克风；系统播放声音的 AudioPlaybackCapture→WebRTC PCM 混音尚未完成。
- 首次交付为源码版，需在 Android Studio/VPS 上构建与实测。
