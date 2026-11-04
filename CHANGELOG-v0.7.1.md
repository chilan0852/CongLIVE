# CongLive v0.7.1 — Android Camera2 采集

- Android 开播页面新增「屏幕直播 / 摄像头直播」视频源选择。
- 摄像头模式优先使用 Camera2Enumerator + CameraVideoCapturer，不兼容设备回退到 Camera1Enumerator，支持前置/后置摄像头切换。
- 增加本机摄像头预览，复用 WebRTC 本地 VideoTrack，不增加第二条 WHIP 视频轨道。
- 新增 CAMERA 和 FOREGROUND_SERVICE_CAMERA 权限声明；只在用户选择摄像头模式并授权后启动。
- 摄像头采集纳入前台服务，停止时关闭 capturer、释放 VideoTrack/VideoSource/EGL 资源。
- WHIP 的同类媒体轨道约束下，摄像头与屏幕为互斥来源；本版未实现 PiP 画中画合成。
- 版本号更新到 Android 0.7.1 / versionCode 13。
