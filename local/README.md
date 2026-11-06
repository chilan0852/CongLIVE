# CongLive 本地 LAN 主机

没有公网服务器时，用 PC 做主机，手机/其他电脑连同一 Wi-Fi 使用。

## 要求
- Windows 10/11 + Docker Desktop（含 compose v2），或 macOS/Linux + Docker
- 防火墙放行 **8081/tcp** 和 **8000/tcp+udp**
- 手机与 PC 同一局域网

## 启动
Windows PowerShell：
```powershell
powershell -ExecutionPolicy Bypass -File local/start.ps1
```
macOS/Linux：
```bash
bash local/start.sh
```

启动后访问 `http://<PC-局域网IP>:8081`；管理员账号/密码会打印在终端。
手机浏览器打开同一地址即可登录、开播、观看、聊天和加入语音房。

## 停止
```bash
docker compose -p conglive-local --env-file local/.env.local -f server/docker-compose.yml down
```

## 说明
- 该方案复用正式 backend/web/SRS/MySQL 栈，视频和语音都是真实 WebRTC。
- `local/.env.local` 保存本机密码/密钥，已被 gitignore。
- 公网/域名部署仍使用 `server/install.sh`。
