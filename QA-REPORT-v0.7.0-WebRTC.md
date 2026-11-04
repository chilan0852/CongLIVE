# CongLive v0.7.0 WebRTC 重构验收报告

验收日期：2026-11-04  
基线：用户提供的 `CongLive-v0.6.5-全部源码-20261104 (1).zip`

## 自动化测试

- `cd backend && npm test`：**17/17 通过**，0 失败。
- 后端 JS：`node --check` 检查 `backend/src/*.js`、插件脚本和测试脚本，通过。
- Web TSX：使用 TypeScript 5.8.3 `transpileModule` 做语法转译检查，0 个错误。
- Shell：`bash -n server/install.sh server/manage.sh server/fix-live-status.sh`，通过。
- JSON：backend/web `package.json`，通过。
- XML：AndroidManifest，解析通过。
- YAML：Docker Compose，解析通过。
- Nginx：在临时 `http {}` 测试配置中替换 Docker 内部 upstream 名称后，`nginx -t` 通过。
- ZIP：最终交付包执行 `unzip -t` 检查。

17 个 Node 测试覆盖 MySQL BOOLEAN 兼容、SRS WHIP/WHEP/DVR 配置、Docker 媒体端口暴露、Android WebRTC/MediaProjection、Web WHEP、在线直播列表过滤、录像 URL/归属检查、候选 IP 部署检查、WebUI 路由和插件接口等。

## 无法在本虚拟环境完成的测试

- **Docker / SRS / MySQL 集成：未运行。** 当前容器没有 Docker Engine/Compose，无法构建并启动 SRS、MySQL、API 和 Web 容器。
- **Android APK：未编译。** 当前没有 Android SDK、Gradle 或 Android Studio。`kotlinc` 解析 Kotlin 源文件时因缺少 Android SDK 与 WebRTC/Media3/AndroidX classpath 而报告大量 unresolved reference；未发现 Kotlin parser 的 `expecting`、`unexpected tokens` 等语法诊断。这不是完整编译通过。
- **Web 正式构建：未完成。** `npm install` 在当前环境无法正常完成（依赖下载超时），因此不能声称 Vite production build 成功。TSX 语法转译检查通过不等于生产构建通过。
- **公网 WHIP/WHEP、ICE、真实手机网络：未测试。** 需要真实 VPS 公网 IP、云防火墙和 Android 设备。
- **MP4 录制/Range 回放：未集成测试。** 需在 SRS 运行后确认 RTC→RTMP 转封装和 DVR 实际生成文件。

## 当前明确的功能边界

1. Android WebRTC 推流当前接入麦克风；`AudioPlaybackCapture` 系统内录 PCM 混音尚未接入自定义 WebRTC ADM。
2. 当前 Compose 没有部署 TURN。SRS 配置 UDP/TCP 8000，部分受限 NAT/网络环境仍可能需要 TURN 中继。
3. Web 用户端当前实现 WHEP 观看；屏幕发布端仍以 Android WHIP 为主，浏览器端 WHIP 屏幕发布按钮未实现。
4. 新版实时链路为 WebRTC WHIP/WHEP；旧版已有 MySQL 用户、直播元数据、弹幕和 MP4 文件保留。历史 HLS/FLV 文件不自动转换。
5. 本交付为源码项目，不包含 APK；没有做过真机端到端验收，部署前应先在测试 VPS 验证。

## 部署前重要条件

- SRS 固定 `ossrs/srs:v6.0.195`，使用 WHIP/WHEP、RTC→RTMP 和 MP4 DVR。
- `server/.env` 中的 `CANDIDATE` 必须是客户端可访问的公网 IPv4。
- 公网云防火墙和 UFW 必须允许 UDP/TCP 8000；HTTPS 域名模式还需 TCP 80/443。
- SRS 管理 API 1985、RTMP 1935 和 MySQL 3306 不应对公网开放。
- Android 构建建议使用 JDK 17、Android SDK 35、AGP 8.7.3、Kotlin Gradle Plugin 2.3.21 和 Gradle 8.9 或兼容版本。KGP 2.3.21 与 AGP 8.7.3 位于 Kotlin 官方兼容范围内。

## 官方技术参考

- SRS 6 WebRTC / WHIP / WHEP：https://ossrs.net/lts/zh-cn/docs/v6/doc/webrtc
- SRS 6 HTTP Callback：https://www.ossrs.net/lts/en-us/docs/v6/doc/http-callback
- SRS 6 HTTP API：https://www.ossrs.net/lts/en-us/docs/v6/doc/http-api
- SRS Releases：https://github.com/ossrs/srs/releases
- Kotlin Gradle Plugin Compatibility：https://kotlinlang.org/docs/gradle-configure-project.html
- Android Gradle Plugin / Gradle compatibility：https://developer.android.com/build/releases/about-agp
