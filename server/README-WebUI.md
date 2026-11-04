# CongLive Web 与管理后台说明（v0.7.0）

## 页面入口与源码

- `web/`：React 用户端，浏览器通过 WHEP/WebRTC 播放，WebSocket 实时弹幕。
- `webui/admin.html`：管理员页面，含直播、用户、录像、插件、操作日志管理。
- `backend/src/index.js`：REST API、WHIP/WHEP 鉴权代理、SRS hooks、WebSocket。
- `server/srs.conf`：SRS 6 WebRTC、RTC→RTMP、MP4 DVR 配置。

域名模式：`https://域名/` 用户端；`https://域名/admin` 管理后台。
IP 测试模式：`http://服务器IP:8081/` 用户端；`http://服务器IP:8081/admin` 管理后台。

## 媒体模式

- Android WHIP 发布：`POST /api/streams/:id/whip`。
- Android/Web WHEP 播放：`POST /api/streams/:id/whep`。
- SRS HTTP API `1985` 只在 Docker 内部可访问。
- 公网只开放 WebRTC UDP/TCP 8000；SRS RTMP `1935` 仅供内部 RTC→RTMP 录像转封装，不映射公网。
- 实时评论使用独立 WebSocket `WS(S) /ws/chat`。

## 安装与更新

首次安装：`sudo bash server/install.sh`。升级前备份 `.env`、数据库和 `recordings/`。更改 `srs.conf` 时重启 SRS：

```bash
cd server
docker compose config -q
docker compose up -d --build backend web
docker compose restart srs
```

Web 管理后台由 backend 镜像从项目根目录 `webui/admin.html` 复制进 `/app/public/admin.html`。必须通过项目根目录中的 Compose 构建上下文构建，不要单独在 `backend/` 运行 `docker build`。

## 网络要求

在 VPS 云防火墙/安全组以及 UFW 中开放 UDP 8000 和 TCP 8000。`CANDIDATE` 必须设置为客户端能访问的公网 IP；SRS 会把该地址写入 SDP。TCP 3000/8081 仅 IP 测试模式开放；域名模式建议只开放 80/443。不要公开 SRS 1985 和 MySQL 3306。

当前配置未部署 TURN。若部分移动网络/企业网络无法建立 ICE 连接，需要增配 TURN 并让 Android/Web 客户端使用相应 ICE server。
