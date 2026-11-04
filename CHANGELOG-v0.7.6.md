# CongLive v0.7.6 — UI 美化 + 封面 + Live2D 加载器

## Web
- 全新暗色渐变/玻璃拟态 UI，桌面三栏、手机单栏，响应式无溢出。
- 大厅改为 16:9 封面卡片；无封面用标题首字渐变兜底。
- 开播卡片支持上传封面：压缩到 ≤2MB JPEG dataURL，创建直播间后调用 `POST /api/streams/:id/cover`，大厅立即显示。
- Live2D 看板娘面板：输入 `.model3.json` URL，pixi.js + pixi-live2d-display 懒加载，Cubism Core 从官方 CDN 注入；不内置模型。
- 浏览器开播可勾选“叠加 Live2D”：canvas 合成视频画面 + 模型，captureStream 替换视频轨，音频保留；无模型保持原画面。
- 保留原有 WHEP 观看/WHIP 推流/弹幕逻辑。

## Android
- UI 美化：渐变背景、圆角卡片/阴影/描边、状态胶囊、五栏底部导航、按压/禁用态。
- 封面：相册选图（无存储权限）、EXIF 旋转、长边≤1280、JPEG 压缩≤2MB、上传并展示；大厅/我的直播显示封面，无封面渐变首字兜底。
- Live2D：底部“看板娘”入口，WebView 加载本地 viewer.html，CDN 加载 pixi/live2d，支持模型 URL/显示/隐藏/失败提示；不进入 WebRTC。
- 保留 0.7.5 分辨率/帧率设置与 0.7.4 预览修复。
- versionCode 18 / versionName 0.7.6。

## 后端/部署
- streams 新增 `cover_url`，GET 列表/mine 返回 `coverUrl`；封面上传接口 + `/covers` 静态服务；Nginx/Caddy 反代；上传 body 4MB。
- 测试：后端全量 **42/42**，Android 静态 12/12；Web tsc/build 通过。

## 说明
- Live2D 真实模型渲染需你提供允许 CORS 的 Cubism 3/4 `.model3.json` 地址；当前只验证了加载器/失败提示。
- Android Live2D 只做界面看板娘，不叠加进直播画面（下一阶段）。
- 屏幕 720p 观看黑屏仍在复测：0.7.6 可用开播页 360p/540p 验证。
