# Security Policy

## 报告漏洞

请**不要**在公开 Issue 中提交安全漏洞、密钥、管理员密码或服务器凭据。

优先使用 GitHub Security Advisories（仓库 **Security → Advisories → Report a vulnerability**）私下报告，并附上：

- 影响版本 / 提交
- 复现步骤与影响范围
- 必要的日志（先脱敏：不要包含 `.env`、JWT、SRS hook secret、数据库密码）

## 支持范围

当前维护 `0.7.x`。更早版本的修复会按影响评估决定是否回填。

## 部署安全清单

- 修改默认管理员密码，使用随机 `JWT_SECRET`、`SRS_HOOK_SECRET`、数据库密码。
- 不要提交 `server/.env`、`server/srs.runtime.conf`、`server/certs/`、`server/private-model/`。
- 生产环境使用 HTTPS 域名；限制 `/admin` 访问来源。
- 对公网暴露的 8000/TCP、8000/UDP 仅开放媒体所需端口。
- 定期备份 MySQL 与录像目录。
