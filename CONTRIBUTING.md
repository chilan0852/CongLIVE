# Contributing

感谢参与 CongLive。

## 开发环境

- Node.js 22、npm
- MySQL 8（后端集成）
- JDK 17 + Android SDK 35 + Gradle 8.11（Android）
- Docker / Docker Compose（媒体与部署联调）

## 提交前检查

```bash
cd backend && npm ci && npm test
cd ../web && npm ci && npm run typecheck && npm run build
cd ../android && gradle :app:assembleDebug
```

涉及媒体链路时，请同时说明测试网络（UDP/TCP、是否 CGNAT）、SRS 版本和客户端。

## Pull Request

- 从 `main` 切分支，保持改动聚焦。
- 不提交 `.env`、`srs.runtime.conf`、证书、模型文件、构建产物、录像。
- UI 改动附截图；API/Schema 改动附迁移说明。
- 新插件请放到 `backend/plugins/` 并更新 `backend/plugins/README.md`。
- 提交信息建议：`feat: ...`、`fix: ...`、`docs: ...`、`test: ...`。

## 插件

参考 `backend/plugins/plugin-template`，监听 `stream.created` / `stream.published` / `stream.unpublished`，不要阻塞主流程或吞掉异常。

## 安全

见 [SECURITY.md](SECURITY.md)。
