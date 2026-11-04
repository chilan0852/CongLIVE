# Third-Party Notices

本项目自有代码采用 [MIT](LICENSE)。以下组件/服务由第三方提供，适用其各自许可证；本文件是工程清单，不构成法律意见，实际以各上游 LICENSE 为准。

| 组件 | 用途 | 许可证 / 说明 |
|---|---|---|
| SRS 6 (`ossrs/srs`) | WebRTC SFU / DVR | MIT（见上游 LICENSE） |
| MySQL 8.4 | 数据库 | GPL-2.0（含 FOSS Exception；以 Oracle 发布为准） |
| Node.js 22 / Alpine | 运行时/镜像 | MIT 及镜像内各组件许可证 |
| Express 4 | HTTP API | MIT |
| ws / jsonwebtoken / mysql2 / bcryptjs / cors / dotenv | 后端依赖 | MIT（bcryptjs 为 MIT） |
| React 18 / React DOM | Web UI | MIT |
| Vite 6 | Web 构建 | MIT |
| TypeScript 5 | 类型检查/构建 | Apache-2.0 |
| pixi.js 6 | WebGL 渲染 | MIT |
| pixi-live2d-display 0.4 | Live2D 加载 | MIT |
| Live2D Cubism Core | Live2D 运行时 | **专有软件**，从官方 CDN 运行时加载，仓库不包含；使用需遵守 Live2D 条款 |
| AndroidX / Media3 / OkHttp | Android 依赖 | Apache-2.0 |
| WebRTC Android SDK (`io.github.webrtc-sdk:android`) | Android WebRTC | BSD-3-Clause |
| Caddy 2 / Nginx | HTTPS / 静态服务 | Apache-2.0 / BSD-2-Clause |
| Noto Sans CJK | 宣传片字体（系统字体，不随仓库分发） | SIL Open Font License 1.1 |
| FFmpeg | 构建宣传片的工具，不随仓库分发 | LGPL/GPL（取决于构建选项） |

## 模型与素材

- 仓库**不包含**任何 Live2D 模型（`.moc3`、`.model3.json`、纹理、动作、表情）或 Cubism Core 文件。
- 模型作者的使用须知可能禁止再分发；部署者必须自行取得授权，不要把受限模型放到公开可下载位置。
- 示例截图和宣传片不展示第三方模型形象；宣传片音效由项目自带 `make_audio.py` 合成。

## 商标

“CongLive / 葱直播”是本项目的名称。其他名称、商标和品牌归各自权利人所有；本项目不声称获得其授权或背书。
