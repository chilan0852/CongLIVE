# CongLive v0.5 升级说明

## 从 v0.4 升级前

1. 备份 `server/.env`。
2. 备份 MySQL Docker volume（不要删除 volume）。
3. 备份 `server/recordings/` 中的录像文件。
4. 如果正在直播，先结束直播再升级。

不要执行 `docker compose down -v`，否则会删除 MySQL 数据卷。

## 安装/升级

把新版压缩包解压到项目目录，保留原来的 `server/.env`、`server/recordings/` 和 Docker 的 `mysql_data` volume。然后执行：

```bash
cd CongLive
sudo bash server/install.sh
```

安装脚本会重建 backend 和 web 镜像、启动服务，并在 API 启动时自动迁移旧数据库。迁移只新增字段和表，不删除用户、直播记录或录像。

## 访问地址

- 域名模式：用户端 `https://你的域名/`，管理后台 `https://你的域名/admin`
- IP 测试模式：用户端 `http://服务器IP:8081/`，管理后台 `http://服务器IP:8081/admin`

安装脚本会显示管理员密码，账号默认为 `admin`。也可在 `server/.env` 查看 `ADMIN_PASSWORD`。

## 端口

| 端口 | 用途 | 是否建议公网开放 |
|---|---|---|
| 1935/TCP | RTMP 推流 | 是 |
| 80、443/TCP | Caddy 域名访问 | 配置域名时开放 |
| 8081/TCP | IP 模式 Web 入口（API、WebSocket、HLS 代理） | IP 模式开放；域名模式仅本机绑定 |
| 3000/TCP | IP 模式 API 直连 | 可选；建议只通过 Web 代理访问 |
| 8080/TCP | SRS HTTP 内部服务 | 否，安装脚本绑定 127.0.0.1 |
| 1985/TCP | SRS 管理 API | 否，绑定 127.0.0.1 |
| 3306/TCP | MySQL | 否，绑定 127.0.0.1 |

## 新增功能

- 用户端：登录后加入正在直播的房间，实时收发弹幕评论；消息保存在 MySQL。
- 直播管理：封禁、解封、软删除；操作会尝试通过 SRS API 断开当前推流。
- 用户管理：封禁、解封；被封禁账号不能登录、调用需登录 API 或新推流。
- 录像：浏览文件、在线回放、永久删除。回放 URL 采用 6 小时有效期签名并支持 HTTP Range。
- 插件：后台运行时启停，状态保存在 MySQL。
- 操作日志：记录封禁、删除、录像删除和插件开关等管理动作。

## 部署注意

整套服务包含 MySQL、SRS、API、Nginx Web 和可选 Caddy，建议至少 2GB RAM。录像存储位于 `server/recordings/`；HLS 临时/播放文件位于 `server/srs-html/`。请为录像目录预留足够容量并定期备份。

当前版本已完成 Node/Shell/Compose YAML/React TSX 语法级检查和插件启停烟雾测试；尚未在真实 VPS 上完成 Docker 镜像构建、真实浏览器/手机推流联调和并发压力测试。
