# 葱直播 CongLive — Windows 便携客户端（Electron）

`pc/` 是新增的 Windows 10/11 x64 便携客户端：使用 Electron 作为外壳加载现有
CongLive Web 用户端，提供服务器地址配置（域名 / IP）、摄像头/麦克风/屏幕共享
权限、桌面端适配与 Windows 常用快捷键。

> 本目录为**新增**代码，未修改 `web/`、`backend/`、`android/`、`server/` 等既有产品源码。

## 功能

- **启动配置（launcher）**：首次启动填写服务器地址；支持域名、IP、完整 http(s) URL。
  - 缺省协议自动补全：普通域名补 `https://`，`localhost` / 私有网段 IP（10.x、172.16-31.x、192.168.x、127.x）补 `http://`。
  - 去掉尾部 `/`、丢弃 query/hash、保留路径前缀；拒绝非 http(s) 协议与带账号密码的地址。
  - 默认服务器 `https://xinglan.work`；配置保存在 Electron `userData`（Windows 为 `%APPDATA%\CongLive\config.json`），下次启动直接进入直播。
  - 进入后可通过「文件 → 服务器设置…」（`Ctrl+Shift+S`）随时修改。
- **窗口**：1440×900，最小 1100×720，标题「葱直播 CongLive」，任务栏/可执行文件使用新图标；记住窗口位置/大小。
- **媒体权限**：
  - 摄像头 / 麦克风：对配置服务器来源全允许，设备选择交给网页与系统默认设备。
  - 屏幕共享：`session.setDisplayMediaRequestHandler` + `desktopCapturer`；多屏幕/多窗口时弹出客户端自绘选择器（缩略图、按屏幕/窗口筛选、可选 Windows 系统声音 loopback；单个来源时自动选择）。
  - 权限按来源限制：只有配置服务器的页面能申请，其他来源一律拒绝。
- **PC 适配注入**（不改网页代码）：
  - 向页面注入 `html/body` 的 `pc-client`、`desktop` class，`data-conglive-client="pc"` 标记，并派发 `conglive:pc-ready` 事件；同时注入一小段 CSS 隐藏 `.mobile-only`、`[data-mobile-only]` 等移动端专用提示（当前 Web 构建中没有这些标记，因此是无害 no-op）。
  - preload 暴露只读的 `window.conglivePC`（`isPcClient`、`getInfo()`、`openServerSettings()`），网页可据此做 PC 端增强。
- **快捷键 / 菜单**：
  | 操作 | 快捷键 |
  | --- | --- |
  | 刷新 | `F5` / `Ctrl+R` |
  | 强制刷新 | `Ctrl+Shift+R` |
  | 返回 / 前进 | `Alt+←` / `Alt+→`，鼠标侧键 |
  | 全屏 / 退出全屏 | `F11` / `Esc` |
  | 开发者工具 | `F12` / `Ctrl+Shift+I` |
  | 服务器设置 | `Ctrl+Shift+S` |
  | 缩放 | `Ctrl+=` / `Ctrl+-` / `Ctrl+0` |
  | 退出 | `Alt+F4` |
- **安全**：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`、`webviewTag: false`；只允许在配置服务器 origin 内导航，外链交给系统浏览器；launcher / picker 的 IPC 只接受本地 `file://` 页面调用；窗口打开请求一律拒绝。
- **健壮性**：单实例锁（重复启动聚焦已有窗口）、加载失败对话框（重试 / 修改服务器 / 退出）、渲染进程崩溃与无响应恢复、记住窗口状态。

## 目录结构

```
pc/
├── package.json              # app 元数据 + electron / @electron/packager 等 devDependencies
├── src/
│   ├── main.js               # Electron 主进程：窗口、权限、屏幕共享选择器、菜单、IPC、冒烟钩子
│   ├── config.js             # 服务器地址归一化 / config.json 读写（可单测的纯逻辑）
│   ├── preload.js            # contextBridge：window.conglivePC + PC class 注入
│   ├── launcher.html/.js/.css# 服务器地址配置页（中英双语，跟随系统语言并可手动切换）
│   ├── picker.html/.js/.css  # 屏幕共享来源选择器（中英双语）
│   └── assets/icon.png/.ico  # 运行时窗口图标（由脚本生成）
├── scripts/
│   ├── make-icon.mjs         # 无依赖生成多尺寸 PNG/ICO（圆角渐变 + C + 播放符号）
│   ├── pack-win.mjs          # @electron/packager 交叉打包 win32 x64 + 便携 zip + BUILD-INFO
│   ├── verify-build.mjs      # PE/图标/版本资源/app.asar/zip/ICO 结构校验
│   ├── zip-dir.mjs           # 零依赖 ZIP 写入器（deflate + CRC32）
│   └── smoke-test.mjs        # 本机 Electron 冒烟测试（Xvfb 下加载 launcher/服务器并截图）
├── test/config.test.mjs      # node:test 单元测试（归一化、配置读写、容错）
├── build/                    # 生成的 icon.ico、冒烟截图、临时 userData（构建产物）
└── dist/                     # 打包产物：CongLive-win32-x64/、便携 zip、BUILD-INFO.json
```

## 开发与构建

环境：Node.js 20+（本机验证使用 Node 24.22 / npm 11），Windows 10/11 x64 为目标平台。

```bash
cd pc
npm install          # 国内网络可加 ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm start            # 本机开发运行（Windows 上调试最方便）
npm test             # 服务器地址归一化 / 配置读写单元测试
```

### 交叉打包 Windows 便携版（Linux/macOS 上即可完成）

```bash
cd pc
npm run build:win    # = 生成图标 → @electron/packager win32/x64 → 便携 zip → 结构校验
```

产物：

- `pc/dist/CongLive-win32-x64/`：解压即用的便携目录，包含 `CongLive.exe`。
- `pc/dist/CongLive-win32-x64-portable.zip`：便携压缩包（解压后双击 `CongLive.exe`）。
- `pc/dist/BUILD-INFO.json`：版本、Electron 版本、exe/zip/app.asar 的 SHA256 与体积。

`@electron/packager` 在非 Windows 主机上使用纯 JS 的 `resedit` 写入 Windows 图标与版本资源，**不需要 Wine**；Electron 二进制通过 `ELECTRON_MIRROR`（默认 npmmirror）下载。

### 本次构建产物（Linux x64 交叉打包，2026-11-04）

| 项 | 值 |
| --- | --- |
| 目标 | `win32` / `x64`，Electron `45.2.2`，客户端版本 `0.8.0` |
| 便携目录 | `pc/dist/CongLive-win32-x64/`（356.5 MB，73 个文件），含 `CongLive.exe` |
| 便携 zip | `pc/dist/CongLive-win32-x64-portable.zip`（153.6 MB，75 个条目） |
| `CongLive.exe` | 237.9 MB，SHA256 `64fc5899f99369298c7761c1698c4e711ba24bc44aed26cd3764d507c7551765` |
| `resources/app.asar` | 147 KB，SHA256 `d2a21fb672c8149cbe991d618e21f99e5fd43e67d0958afcbc738e22bc505fdf` |
| 图标 | `build/icon.ico`，SHA256 `c5d24ae06163795f44445def1cf9088b63307644fd7f11674f3293dfe26b32c7` |
| zip | SHA256 `ae0802522118dbd40e6680f6d94dd32bbcf29c9782de0fd7f6edbf32e7e0d2fe` |

完整元数据见 `pc/dist/BUILD-INFO.json`。

单独步骤：

```bash
npm run icon         # 重新生成 build/icon.ico 与 src/assets/icon.*
npm run pack:win     # 只打包 + zip
npm run verify       # 只做产物结构校验
npm run smoke:launcher   # Linux 开发机：Xvfb 下启动 launcher，校验渲染/中英切换/地址归一化预览并截图
npm run smoke:server     # Linux 开发机：Xvfb 下加载默认服务器页面，校验 PC class/桥接/移动端提示隐藏并截图
npm run smoke:flow       # launcher 填地址 → 保存 config.json → 主窗口加载该服务器（端到端）并截图
npm run smoke:picker     # 用合成来源打开屏幕共享选择器，校验列表/选择/关闭并截图
```

## 使用

1. 解压便携 zip，双击 `CongLive.exe`。
2. 首次启动输入服务器地址（默认 `https://xinglan.work`），点「进入直播」；之后启动直接进入。
3. 服务器地址保存在 `%APPDATA%\CongLive\config.json`；如需真正“绿色便携”（配置跟随 exe 目录），可在启动前设置环境变量
   `CONGLIVE_PC_USER_DATA=<配置目录>`，或使用 `--server=https://example.com` 临时指定服务器。
4. 网页内登录、观看、弹幕、开播、封面、Live2D 等行为与浏览器一致；摄像头/麦克风/屏幕共享按网页提示授权。
5. 环境变量 / 参数：
   - `CONGLIVE_PC_USER_DATA`：覆盖 userData 目录（便携部署）。
   - `--server=<url>`：跳过 launcher 直接打开指定服务器（不写入配置，便于多环境测试）。
   - `ELECTRON_MIRROR`：构建时 Electron 下载镜像。

### 网页推流与 HTTPS 说明

Web 端开播（WHIP）依赖浏览器安全上下文（`window.isSecureContext`）。客户端加载：

- `https://域名` / `http://localhost` / `http://127.0.0.1`：可以正常摄像头/屏幕开播；
- `http://内网IP:端口`：只能观看/弹幕，网页会禁用开播按钮（这是 Web 端既有逻辑，PC 客户端未修改）。

因此局域网内网测试建议使用 `localhost` 反向代理或带 HTTPS 的域名。

## 验证与限制

本机为 Linux/ARM64（Ubuntu 24.04 proot 环境），已完成的自动化验证：

1. `npm test`：13/13 单元测试通过（地址归一化、协议/凭据/长度校验、配置读写与损坏容错）。
2. `npm run build:win`：交叉打包 win32 x64 成功；`npm run verify` 校验：
   - `CongLive.exe` 为 PE32+ x86-64（machine `0x8664`）；
   - exe 内含 RT_ICON / RT_GROUP_ICON（多尺寸）与中文 `ProductName`/`FileDescription` 版本资源；
   - `resources/app.asar` 含 `src/main.js`、`src/launcher.html`、`src/preload.js`、`src/picker.html` 等，且不含 `dist/`、`test/`、`scripts/`；
   - 便携 zip 结构合法，包含 `CongLive-win32-x64/CongLive.exe`、`resources/app.asar`；
   - `build/icon.ico` 为含 16–256px 多尺寸 PNG 条目的合法 ICO。
3. Electron 冒烟测试（Xvfb + Linux 版 Electron 45.2.2，`pc/scripts/smoke-test.mjs` 四个模式）：
   - `smoke:launcher`：launcher 渲染、preload 桥可用、中英切换（`Server address` ⇄ `服务器地址`）、
     地址归一化预览（`xinglan.work` → `https://xinglan.work`）；截图 `pc/build/smoke-launcher.png`；
   - `smoke:server`：加载 `https://xinglan.work`，`pc-client`/`desktop` class 注入、`window.conglivePC` 桥可用、
     注入 CSS 能隐藏 `.mobile-only` 元素；截图 `pc/build/smoke-server.png`；
   - `smoke:flow`：launcher 填默认服务器并提交 → `config.json` 持久化 `https://xinglan.work` →
     主窗口创建并加载该地址 → class/桥接/移动端提示隐藏全部通过；截图 `pc/build/smoke-flow.png`；
   - `smoke:picker`：用合成屏幕/窗口来源打开选择器，列表渲染 2 个来源、选择后窗口关闭并回传结果；
     截图 `pc/build/smoke-picker.png`。
   - 已确认 `app.getName()`（package.json `productName`）为 `CongLive`，即 Windows 配置路径为
     `%APPDATA%\CongLive\config.json`。

**无法在本机验证（需 Windows 10/11 实机验收）**：

- `CongLive.exe` 在 Windows 上启动、任务栏/标题栏图标与中文版本信息显示；
- 摄像头/麦克风授权弹窗与设备选择（Windows 隐私设置）；
- 屏幕共享选择器缩略图、系统声音 loopback（仅 Windows）；
- Windows 原生快捷键/鼠标侧键、SmartScreen 未签名提示；
- 路径含中文/空格的解压目录运行情况。

建议 Windows 验收清单：

1. 解压 zip 到新目录，双击 `CongLive.exe`（确认无缺失 DLL），首次出现 launcher；
2. 输入 `https://xinglan.work` 进入；再通过 `Ctrl+Shift+S` 改为其他域名并重启确认记忆；
3. 登录 → 大厅 → 打开直播间确认 WHEP 播放；
4. 浏览器开播：摄像头 + 麦克风授权、720p 推流；屏幕共享弹出选择器并成功共享；勾选系统声音测试；
5. 快捷键、全屏、开发者工具、返回/前进、单实例（再次双击聚焦）逐项确认。

## 常见问题

- **无法加载服务器**：确认地址/端口可达、HTTPS 证书有效；在错误对话框点「修改服务器地址」可重新配置。
- **Windows 提示未知发布者 / SmartScreen**：便携 exe 未做代码签名，属预期；企业分发可自行签名（`@electron/windows-sign` 或 signtool）。
- **屏幕共享被拒绝**：网页端开播时点了取消，或选择器被关闭；重新点开播即可。若只有一个屏幕/窗口，客户端会自动选择。
- **系统声音没有声音**：系统声音仅 Windows 支持，且需在选择器里勾选；部分声卡/独占模式可能不可用。
- **内网 http 无法开播**：见上文「网页推流与 HTTPS 说明」。

## 说明

- 图标由 `scripts/make-icon.mjs` 程序化生成（品牌渐变圆角方块 + 白色 C + 播放三角），无第三方素材/字体依赖。
- launcher 与 picker 跟随系统语言（`app.getLocale()` / `navigator.language`）自动显示中文或英文，并可在界面中手动切换（记忆在 `localStorage."conglive.pc.lang"`）。
- 客户端版本 `0.8.0`，Electron 45.2.2。
