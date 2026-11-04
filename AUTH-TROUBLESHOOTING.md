# 葱直播 v0.6.1 登录 / 注册排查

## Android 手机的服务器地址

v0.6 原始默认地址 `http://10.0.2.2:3000` 只给 Android Studio 模拟器使用，真实手机不能用它连接远程 VPS。

打开 App 的登录/注册页面，在“服务器 API 根地址”填入：

- IP 测试模式：`http://你的VPS公网IP:3000`
- 已配置 HTTPS 域名：`https://你的域名`

不要填写 `127.0.0.1`、`10.0.2.2`、RTMP 端口 `1935`，也不要在末尾添加 `/api`。保存后点击“保存地址并检查服务器”。看到“API 正常，数据库：ok”后再注册。

## 账号规则

- 用户名：3–40 位中文、字母、数字或下划线；不允许空格和其他特殊符号。
- 密码：8–128 个字符。
- 注册成功后，再单独点击“登录”。
- Android 普通用户登录不能使用 Web 管理后台的 `admin` 管理员密码；两者是不同账号系统。

## VPS 端检查

在 VPS 执行：

```bash
cd /你的项目路径/CongLive/server
docker compose ps
curl -i http://127.0.0.1:3000/api/health
docker compose logs --tail=100 backend mysql
```

健康检查应返回 HTTP 200，JSON 中应有 `"ok":true` 和 `"database":"ok"`。如果本机检查正常但手机检查失败，通常是云防火墙/UFW 未开放 TCP 3000，或 App 填错了公网地址。若使用域名 HTTPS，则检查域名解析、80/443 端口和 Caddy 容器状态。

## 更新 v0.6.1

先备份 `server/.env`、`server/recordings/` 和 MySQL Docker volume。将完整升级包覆盖到原项目目录（保留 `.env` 和数据目录），然后执行：

```bash
cd CongLive/server
sudo bash install.sh
```

安装不会要求删除数据库卷；不要执行 `docker compose down -v`。
