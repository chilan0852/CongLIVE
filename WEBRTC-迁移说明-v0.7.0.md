# CongLive v0.7.0 WebRTC 全面迁移说明

## 本次迁移边界

实时音视频通道改为 WebRTC：

| 客户端动作 | 新协议 | API 路由 |
|---|---|---|
| Android 屏幕推流 | WHIP | `POST /api/streams/:id/whip` |
| Android 观看直播 | WHEP | `POST /api/streams/:id/whep` |
| Web 观看直播 | WHEP | `POST /api/streams/:id/whep` |
| 实时弹幕 | WebSocket | `/ws/chat` |
| 录像回放 | HTTPS Range / MP4 | `/api/recordings/:id` |

旧 RTMP/HLS/HTTP-FLV 客户端路径已从本版用户端移除。已有 MySQL 账号、直播元数据、弹幕和旧 MP4 文件保留；历史 `.ts` / `.m3u8` / `.flv` 若存在不会自动转换。

## 为什么采用 SRS WHIP/WHEP

SRS 6 Stable 实现 WHIP/WHEP 与 SFU 转发。后端不公开 SRS 管理 API，通过 JWT 验证用户/直播归属后代理 SDP；SRS 再通过 HTTP hooks 回调后端，确认发布和播放授权。SRS 的 `CANDIDATE` 需是远端客户端可访问的地址，WebRTC 媒体走 UDP 默认通道或 TCP fallback 8000。

## 录像

为了保留 MP4 DVR，SRS 开启 `rtc_to_rtmp on`，把 RTC 流转封装到内部 RTMP 管线，再由 SRS DVR 写入 `server/recordings/`。SRS 的 TCP 1935 不映射到宿主机公网。Android 当前优先协商 H.264；请在真机验收中确认 SRS 录制文件能正常产出并能通过 Range API 播放。

## Android 音频差异

本版 WebRTC ADM 已接入麦克风；Android 内部播放声音（AudioPlaybackCapture）需要自定义 ADM/PCM 采样混音，当前版本尚未完成。仅获取 RECORD_AUDIO 权限不代表系统播放音频已传输。需要完整系统内录时应单独开发混音路径并进行真机兼容性测试。

## 服务端升级

1. 备份 `server/.env`、MySQL volume、`server/recordings/`。
2. 更新整个源码目录，不要只覆盖 Android。
3. 确认 `server/.env` 的 `CANDIDATE` 是公网 IPv4；如错误需手动修改。
4. 云防火墙和 UFW 开放 UDP 8000、TCP 8000；域名模式开放 TCP 80/443。
5. 执行：

```bash
cd CongLive/server
docker compose config -q
docker compose up -d --build backend web
docker compose restart srs
```

6. 查日志：

```bash
docker compose ps
docker compose logs --tail=200 srs backend
```

7. 使用新 v0.7.0 Android APK；旧 APK 仍用旧协议，不能与本版媒体链路混用。

## 检查顺序

- `/api/health` 返回 `media: webrtc-whip-whep`。
- 新建直播间后，Android 发起 WHIP 时后端无 502。
- SRS HTTP `on_publish` hook 接受并更新直播为在线。
- 浏览器/Android WHEP 能协商、ICE connected、收到音视频轨道。
- 停止直播后 `on_unpublish` 更新离线；DVR 目录出现 MP4。
- 后台录像列表可列出新 MP4，Range 回放返回 200/206。
- 弹幕仍可通过 WebSocket 发送和接收。

## 未完成/待真实环境验收

- Android APK 构建和实体机验证需要 Android SDK/Gradle/设备。
- Docker/SRS/MySQL 集成联调需部署环境。
- 当前未部署 TURN；受限 NAT 网络需增配 TURN。
- 系统声音内录与麦克风混音尚未完成。
- 当前 Web 前端是观看端，浏览器端屏幕 WHIP 发布按钮尚未实现；Android 是正式推流端。
