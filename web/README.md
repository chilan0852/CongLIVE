# CongLive Web 用户端 v0.7.1

`web/` 是 React + TypeScript 用户端。实时直播通过浏览器原生 `RTCPeerConnection` 使用 WHEP 播放，弹幕仍通过 WebSocket；不再包含 HLS.js 或 FLV.js 实时播放器。

## 页面功能

- 注册、登录、退出登录；观看直播需要登录（未登录时大厅和播放区会明确提示）。
- 只显示正在直播且有 WHEP 播放地址（`is_live === true && whepPath`）的房间。
- WebRTC WHEP 实时播放（音视频）：所有远端 track 合并进同一个 `MediaStream`，后到的音轨不会覆盖视频轨。
- 离开房间、切换房间或退出登录时关闭 PeerConnection、中止进行中的 WHEP 请求、停止远端 track 并清空 `srcObject`。
- 播放状态提示覆盖 ICE 候选收集超时、WHEP 非 2xx、SDP 无效、ICE/WebRTC 连接失败，并提供「重新连接」按钮。
- 创建直播间并显示 WHIP API 路径。
- 浏览器开播（WHIP）卡片：视频源（摄像头 / 屏幕共享）、分辨率（720p 1280×720 / 540p 960×540 / 360p 640×360）、帧率（30/24/15 fps）、可选直播标题、开始/停止按钮与本地预览 `video`。
- 开播流程：校验登录 → `POST /api/streams` 创建直播间（取 `id`、`publishPath`）→ `getUserMedia` / `getDisplayMedia`（video constraints 带 ideal 宽高与帧率，audio 开启）→ `RTCPeerConnection`（H.264 优先，`transceiver.setCodecPreferences`）→ `createOffer` → 等待 ICE gathering → `POST ${API}${publishPath}`（`Authorization: Bearer`、`Content-Type: application/sdp`）→ `setRemoteDescription(answer)`。
- 停止推流：关闭 PeerConnection、停止所有本地 track、清空预览 `srcObject`，SRS 收到 `on_unpublish` 后直播间下线；屏幕共享 track `ended` 时自动停止。错误提示覆盖登录失效、权限拒绝、设备占用、SDP/信令失败等。
- 非安全上下文（`http://IP`）下禁用开播按钮并提示「浏览器推流需要 HTTPS」，观看、WHEP 播放与弹幕不受影响。
- 登录后通过 WebSocket 收发实时弹幕。

## UI 重做 + 封面 + Live2D（v0.7.6 Web）

- 暗色渐变视觉重做：玻璃拟态顶栏与卡片层级、统一圆角/阴影/间距、桌面双栏与手机单栏响应式；顶栏在手机上收成「品牌 + 登录」一行与横向可滚动的 5 个导航项，不会挤压。
- 直播大厅改为封面卡片网格：封面固定 16:9（`aspect-ratio: 16/9` + `object-fit: cover`），显示 `coverUrl`；没有封面时用按直播间 id 派生的渐变 + 标题首字兜底。
- 封面上传：开播卡片可选图片，前端用 Canvas 压到 **≤2MB 的 JPEG dataURL**（编码后 dataURL 长度与解码字节双重校验），开播时在新直播间创建后调用 `POST /api/streams/:id/cover`（请求体 `{ imageData }`，响应 `{ coverUrl }`）；上传失败只提示、不阻断开播。另可为「最近创建」的直播间单独上传封面。
- Live2D 看板娘面板：输入 `.model3.json` URL 加载（pixi.js 6 + pixi-live2d-display，懒加载动态 import；Cubism Core 从 `cubism.live2d.com` CDN 动态注入，失败回退 unpkg），不内置任何模型；支持加载/卸载、显示/隐藏、ResizeObserver 尺寸自适应与明确的失败提示（CORS、WebGL、CDN 等）。
- Web 推流 Live2D 叠加：开播卡片可勾选「叠加 Live2D 看板娘」。有模型时用隐藏 `<video>` + 2D Canvas 逐帧合成相机/屏幕画面与模型画布，`canvas.captureStream()` 产生视频轨并通过 `sender.replaceTrack()` 替换原视频轨（音频轨保留，推流中可热开关）；没有模型时保持原始画面并提示。
- 新增模块：`src/cover.ts`（封面压缩/上传）、`src/live2d.ts`（模型加载器）、`src/overlay.ts`（画面合成）。

## 中英双语切换（i18n）

- `src/i18n.ts` 提供完整 `zh` / `en` 两套字典、`t(key, params)`（`{name}` 占位符）、`useLang()` / `setLang()` 与 `translateMessage()`。
- 语言选择顺序：`localStorage["conglive.lang"]` → `navigator.language`（中文环境默认中文，其余默认英文）。顶栏「中文 / English」切换即时重渲染，并同步 `<html lang>` 与 `document.title`。
- `main.tsx` 的全部用户可见文案（品牌、导航、大厅、WHEP/WHIP 状态与错误、登录注册、开播、封面、Live2D、弹幕、空状态、按钮、`title`/`aria-label`）均走字典；动态值使用占位符。
- `live2d.ts` / `cover.ts` / `overlay.ts` 的用户提示通过 `LocalizedError` + `TextMessage` 描述符传递，在渲染时才翻译，因此刷新语言后已产生的状态/错误文本也会跟着切换。
- 后端中文错误在英文界面下做客户端映射（401/403/404/409/413/429/502/504 与“需要登录 / 主播尚未开播 / 直播间不存在”等常见提示）；无法识别的错误保留原文。

## 本地开发

Node.js 20+：

```bash
npm install
npm run dev
```

开发服务器默认 `0.0.0.0:5173`。同源 API 使用相对路径；可通过 `VITE_API_URL` 指定后端 URL。

构建与类型检查：

```bash
npx vite build
npm run typecheck
```

## 部署

```bash
cd ../server
docker compose up -d --build web
```

IP 测试入口 `http://服务器IP:8081/`；域名 HTTPS 入口 `https://域名/`。管理后台源文件位于 `../webui/admin.html`，访问 `/admin`。

浏览器开播需要安全上下文（secure context）：`http://localhost` / `http://127.0.0.1` 或 HTTPS 域名；通过 `http://服务器IP:8081/` 访问时开播按钮会禁用并提示「浏览器推流需要 HTTPS」，观看与弹幕仍可正常使用。
