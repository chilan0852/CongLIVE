# CongLive Web 用户端 v0.8.1（开播工作台 + 房间语音房 + TURN 中继）

`web/` 是 React + TypeScript 用户端。实时直播通过浏览器原生 `RTCPeerConnection` 使用 WHIP 开播 / WHEP 播放，弹幕与语音房信令共用一个已登录的 `/ws/chat` WebSocket；语音媒体是浏览器之间的全双工 mesh，服务端只转发信令，不做媒体转发。

## 路由

| 路径 | 页面 |
|---|---|
| `/` | 直播大厅 + 浏览器开播卡片 + Live2D 看板娘（原有首页，保持可用） |
| `/room/<id>` | 独立直播间：WHEP 播放、延迟/人数、弹幕、**语音房**、主播专属「开播工作台」入口 |
| `/studio` | **开播工作台**（PC 宽屏优先）：分步配置 → WHIP 开播 |

History API 路由，刷新/直达由 nginx 的 SPA fallback（`try_files $uri $uri/ /index.html`）支持；`nginx.conf` 无需改动。

## 一、开播工作台 `/studio`

四步向导，所有采集/封面/Live2D/WHIP 逻辑复用首页同款模块：

1. **设备采集**：视频源（摄像头 / 屏幕共享）、分辨率（1080p/720p/540p/360p）、帧率（60/30/24/15，受 `GET /api/capacity` 限制）、摄像头与麦克风设备选择、「检测设备并预览」、**实时麦克风电平条**（WebAudio AnalyserNode，显示 0–100 电平与 dB）。开播时直接复用这里的采集流，不会重复请求设备权限。
2. **画面与看板娘**：加载 Cubism `.model3.json`（复用 `live2d.ts`）、显示/隐藏/卸载、实时预览舞台、**开播时叠加 Live2D** 开关（复用 `overlay.ts` 的 2D Canvas 合成）。
3. **直播信息**：直播标题、封面（复用 `cover.ts`，本地压缩到 ≤2MB JPEG dataURL，开播时上传）。
4. **开播**：摘要确认、麦克风电平、**开始 WHIP 开播 / 停止开播**、开播状态、直播间入口、错误与成功提示。开播流程与首页开播卡片完全一致（创建直播间 → 上传封面 → 采集 → 合成 Live2D → WHIP SDP 协商 → SRS）。

实现要点：

- `src/whipPublisher.ts` 是唯一的 WHIP 会话引擎（`WhipPublisher`），首页开播卡片与 `/studio` 都用它；`stop()` 幂等释放 `AbortController`、`RTCPeerConnection`、合成 Canvas、隐藏 `<video>`、摄像头/麦克风轨道与预览。
- 工作台的发布会话由 `App` 持有，**离开 `/studio` 不会中断正在进行的推流**（主播可以先开播再打开自己的直播间）；停止/失败/源轨道结束都会统一释放并刷新大厅。
- 未加载 Live2D 模型时叠加开关会明确提示「保持原始画面」；开播中可热切换叠加（只替换视频轨，音频保留）。
- 非 HTTPS 安全上下文、未登录、无设备、权限拒绝、设备占用、屏幕共享取消等都有明确提示。

## 二、独立直播间语音房

在 `/room/<id>` 的右栏（PC 宽屏）或页面下方（移动端）：

- **加入 / 离开语音**：点击「加入语音」才请求麦克风并建立连接；未加入时页面不占用麦克风、不建 PeerConnection、不创建 AudioContext。
- **静音 / 取消静音**：只切换本地音轨 `track.enabled`，不断开 mesh。
- **参与者列表**：自己 + 远端听众，显示连接状态与「说话中」实时指示（本地与远端都通过音量电平检测）；主播在列表中有「主播」徽章。
- **远端声音自动播放**：为每个远端 peer 创建隐藏 `<audio autoplay playsinline>`；浏览器拦截自动播放时显示「点击恢复声音」。
- **TURN 中继 / STUN 回退**：点击「加入语音」时先带 Bearer token 请求 `GET /api/turn-credentials`；成功则把返回的 `urls` / `username` / `credential` 作为 `iceServers` 传给 mesh，面板显示「中继：TURN（跨 NAT 更稳定）」；401/404/503/网络失败或无有效 URL 时回退到两个公共 STUN（`stun:stun.l.google.com:19302` + `stun:stun.cloudflare.com:3478`），面板显示「中继不可用 · 直连 / STUN」并附带 HTTP 状态说明（中英双语）。凭据只用于本次加入/重连，所有远端 peer 复用同一份 ICE 配置；TURN 失败不会阻塞语音。
- **错误提示**：未登录、语音房不可用（直播间结束/无权限）、麦克风权限拒绝/未找到/被占用、信令错误（`voice-error` 各 code 映射）、连接断开等都有中英双语提示与「重新加入」。

### 信令协议（与后端 task-7 `backend/src/voice.js` 对齐）

复用已登录的房间 WebSocket `/ws/chat`（先 `auth` → 收到 `ready`）。另外开一条独立连接用于语音，不干扰弹幕 socket。

TURN 凭据接口（与后端 task-10 对齐）：

```http
GET /api/turn-credentials
Authorization: Bearer <token>
200 { "urls": ["turn:域名:3478?transport=udp", "turn:域名:3478?transport=tcp", "stun:域名:3478"],
      "username": "<expiry>:conglive", "credential": "<base64 HMAC-SHA1>", "ttl": 3600 }
503 { "error": "TURN 中继未配置，已回退 STUN 直连" }
```

客户端只消费该响应，不持有 TURN_SECRET；凭据短时有效，重新加入/重连时会重新获取。coturn `use-auth-secret` 的服务端部署见 `server/`（task-10）。

客户端 → 服务端：

```jsonc
{ "type": "voice-join" }
{ "type": "voice-leave" }
{ "type": "voice-offer",   "target": "<peerId>", "sdp": { "type": "offer",  "sdp": "v=0..." } }
{ "type": "voice-answer",  "target": "<peerId>", "sdp": { "type": "answer", "sdp": "v=0..." } }
{ "type": "voice-candidate", "target": "<peerId>", "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }
// candidate 也允许 null（end-of-candidates）
```

服务端 → 客户端：

```jsonc
{ "type": "voice-peers", "streamId": 1, "self": { "peerId", "userId", "username" }, "peers": [ ... ] }
{ "type": "voice-peer-joined", "streamId": 1, "peer": { ... } }
{ "type": "voice-peer-left",   "streamId": 1, "peer": { ... }, "reason": "leave" | "close" }
{ "type": "voice-offer" | "voice-answer" | "voice-candidate", "streamId": 1, "from": { "peerId", "userId", "username" }, ... }
{ "type": "voice-error", "code": "not-joined", "message": "请先加入语音" }
```

mesh 建立规则（避免 glare）：`voice-peers` / `voice-peer-joined` 后比较双方 `peerId` 字符串，**较小的一方发 offer**；收到 offer 回 answer；双方 trickle ICE candidate；收到 `voice-peer-left` 关闭对应 PC。未加入语音时发送 offer/answer/candidate 会被服务端 `voice-error` 拒绝。

### 生命周期 / 性能保证

- 大厅、未加入语音的房间页：**不加载语音模块的媒体能力**（无 getUserMedia、无语音 PeerConnection、无 Remote audio、无 AudioContext）。
- 每个远端参与者最多一个 PeerConnection；重复操作不会重复创建。
- 离开语音 / 切换房间 / 直播间结束 / 退出登录 / 页面卸载都会：发 `voice-leave`、关闭全部 PC、停止远端 track、移除全部 `<audio>`、`AudioContext` 等监听与电平采样，且全部幂等。
- 本地/远端电平采样共用单个 `AudioContext`（`src/audioLevel.ts`），避免多 peer 时触顶浏览器上下文上限。

## 三、房间页与主播入口

- PC 宽屏：播放器左栏 + 右栏「语音房 + 弹幕」；移动端单栏堆叠，390px 视口无横向溢出。
- 房间信息栏显示封面/标题/主播/观看人数/延迟/状态；主播（登录用户名与直播间 `username` 一致）会看到「主播」徽章、「开播工作台」按钮与提示文案，点击进入 `/studio`。
- 弹幕、WHEP、延迟监控、人数等既有功能保持不变。

## 四、中英双语

`src/i18n.ts` 的完整 `zh` / `en` 字典新增：

- `studio.*`：工作台全部界面、步骤、状态、错误、摘要；
- `voice.*`：语音房加入/离开/静音/参与者/说话状态/信令与设备错误；
- `nav.studio`、`room.hostBadge`、`room.studioEntry` 等。

顶栏「中文 / English」即时切换（`localStorage["conglive.lang"]` 持久化），动态状态以 `TextMessage` 描述符在渲染时翻译，因此切换语言后已显示的状态/错误也会跟着切换。

## 五、模块清单

| 文件 | 职责 |
|---|---|
| `src/main.tsx` | App 外壳：路由、登录、大厅、房间 WHEP/弹幕状态、两个发布会话（首页卡片 / 工作台）|
| `src/studio.tsx` | `/studio` 工作台页面（四步、预览、电平条、封面、Live2D、开播/停止）|
| `src/whipPublisher.ts` | 共享 WHIP 发布引擎（创建直播间、封面、采集、Live2D 合成、SDP 协商、释放）|
| `src/media.ts` | 采集预设、错误文案映射、H.264 偏好、ICE gathering、SDP 校验 |
| `src/voice.ts` | 语音房信令客户端 + mesh（可配置 `iceServers`、PeerConnection/audio/电平/清理）+ `useVoiceRoom` hook |
| `src/audioLevel.ts` | 共享 AudioContext 的电平表与 `useLevelMeter` |
| `src/room.tsx` | 独立直播间页面 + 语音房面板（加入前取 TURN/回退 STUN + 中继状态）+ 主播工作台入口 |
| `src/api.ts` | REST 客户端（直播/容量/详情/TURN 凭据 `fetchTurnCredentials` + STUN 回退常量） |
| `src/live2d.ts` / `cover.ts` / `overlay.ts` | 复用：Live2D 加载、封面压缩/上传、Live2D 画面合成 |
| `e2e/` | Playwright 端到端测试（3 个套件，见下）|

## 六、本地开发

Node.js 20+：

```bash
npm install
npm run dev        # 0.0.0.0:5173
npm run typecheck  # tsc --noEmit
npm run build      # vite build → dist/
```

同源 API 使用相对路径；可用 `VITE_API_URL` 指向别的后端（构建时注入，例如远程回归测试）。

## 七、端到端测试（Playwright）

三个套件都放在 `web/e2e/`，使用本机 Playwright 与 Chromium 假摄像头/麦克风，测试 DOM 与真实 WebRTC 行为（通过注入脚本统计 PeerConnection / getUserMedia / 轨道释放，验证生命周期规则）。

前置：

```bash
npm run build
npx vite preview --port 4173 --host 127.0.0.1 &   # 套件 1
```

1. **工作台 + 语音房（离线、确定性；mock REST + mock WS relay，两个页面之间真实 mesh）**

   ```bash
   npm run e2e            # node e2e/studio-voice.mjs → 49 项
   ```

   覆盖：`/studio` 路由与 4 步布局、设备检测与预览、麦克风电平条随采样变化、封面压缩、分辨率/帧率、WHIP 创建+协商请求、409 错误与释放；大厅不建 PC/不采集；房间语音加入前无媒体、join/peers、双页面 mesh 连通、远端 audio、说话指示、静音、离开清理、路由切换清理、4403/voice-error 提示、中英切换、390px 无横向溢出；**TURN 成功路径（凭据请求 / PC iceServers 断言 / 中继状态）与 503 回退路径（两个公共 STUN、中继不可用提示、回退会话仍能 mesh 与清理）**。

2. **浏览器 ↔ 真实后端信令（导入 `backend/src/voice.js`，仅测试使用，不改后端）**

   ```bash
   npm run e2e:backend-voice   # node e2e/backend-voice.mjs → 15 项
   ```

   自建静态服务器 + `/ws/chat` 适配层，直接调用真实后端的 `createVoiceSignaling` / `handleVoiceMessage`，并用真实 `turn-utils`（`computeTurnCredential`/`buildTurnUrls`）生成凭据：验证成员关系、peer 列表广播、offer/answer/candidate 转发、`target-not-found` 拒绝、peer-left、4403 提示、浏览器端清理，以及 **TURN 凭据被浏览器正确使用（HMAC 校验）与 503 回退 STUN**。

3. **真实 WHIP/WHEP 回归（需要可访问的部署）**

   ```bash
   VITE_API_URL=http://<服务器>:3000 npx vite build --outDir dist-remote
   npx vite preview --outDir dist-remote --port 4174 --host 127.0.0.1 &
   REAL_API=http://<服务器>:3000 REAL_WEB=http://127.0.0.1:4174 npm run e2e:real
   ```

   覆盖：真实注册登录 → 工作台 WHIP 开播 → 后端出现直播房间 → 第二个浏览器 WHEP 播放（audio+video、延迟统计、观看人数、弹幕）→ 停止后下播；随后用首页开播卡片再走一遍 WHIP/WHEP，确保共享引擎重构没有破坏原有首页开播。

Playwright 解析顺序：`PLAYWRIGHT_PATH` 环境变量 → `playwright` 模块 → `/root/workspace/browser/node_modules/playwright`；Chromium 默认使用 `/root/workspace/browser/chrome/chrome-linux-arm64/chrome`（可用 `E2E_CHROME` 覆盖）。测试账号/截图/结果写入 `web/e2e/artifacts/`。

## 八、已知限制

- 浏览器开播需要安全上下文（`https://` 或 localhost）；`http://IP:8081` 下开播按钮禁用，观看/WHEP/弹幕不受影响。
- Live2D 模型与 Cubism Core 都从网络加载（不内置），模型服务器需允许 CORS；合成画面需要浏览器支持 `canvas.captureStream`。
- 语音房需要后端 task-7 的 `voice-*` 信令已部署；未部署时加入语音会收到明确错误提示。真实语音媒体是浏览器 P2P mesh，人数很多时上传带宽随 peer 数增长（适合中小型语音房）。
- TURN 中继需要部署 coturn 并配置 `TURN_SECRET`（task-10）；未配置时接口返回 503，网页自动回退 STUN 直连，严格 NAT/防火墙环境下可能无法建立音频（界面会明确显示“中继不可用 · 直连 / STUN”）。
- 真机 iOS/Safari 的自动播放策略更严格，已提供「点击恢复声音」兜底。

## 九、部署

```bash
cd ../server
docker compose up -d --build web
```

- IP 测试入口 `http://服务器IP:8081/`；域名 HTTPS 入口 `https://域名/`。
- `/studio`、`/room/<id>` 由 nginx 的 `try_files $uri $uri/ /index.html` 支持，无需新增 location。
- 管理后台源文件位于 `../webui/admin.html`，访问 `/admin`。
