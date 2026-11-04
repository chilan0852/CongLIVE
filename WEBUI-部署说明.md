# 葱直播 CongLive WebUI 部署说明（v0.7.0）

- 用户端源码：`web/`，访问 `/`。
- 管理后台源码：`webui/admin.html`，访问 `/admin`。
- API/WebSocket：`backend/`，提供 REST 和 `/ws/chat`。
- 实时直播由浏览器 WHEP/WebRTC 播放，不使用 HLS/FLV。

安装：

```bash
cd CongLive
sudo bash server/install.sh
```

更新：

```bash
cd CongLive/server
docker compose up -d --build backend web
docker compose restart srs
```

更改 SRS 配置时重启 `srs`。实时媒体需要在 VPS 云防火墙和主机防火墙放行 UDP/TCP 8000。`CANDIDATE` 必须为公网可达 IP。域名模式由 Caddy 负责 HTTPS，建议正式部署使用域名。

页面地址：

| 页面 | 域名 HTTPS | IP 测试模式 |
|---|---|---|
| 用户端 | `https://你的域名/` | `http://服务器IP:8081/` |
| 管理后台 | `https://你的域名/admin` | `http://服务器IP:8081/admin` |

注意：管理员独立账号由安装脚本生成；WebRTC 播放/推流需要 SRS ICE 候选 IP 正确，且开放 UDP/TCP 8000。当前未包含 TURN 服务；部分 NAT 环境可能需要额外部署。
