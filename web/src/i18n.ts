/**
 * CongLive Web i18n: complete zh/en dictionary, a tiny `t()` helper and the
 * `useLang()` hook used by the top-bar language switch.
 *
 * Language resolution: localStorage `conglive.lang` → `navigator.language`
 * (Chinese locales default to zh, every other locale to en).
 *
 * User-visible text that lives outside React (live2d / cover / overlay) and
 * status text stored in React state is carried as a `TextMessage` descriptor
 * (`{ key, params }`). Translation happens at render time, so switching the
 * language re-renders even messages that were produced before the switch.
 */
import { useSyncExternalStore } from 'react';

export type Lang = 'zh' | 'en';

export const LANG_STORAGE_KEY = 'conglive.lang';

const zh = {
  /* ---------- app / brand ---------- */
  'app.title': '葱直播 CongLive — 浏览器实时直播',
  'brand.home': '葱直播首页',
  'brand.mark': '葱',
  'brand.name': '葱直播',
  'brand.sub': 'CONGLIVE',
  'lang.switch': '切换语言',
  'lang.zh': '中文',
  'lang.en': 'English',
  'nav.label': '页面导航',
  'nav.lobby': '直播大厅',
  'nav.watch': '观看',
  'nav.publish': '开播',
  'nav.live2d': 'Live2D',
  'nav.chat': '弹幕',
  'topbar.signedIn': '已登录',
  'topbar.signedOut': '未登录',
  'topbar.logout': '退出登录',
  'topbar.loginRegister': '登录 / 注册',

  /* ---------- hero ---------- */
  'hero.eyebrow': 'WEBRTC · ULTRA LOW LATENCY',
  'hero.title': '分享你的实时世界',
  'hero.titleAccent': '低延迟 · 高互动',
  'hero.lead': '浏览器里的实时直播：WHEP 低延迟观看、WHIP 一键开播、实时弹幕，还能让 Live2D 看板娘陪你一起出镜。',
  'hero.badge.whep': 'WHEP 观看',
  'hero.badge.whip': 'WHIP 开播',
  'hero.badge.live2d': 'Live2D 叠加',
  'hero.badge.chat': '实时弹幕',

  /* ---------- auth ---------- */
  'auth.eyebrowSignedIn': 'SIGNED IN',
  'auth.eyebrowLogin': '登录后开始',
  'auth.signedInAs': '已登录用户',
  'auth.signedInHint': '令牌已保存在本机，可以观看直播、发送弹幕，并直接在浏览器开播。',
  'auth.createRoom': '创建直播间',
  'auth.lastCreated': '最近创建：#{id} · {title}',
  'auth.welcomeBack': '欢迎回来',
  'auth.username': '用户名',
  'auth.usernamePlaceholder': '用户名',
  'auth.password': '密码',
  'auth.passwordPlaceholder': '密码（至少 8 位）',
  'auth.login': '登录',
  'auth.register': '注册',
  'auth.loginHint': '观看直播需要登录；注册后即可进入大厅观看并发送弹幕。',
  'auth.loginSuccess': '登录成功',
  'auth.registerSuccess': '注册成功，请登录',

  /* ---------- generic / messages ---------- */
  'common.unknownError': '未知错误',
  'common.userName': '用户',
  'msg.checkBackend': '请检查后端地址',
  'msg.needLogin': '请先登录',
  'msg.userStreamTitle': '{name}的直播',
  'msg.streamListFailed': '无法读取直播列表：{detail}',
  'msg.streamCreated': '直播间创建成功{idPart}。现在可直接在「浏览器开播」卡片开始推流，或在 Android 客户端开播。',
  'msg.idPart': '（#{id}）',
  'msg.createdTransport': '传输协议：{transport}',
  'msg.coverUploaded': '封面已上传到直播间 #{id}\n封面地址：{url}',
  'msg.signedOut': '已退出登录',
  'msg.logoutStopped': '已退出登录，浏览器推流已停止',
  'msg.publishStopped': '已停止推流：本地预览已关闭，PeerConnection、音视频轨道与摄像头/屏幕采集均已释放',
  'msg.publishStarted': '浏览器开播已启动：直播间 #{id}（{title}）',
  'msg.publishUrl': '推流地址：{url}',
  'msg.publishPicture': '画面：{resolution} · {fps}fps · {source}{overlay}',
  'msg.publishFailureHint': '如果直播间已创建但推流失败，可重试；成功后大厅会显示该直播间。',
  'msg.watchNeedLogin': '观看直播需要登录：请先在上方登录，再进入房间观看 WHEP 直播并发送弹幕',
  'msg.sourceScreenShare': '屏幕共享',
  'msg.sourceCameraMic': '摄像头 + 麦克风',
  'msg.overlayLabel': ' · Live2D 叠加',
  'msg.coverUploadedNote': '封面已上传：{url}',
  'msg.coverUploadFailedNote': '封面上传失败：{detail}',
  'msg.overlayMissingNote': '未加载 Live2D 模型：本次开播保持原始画面。',
  'msg.overlayUnavailableNote': 'Live2D 叠加不可用（{detail}）：本次开播保持原始画面。',

  /* ---------- WHEP / playback status ---------- */
  'rtc.idlePicking': '在右侧大厅选择一间正在直播的房间开始观看',
  'rtc.idleSignedOut': '未登录：观看直播需要先登录，登录后通过 WHEP 实时播放',
  'rtc.connectingWhep': '正在建立 WHEP 连接…',
  'rtc.resumed': '直播画面已恢复',
  'rtc.stalled': '直播画面已停止更新超过 10 秒：主播可能已停止推流，可重新加入房间',
  'rtc.connectionLost': '{layer} 连接中断：直播可能已结束；若主播仍在推流，请检查服务器 UDP 8000 / TCP 8000 与 CANDIDATE 配置',
  'rtc.connectionFailed': '{layer} 连接失败：请确认服务器 UDP 8000 / TCP 8000 已放行，且 CANDIDATE 配置为公网 IP',
  'rtc.playing': 'WebRTC 播放中：已通过 WHEP 接收音视频',
  'rtc.autoplayMuted': '浏览器阻止了带声音的自动播放，已静音播放；可在播放器上取消静音',
  'rtc.clickPlay': '媒体已到达，请点击视频上的播放按钮开始播放',
  'rtc.remoteEnded': '远端媒体流已结束：主播可能已停止推流，可重新加入房间或点击重新连接',
  'rtc.tracksReceived': '已收到音视频轨道，正在播放…',
  'rtc.connected': 'WebRTC 已连接',
  'rtc.disconnected': 'WebRTC 连接中断，正在尝试恢复…',
  'rtc.state': 'WebRTC：{state}',
  'rtc.iceChecking': '正在建立 ICE 连接…',
  'rtc.iceConnected': 'ICE 已联通，正在接收媒体…',
  'rtc.iceDisconnected': 'ICE 连接中断，正在尝试恢复…',
  'rtc.iceTimeout': 'ICE 候选收集超时（12 秒），已用已收集的候选继续协商…',
  'rtc.badAnswer': '媒体服务器返回的 SDP Answer 无效（可能被网关拦截或 SRS 异常）',
  'rtc.signalingDone': 'WHEP 信令完成，等待音视频轨道…',
  'rtc.noTracks': '信令已完成，但 15 秒内未收到音视频轨道：请确认主播端仍在推流，且 ICE 没有被网络阻断',
  'rtc.playFailed': 'WebRTC 播放失败：{detail}',
  'whep.fail': 'WHEP 请求失败（HTTP {status}）：{detail}',

  /* ---------- WHEP / WHIP status hints ---------- */
  'whep.hint.400': '请求中的 SDP 无效',
  'whep.hint.401': '登录状态已失效，请重新登录',
  'whep.hint.403': '没有观看该直播的权限',
  'whep.hint.404': '直播不存在或已下架',
  'whep.hint.409': '主播尚未开播',
  'whep.hint.429': '请求过于频繁，请稍后重试',
  'whep.hint.502': '媒体服务器（SRS）暂时不可用',
  'whep.hint.504': '媒体服务器（SRS）响应超时',
  'whep.hint.generic': '未知错误',
  'whip.fail': 'WHIP 推流失败（HTTP {status}）：{detail}',
  'whip.hint.400': '提交的 SDP 无效',
  'whip.hint.401': '登录状态已失效，请重新登录',
  'whip.hint.403': '没有开播权限：只能推流自己的直播间',
  'whip.hint.404': '直播间不存在或已被下架',
  'whip.hint.409': '该直播间当前不可推流',
  'whip.hint.429': '请求过于频繁，请稍后重试',
  'whip.hint.502': '媒体服务器（SRS）暂时不可用，请检查 SRS 与 1985 内部端口',
  'whip.hint.504': '媒体服务器（SRS）响应超时',
  'whip.hint.generic': '未知错误',

  /* ---------- media capture errors ---------- */
  'media.screenCancelled': '屏幕共享被取消或未授权：开播需要允许共享屏幕（也可改用「摄像头」视频源）',
  'media.screenUnsupported': '当前浏览器不支持屏幕共享（getDisplayMedia），请改用「摄像头」视频源或新版 Chrome/Edge',
  'media.screenFailed': '获取屏幕画面失败：{detail}',
  'media.permissionDenied': '摄像头或麦克风权限被拒绝：请点击地址栏的权限图标允许后重试',
  'media.deviceNotFound': '未找到可用的摄像头/麦克风，或设备不支持所选分辨率与帧率',
  'media.deviceBusy': '摄像头或麦克风被其他程序占用，请关闭占用设备后重试',
  'media.captureUnsupported': '当前浏览器不支持摄像头采集（getUserMedia）',
  'media.captureFailed': '获取摄像头/麦克风失败：{detail}',

  /* ---------- publish status ---------- */
  'publish.idle': '未开播：选择视频源、分辨率与帧率后点击「开始开播」',
  'publish.idleInsecure': '浏览器推流需要 HTTPS：当前页面不是安全上下文，开播按钮已禁用（观看、WHEP 与弹幕不受影响）',
  'publish.stopped': '已停止开播：本地预览与音视频采集已释放',
  'publish.overlayOff': '已关闭 Live2D 叠加：推流恢复原始画面，音频保持不变',
  'publish.overlayNoModel': '尚未加载 Live2D 模型：推流保持原始画面。请先在「Live2D 看板娘」面板加载模型，再开启叠加。',
  'publish.noVideoTrack': '合成画布没有生成视频轨',
  'publish.overlayOn': '已开启 Live2D 叠加：观众看到的画面已合成看板娘，音频保持不变',
  'publish.overlayEnableFailed': '开启 Live2D 叠加失败：{detail}',
  'publish.overlayNoModelWarn': '尚未加载 Live2D 模型：开播时会保持原始画面；加载模型后可再开启叠加',
  'publish.needLogin': '开播需要先登录：请在上方登录或注册账号后重试',
  'publish.insecure': '浏览器推流需要 HTTPS：当前页面不是安全上下文，无法访问摄像头/屏幕采集',
  'publish.noWebrtc': '当前浏览器不支持 WebRTC 媒体采集，请更换新版 Chrome / Edge / Safari',
  'publish.noDisplayMedia': '当前浏览器不支持屏幕共享（getDisplayMedia），请改用「摄像头」视频源',
  'publish.creating': '正在创建直播间…',
  'publish.createFailed': '创建直播间失败（HTTP {status}）',
  'publish.badCreateResponse': '创建直播间响应缺少 id 或 publishPath',
  'publish.uploadingCover': '直播间已创建，正在上传封面…',
  'publish.pickShareTarget': '请在弹出的窗口中选择要共享的屏幕…',
  'publish.requestingDevice': '正在请求摄像头与麦克风权限…',
  'publish.shareEnded': '屏幕共享已结束，推流已自动停止（SRS 会收到 on_unpublish）',
  'publish.cameraEnded': '摄像头视频轨已结束，推流已自动停止',
  'publish.shareEndedMessage': '屏幕共享已结束：浏览器开播已自动停止。',
  'publish.cameraEndedMessage': '摄像头视频轨已结束：浏览器开播已自动停止。',
  'publish.streamingConnected': '推流已连接：SRS 正在转发你的音视频',
  'publish.disconnected': '推流连接中断，正在尝试恢复…',
  'publish.connectionFailed': '推流连接失败：请检查服务器 UDP/TCP 8000 与 CANDIDATE 配置后重新开播',
  'publish.iceChecking': '正在建立 ICE 连接…',
  'publish.iceConnected': 'ICE 已联通，浏览器推流中',
  'publish.iceFailed': 'ICE 连接失败：请确认服务器 UDP 8000 / TCP 8000 已放行且 CANDIDATE 为公网 IP',
  'publish.gathering': '正在收集 ICE 候选（通常 1-12 秒）…',
  'publish.iceTimeout': 'ICE 候选收集超时（12 秒），已用已收集的候选继续协商…',
  'publish.liveStatus': '推流中：#{id} · {resolution} · {fps}fps · {source}{overlay}',
  'publish.failed': '浏览器开播失败：{detail}',

  /* ---------- publish panel UI ---------- */
  'publish.eyebrow': 'BROWSER PUBLISH · WHIP',
  'publish.title': '浏览器开播',
  'publish.hint': '本页直接用摄像头或屏幕推流给 SRS，观众仍通过 WHEP 观看；停止后 SRS 收到 on_unpublish，直播间自动下线。',
  'publish.stateLive': '推流中',
  'publish.stateIdle': '未开播',
  'publish.source': '视频源',
  'publish.sourceCamera': '摄像头 + 麦克风',
  'publish.sourceScreen': '屏幕共享',
  'publish.resolution': '分辨率',
  'publish.fps': '帧率',
  'publish.titleField': '直播标题（可选）',
  'publish.coverTitle': '直播封面（可选）',
  'publish.coverHint': '选图后自动压缩到 2MB 以内的 JPEG dataURL，开播时上传',
  'publish.coverPreviewAlt': '封面预览',
  'publish.coverBusy': '处理中…',
  'publish.coverChange': '更换图片',
  'publish.coverPick': '选择图片',
  'publish.coverRemove': '移除',
  'publish.coverUploadBeforeStart': '开播时会先创建直播间、上传封面，再开始推流；上传失败不会影响开播。',
  'publish.lastCreatedRoom': '已创建直播间 #{id}',
  'publish.uploadCoverToRoom': '上传封面到该直播间',
  'publish.overlaySwitch': '叠加 Live2D 看板娘',
  'publish.overlaySwitchHintOn': '开播时把摄像头/屏幕画面与模型画布合成，只替换视频轨，音频保留',
  'publish.overlaySwitchHintOff': '尚未加载模型：开播将保持原始画面，可先到 Live2D 面板加载模型',
  'publish.start': '开始开播',
  'publish.starting': '推流中…',
  'publish.stop': '停止推流',
  'publish.configureLive2d': '配置 Live2D',
  'publish.insecureHint': '浏览器推流需要 HTTPS：当前页面不是安全上下文（http://IP 访问），开播按钮已禁用；观看、WHEP 播放与弹幕不受影响，请改用 https:// 域名访问后开播。',
  'publish.flowHint': '开播流程：创建直播间 → 上传封面（可选）→ 采集音视频 → 合成 Live2D（可选）→ WHIP 协商（SDP offer/answer）→ SRS 推流。',
  'publish.previewLabel': '本地预览',
  'publish.previewHintLive': '本地预览：只在本机显示；开启 Live2D 叠加后显示合成后的画面',
  'publish.previewHintIdle': '本地预览：点击「开始开播」后显示画面',
  'publish.previewHintInsecure': '浏览器推流需要 HTTPS，无法获取本地预览',
  'publish.res720p': '720p（1280×720）',
  'publish.res540p': '540p（960×540）',
  'publish.res360p': '360p（640×360）',

  /* ---------- watch panel ---------- */
  'watch.eyebrow': 'WHEP PLAYER',
  'watch.title': 'WebRTC 直播观看',
  'watch.waitingRoom': '等待选择房间',
  'watch.videoLabel': '直播画面',
  'watch.emptyPick': '从直播大厅选择一间正在直播的房间',
  'watch.emptyLogin': '登录后即可观看 WHEP 实时直播',
  'watch.reconnect': '重新连接',
  'watch.hint': '加入直播间后通过 WHEP 与 SRS 建立 WebRTC 连接；不再使用 HLS 或 HTTP-FLV 播放直播。',

  /* ---------- lobby ---------- */
  'lobby.eyebrow': 'LIVE NOW',
  'lobby.title': '直播大厅',
  'lobby.refresh': '刷新列表',
  'lobby.hint': '仅展示正在直播且提供 WHEP 播放地址的房间。',
  'lobby.signedOutHint': '未登录：观看直播需要先登录。登录后即可进入房间观看并发送弹幕。',
  'lobby.emptyTitle': '当前没有正在直播的房间',
  'lobby.emptyHint': '主播在浏览器开播后，这里会自动出现直播卡片。',
  'lobby.watchRoom': '观看 {title}',
  'lobby.liveBadge': '直播中',
  'lobby.owner': '主播：{name}',
  'lobby.cta': '观看 / 弹幕 →',
  'lobby.ctaSignedOut': '登录后观看 →',

  /* ---------- Live2D ---------- */
  'live2d.eyebrow': 'LIVE2D WIDGET',
  'live2d.title': 'Live2D 看板娘',
  'live2d.panelHint': '输入 Cubism 3/4/5 模型（.model3.json）地址加载，模型与 Cubism Core 都从网络加载，不内置任何模型。',
  'live2d.urlLabel': 'Live2D 模型地址',
  'live2d.loadingButton': '加载中…',
  'live2d.loadButton': '加载看板娘',
  'live2d.hide': '隐藏',
  'live2d.show': '显示',
  'live2d.unload': '卸载',
  'live2d.canvasLabel': 'Live2D 看板娘画布',
  'live2d.placeholderTitle': '还没有加载看板娘',
  'live2d.placeholderHint': '支持 .model3.json；加载失败会在这里提示原因',
  'live2d.footerHint': '提示：模型服务器需要允许跨域（CORS）；开播时可在「浏览器开播」卡片勾选「叠加 Live2D 看板娘」把模型合成进直播画面。',
  'live2d.phase.core': '加载 Core',
  'live2d.phase.model': '加载模型',
  'live2d.phase.ready': '已就绪',
  'live2d.phase.error': '加载失败',
  'live2d.phase.idle': '未加载',
  'live2d.initial': '输入 .model3.json 地址后点击「加载看板娘」（模型从网络加载，不内置任何模型）',
  'live2d.loadingCore': '正在从 CDN 加载 Cubism Core…',
  'live2d.coreReady': 'Cubism Core 就绪，正在加载 {model}…',
  'live2d.modelFallback': '模型',
  'live2d.loaded': '模型已加载：{model}（{width}×{height}）',
  'live2d.unloaded': '已卸载看板娘，可重新输入模型地址加载',
  'live2d.timeout': '加载超时',
  'live2d.scriptFailed': '脚本加载失败',
  'live2d.coreFailed': 'Cubism Core 加载失败：无法从 CDN 获取 live2dcubismcore.js。请检查网络 / 广告拦截插件，或换一个能访问 cubism.live2d.com 的网络后重试。',
  'live2d.urlRequired': '请输入 Live2D 模型地址（以 .model3.json 结尾）',
  'live2d.urlInvalid': '模型地址格式不正确，请填写完整的 http(s) URL',
  'live2d.urlProtocol': '模型地址必须是 http(s) 链接或以 / 开头的站内路径',
  'live2d.urlSuffix': '模型地址应以 .model3.json 结尾（例如 https://example.com/model/model3.json）',
  'live2d.webgl': '加载 Live2D 失败：当前浏览器无法创建 WebGL 上下文（可能是硬件加速被禁用），请开启浏览器硬件加速后重试。',
  'live2d.webglContext': '无法创建 WebGL 上下文',
  'live2d.network': '模型加载失败：无法读取 .model3.json 或其贴图/动作文件（{detail}）。请确认地址可访问、文件完整，并且允许跨域（CORS）；远程模型需服务器返回 Access-Control-Allow-Origin。',
  'live2d.loadFailed': '模型加载失败：{detail}。请检查模型地址、贴图/动作文件是否完整，以及 CDN 是否允许跨域。',

  /* ---------- chat ---------- */
  'chat.pickRoom': '选择一间正在直播的房间加入弹幕',
  'chat.connecting': '正在连接弹幕…',
  'chat.connected': '实时弹幕已连接',
  'chat.error': '弹幕异常',
  'chat.closed': '直播间已关闭或账号不可用',
  'chat.disconnected': '弹幕连接已断开',
  'chat.connectFailed': '弹幕连接失败',
  'chat.joining': '正在加入：{title}',
  'chat.notConnected': '弹幕尚未连接，请重新加入房间',
  'chat.eyebrow': 'LIVE CHAT',
  'chat.title': '实时弹幕评论',
  'chat.currentRoom': '当前房间：{title} · ',
  'chat.leave': '离开房间',
  'chat.empty': '还没有评论，加入直播间后即可参与互动。',
  'chat.inputPlaceholder': '输入弹幕评论，最多 500 字',
  'chat.inputPlaceholderSignedOut': '登录后加入直播间发送弹幕',
  'chat.send': '发送',

  /* ---------- cover module ---------- */
  'cover.pick': '请选择一张图片',
  'cover.needCreateRoom': '请先创建直播间',
  'cover.needCover': '请先选择封面图片',
  'cover.badType': '仅支持 JPG / PNG / WebP 图片',
  'cover.tooLarge': '原图超过 30MB，请先压缩或换一张更小的图片',
  'cover.decodeFailed': '无法解码这张图片，请换一张 JPG/PNG/WebP 图片',
  'cover.badSize': '图片尺寸无效，请换一张图片',
  'cover.canvasUnavailable': '浏览器无法创建画布，封面压缩失败',
  'cover.compressFailed': '图片无法压缩到 2MB 以内，请换一张尺寸更小或色彩更简单的图片',
  'cover.uploadFailed': '封面上传失败（HTTP {status}）：{detail}',
  'cover.missingUrl': '封面上传响应缺少 coverUrl',
  'cover.processFailed': '封面处理失败，请换一张图片',
  'cover.uploadFailedFallback': '封面上传失败',

  /* ---------- overlay module ---------- */
  'overlay.canvasUnavailable': '浏览器无法创建 2D 画布，Live2D 叠加不可用',
  'overlay.captureUnsupported': '浏览器不支持 canvas.captureStream，无法叠加 Live2D',

  /* ---------- footer ---------- */
  'footer.brand': '葱直播 CongLive',
  'footer.tech': 'WebRTC · WHIP · WHEP · Live2D',
  'footer.notice': '请勿直播未经授权的私人内容',
} as const;

export type I18nKey = keyof typeof zh;

const en: Record<I18nKey, string> = {
  /* ---------- app / brand ---------- */
  'app.title': 'CongLive — Live in your browser',
  'brand.home': 'CongLive home',
  'brand.mark': 'C',
  'brand.name': 'CongLive',
  'brand.sub': 'CONGLIVE',
  'lang.switch': 'Switch language',
  'lang.zh': '中文',
  'lang.en': 'English',
  'nav.label': 'Page navigation',
  'nav.lobby': 'Lobby',
  'nav.watch': 'Watch',
  'nav.publish': 'Go live',
  'nav.live2d': 'Live2D',
  'nav.chat': 'Chat',
  'topbar.signedIn': 'Signed in',
  'topbar.signedOut': 'Signed out',
  'topbar.logout': 'Sign out',
  'topbar.loginRegister': 'Sign in / Sign up',

  /* ---------- hero ---------- */
  'hero.eyebrow': 'WEBRTC · ULTRA LOW LATENCY',
  'hero.title': 'Share your world, live',
  'hero.titleAccent': 'Low latency · High engagement',
  'hero.lead': 'Live streaming right in your browser: low-latency WHEP playback, one-click WHIP publishing, real-time chat — and a Live2D mascot to keep you company on camera.',
  'hero.badge.whep': 'WHEP playback',
  'hero.badge.whip': 'WHIP publishing',
  'hero.badge.live2d': 'Live2D overlay',
  'hero.badge.chat': 'Live chat',

  /* ---------- auth ---------- */
  'auth.eyebrowSignedIn': 'SIGNED IN',
  'auth.eyebrowLogin': 'SIGN IN TO START',
  'auth.signedInAs': 'Signed-in user',
  'auth.signedInHint': 'Your token is stored on this device. You can watch streams, send chat messages, and go live right from this browser.',
  'auth.createRoom': 'Create a live room',
  'auth.lastCreated': 'Latest created: #{id} · {title}',
  'auth.welcomeBack': 'Welcome back',
  'auth.username': 'Username',
  'auth.usernamePlaceholder': 'Username',
  'auth.password': 'Password',
  'auth.passwordPlaceholder': 'Password (at least 8 characters)',
  'auth.login': 'Sign in',
  'auth.register': 'Sign up',
  'auth.loginHint': 'Sign in to watch streams. New accounts can join the lobby to watch and chat right away.',
  'auth.loginSuccess': 'Signed in successfully',
  'auth.registerSuccess': 'Account created. Please sign in.',

  /* ---------- generic / messages ---------- */
  'common.unknownError': 'Unknown error',
  'common.userName': 'user',
  'msg.checkBackend': 'please check the backend URL',
  'msg.needLogin': 'Please sign in first',
  'msg.userStreamTitle': "{name}'s live stream",
  'msg.streamListFailed': 'Could not load the stream list: {detail}',
  'msg.streamCreated': 'Live room created{idPart}. You can now start streaming from the Browser publish card, or go live in the Android app.',
  'msg.idPart': ' (#{id})',
  'msg.createdTransport': 'Transport: {transport}',
  'msg.coverUploaded': 'Cover uploaded to live room #{id}\nCover URL: {url}',
  'msg.signedOut': 'Signed out',
  'msg.logoutStopped': 'Signed out; browser publishing has stopped',
  'msg.publishStopped': 'Publishing stopped: the local preview, PeerConnection, media tracks, and camera/screen capture have all been released.',
  'msg.publishStarted': 'Browser publishing started: live room #{id} ({title})',
  'msg.publishUrl': 'Publish URL: {url}',
  'msg.publishPicture': 'Picture: {resolution} · {fps}fps · {source}{overlay}',
  'msg.publishFailureHint': 'If the room was created but publishing failed, you can retry; the lobby will show the room once publishing succeeds.',
  'msg.watchNeedLogin': 'Sign in to watch: sign in above, then join a room for WHEP playback and live chat.',
  'msg.sourceScreenShare': 'Screen share',
  'msg.sourceCameraMic': 'Camera + microphone',
  'msg.overlayLabel': ' · Live2D overlay',
  'msg.coverUploadedNote': 'Cover uploaded: {url}',
  'msg.coverUploadFailedNote': 'Cover upload failed: {detail}',
  'msg.overlayMissingNote': 'No Live2D model loaded: publishing keeps the raw picture.',
  'msg.overlayUnavailableNote': 'Live2D overlay unavailable ({detail}): publishing keeps the raw picture.',

  /* ---------- WHEP / playback status ---------- */
  'rtc.idlePicking': 'Pick a live room from the lobby to start watching',
  'rtc.idleSignedOut': 'Signed out: sign in to watch live via WHEP',
  'rtc.connectingWhep': 'Establishing WHEP connection…',
  'rtc.resumed': 'Live picture resumed',
  'rtc.stalled': 'The live picture has frozen for more than 10 seconds: the host may have stopped publishing. Try rejoining the room.',
  'rtc.connectionLost': '{layer} connection lost: the stream may have ended. If the host is still publishing, check server UDP 8000 / TCP 8000 and the CANDIDATE setting.',
  'rtc.connectionFailed': '{layer} connection failed: make sure server UDP 8000 / TCP 8000 are open and CANDIDATE is set to the public IP.',
  'rtc.playing': 'Playing over WebRTC: receiving audio and video via WHEP',
  'rtc.autoplayMuted': 'The browser blocked autoplay with sound, so playback is muted. Unmute it in the player controls.',
  'rtc.clickPlay': 'Media received. Click the play button on the video to start.',
  'rtc.remoteEnded': 'The remote media stream ended: the host may have stopped publishing. Rejoin the room or click reconnect.',
  'rtc.tracksReceived': 'Audio/video tracks received, starting playback…',
  'rtc.connected': 'WebRTC connected',
  'rtc.disconnected': 'WebRTC disconnected, trying to recover…',
  'rtc.state': 'WebRTC: {state}',
  'rtc.iceChecking': 'Establishing ICE connection…',
  'rtc.iceConnected': 'ICE connected, receiving media…',
  'rtc.iceDisconnected': 'ICE disconnected, trying to recover…',
  'rtc.iceTimeout': 'ICE candidate gathering timed out after 12s; continuing with the candidates collected so far…',
  'rtc.badAnswer': 'The media server returned an invalid SDP answer (possibly blocked by a gateway or an SRS fault).',
  'rtc.signalingDone': 'WHEP signaling complete, waiting for audio/video tracks…',
  'rtc.noTracks': 'Signaling completed but no audio/video tracks arrived within 15 seconds: make sure the host is still publishing and ICE is not blocked.',
  'rtc.playFailed': 'WebRTC playback failed: {detail}',
  'whep.fail': 'WHEP request failed (HTTP {status}): {detail}',

  /* ---------- WHEP / WHIP status hints ---------- */
  'whep.hint.400': 'The SDP in the request is invalid',
  'whep.hint.401': 'Your session has expired. Please sign in again.',
  'whep.hint.403': 'You do not have permission to watch this stream',
  'whep.hint.404': 'This live stream does not exist or has been taken down',
  'whep.hint.409': 'The host has not started streaming yet',
  'whep.hint.429': 'Too many requests. Please try again later.',
  'whep.hint.502': 'The media server (SRS) is temporarily unavailable',
  'whep.hint.504': 'The media server (SRS) timed out',
  'whep.hint.generic': 'Unknown error',
  'whip.fail': 'WHIP publish failed (HTTP {status}): {detail}',
  'whip.hint.400': 'The submitted SDP is invalid',
  'whip.hint.401': 'Your session has expired. Please sign in again.',
  'whip.hint.403': 'You are not allowed to publish: you can only stream to your own room',
  'whip.hint.404': 'The live room does not exist or has been taken down',
  'whip.hint.409': 'This live room cannot be published to right now',
  'whip.hint.429': 'Too many requests. Please try again later.',
  'whip.hint.502': 'The media server (SRS) is temporarily unavailable. Check SRS and internal port 1985.',
  'whip.hint.504': 'The media server (SRS) timed out',
  'whip.hint.generic': 'Unknown error',

  /* ---------- media capture errors ---------- */
  'media.screenCancelled': 'Screen sharing was cancelled or not permitted: allow screen sharing to publish (or switch the video source to Camera)',
  'media.screenUnsupported': 'This browser does not support screen sharing (getDisplayMedia). Switch to the Camera source or use a recent Chrome/Edge.',
  'media.screenFailed': 'Could not capture the screen: {detail}',
  'media.permissionDenied': 'Camera or microphone permission was denied. Allow it from the permission icon in the address bar and try again.',
  'media.deviceNotFound': 'No camera/microphone was found, or the device does not support the selected resolution and frame rate',
  'media.deviceBusy': 'The camera or microphone is in use by another app. Close it and try again.',
  'media.captureUnsupported': 'This browser does not support camera capture (getUserMedia)',
  'media.captureFailed': 'Could not access the camera/microphone: {detail}',

  /* ---------- publish status ---------- */
  'publish.idle': 'Not publishing: choose a source, resolution, and frame rate, then click "Start publishing"',
  'publish.idleInsecure': 'Browser publishing requires HTTPS: this page is not a secure context, so the publish button is disabled (watching, WHEP, and chat still work)',
  'publish.stopped': 'Publishing stopped: the local preview and media capture have been released',
  'publish.overlayOff': 'Live2D overlay turned off: publishing uses the raw picture again; audio is unchanged',
  'publish.overlayNoModel': 'No Live2D model loaded: publishing keeps the raw picture. Load a model in the Live2D mascot panel first, then turn the overlay on.',
  'publish.noVideoTrack': 'The compositing canvas produced no video track',
  'publish.overlayOn': 'Live2D overlay turned on: viewers now see the composited mascot; audio is unchanged',
  'publish.overlayEnableFailed': 'Could not turn on the Live2D overlay: {detail}',
  'publish.overlayNoModelWarn': 'No Live2D model loaded: publishing will keep the raw picture; you can turn the overlay on after loading a model',
  'publish.needLogin': 'Sign in before going live: sign in or create an account above and try again',
  'publish.insecure': 'Browser publishing requires HTTPS: this page is not a secure context, so camera/screen capture is unavailable',
  'publish.noWebrtc': 'This browser does not support WebRTC media capture. Use a recent Chrome / Edge / Safari.',
  'publish.noDisplayMedia': 'This browser does not support screen sharing (getDisplayMedia). Switch the video source to Camera.',
  'publish.creating': 'Creating live room…',
  'publish.createFailed': 'Could not create the live room (HTTP {status})',
  'publish.badCreateResponse': 'The create-room response is missing id or publishPath',
  'publish.uploadingCover': 'Live room created; uploading cover…',
  'publish.pickShareTarget': 'Choose the screen to share in the pop-up window…',
  'publish.requestingDevice': 'Requesting camera and microphone permission…',
  'publish.shareEnded': 'Screen sharing ended, so publishing stopped automatically (SRS receives on_unpublish)',
  'publish.cameraEnded': 'The camera video track ended, so publishing stopped automatically',
  'publish.shareEndedMessage': 'Screen sharing ended: browser publishing stopped automatically.',
  'publish.cameraEndedMessage': 'The camera video track ended: browser publishing stopped automatically.',
  'publish.streamingConnected': 'Publishing connected: SRS is relaying your audio and video',
  'publish.disconnected': 'Publishing connection lost, trying to recover…',
  'publish.connectionFailed': 'Publishing connection failed: check server UDP/TCP 8000 and the CANDIDATE setting, then publish again',
  'publish.iceChecking': 'Establishing ICE connection…',
  'publish.iceConnected': 'ICE connected, browser is publishing',
  'publish.iceFailed': 'ICE connection failed: make sure server UDP 8000 / TCP 8000 are open and CANDIDATE is the public IP',
  'publish.gathering': 'Gathering ICE candidates (usually 1–12 seconds)…',
  'publish.iceTimeout': 'ICE candidate gathering timed out after 12s; continuing with the candidates collected so far…',
  'publish.liveStatus': 'Publishing: #{id} · {resolution} · {fps}fps · {source}{overlay}',
  'publish.failed': 'Browser publishing failed: {detail}',

  /* ---------- publish panel UI ---------- */
  'publish.eyebrow': 'BROWSER PUBLISH · WHIP',
  'publish.title': 'Publish from browser',
  'publish.hint': 'This page publishes your camera or screen straight to SRS while viewers keep watching over WHEP. When you stop, SRS receives on_unpublish and the room goes offline automatically.',
  'publish.stateLive': 'LIVE',
  'publish.stateIdle': 'Offline',
  'publish.source': 'Video source',
  'publish.sourceCamera': 'Camera + microphone',
  'publish.sourceScreen': 'Screen share',
  'publish.resolution': 'Resolution',
  'publish.fps': 'Frame rate',
  'publish.titleField': 'Stream title (optional)',
  'publish.coverTitle': 'Stream cover (optional)',
  'publish.coverHint': 'The image is compressed to a JPEG data URL under 2MB and uploaded when you go live',
  'publish.coverPreviewAlt': 'Cover preview',
  'publish.coverBusy': 'Processing…',
  'publish.coverChange': 'Change image',
  'publish.coverPick': 'Choose image',
  'publish.coverRemove': 'Remove',
  'publish.coverUploadBeforeStart': 'When you go live, the room is created and the cover uploaded before publishing starts; a failed upload does not block publishing.',
  'publish.lastCreatedRoom': 'Live room #{id} created',
  'publish.uploadCoverToRoom': 'Upload cover to this room',
  'publish.overlaySwitch': 'Overlay the Live2D mascot',
  'publish.overlaySwitchHintOn': 'When publishing, the camera/screen picture is composited with the model canvas; only the video track is replaced and audio is kept',
  'publish.overlaySwitchHintOff': 'No model loaded: publishing keeps the raw picture; load a model in the Live2D panel first',
  'publish.start': 'Start publishing',
  'publish.starting': 'Publishing…',
  'publish.stop': 'Stop publishing',
  'publish.configureLive2d': 'Configure Live2D',
  'publish.insecureHint': 'Browser publishing requires HTTPS: this page is not a secure context (accessed via http://IP), so the publish button is disabled. Watching, WHEP playback, and chat still work; open the site over an https:// domain to publish.',
  'publish.flowHint': 'Publish flow: create live room → upload cover (optional) → capture audio/video → composite Live2D (optional) → WHIP negotiation (SDP offer/answer) → stream to SRS.',
  'publish.previewLabel': 'Local preview',
  'publish.previewHintLive': 'Local preview: shown on this device only; with the Live2D overlay on, it shows the composited picture',
  'publish.previewHintIdle': 'Local preview: the picture appears after you click "Start publishing"',
  'publish.previewHintInsecure': 'Browser publishing requires HTTPS, so no local preview is available',
  'publish.res720p': '720p (1280×720)',
  'publish.res540p': '540p (960×540)',
  'publish.res360p': '360p (640×360)',

  /* ---------- watch panel ---------- */
  'watch.eyebrow': 'WHEP PLAYER',
  'watch.title': 'Watch live over WebRTC',
  'watch.waitingRoom': 'Waiting for a room',
  'watch.videoLabel': 'Live video',
  'watch.emptyPick': 'Choose a live room from the lobby',
  'watch.emptyLogin': 'Sign in to watch live WHEP streams',
  'watch.reconnect': 'Reconnect',
  'watch.hint': 'Joining a room establishes a WebRTC connection to SRS over WHEP; HLS and HTTP-FLV are no longer used for live playback.',

  /* ---------- lobby ---------- */
  'lobby.eyebrow': 'LIVE NOW',
  'lobby.title': 'Live lobby',
  'lobby.refresh': 'Refresh',
  'lobby.hint': 'Only rooms that are live and provide a WHEP playback URL are listed.',
  'lobby.signedOutHint': 'Signed out: sign in to watch streams. Once signed in you can join rooms and chat.',
  'lobby.emptyTitle': 'No live rooms right now',
  'lobby.emptyHint': 'Live cards appear here automatically once a host starts publishing from the browser.',
  'lobby.watchRoom': 'Watch {title}',
  'lobby.liveBadge': 'LIVE',
  'lobby.owner': 'Host: {name}',
  'lobby.cta': 'Watch / chat →',
  'lobby.ctaSignedOut': 'Sign in to watch →',

  /* ---------- Live2D ---------- */
  'live2d.eyebrow': 'LIVE2D WIDGET',
  'live2d.title': 'Live2D mascot',
  'live2d.panelHint': 'Enter a Cubism 3/4/5 model (.model3.json) URL to load it. Both the model and Cubism Core are loaded from the network; no model is bundled.',
  'live2d.urlLabel': 'Live2D model URL',
  'live2d.loadingButton': 'Loading…',
  'live2d.loadButton': 'Load mascot',
  'live2d.hide': 'Hide',
  'live2d.show': 'Show',
  'live2d.unload': 'Unload',
  'live2d.canvasLabel': 'Live2D mascot canvas',
  'live2d.placeholderTitle': 'No mascot loaded yet',
  'live2d.placeholderHint': 'Supports .model3.json; load failures are explained here',
  'live2d.footerHint': 'Tip: the model server must allow cross-origin requests (CORS). When publishing, tick "Overlay the Live2D mascot" in the Browser publish card to composite the model into the stream.',
  'live2d.phase.core': 'Loading Core',
  'live2d.phase.model': 'Loading model',
  'live2d.phase.ready': 'Ready',
  'live2d.phase.error': 'Load failed',
  'live2d.phase.idle': 'Not loaded',
  'live2d.initial': 'Enter a .model3.json URL and click "Load mascot" (models load from the network; none are bundled)',
  'live2d.loadingCore': 'Loading Cubism Core from the CDN…',
  'live2d.coreReady': 'Cubism Core ready; loading {model}…',
  'live2d.modelFallback': 'model',
  'live2d.loaded': 'Model loaded: {model} ({width}×{height})',
  'live2d.unloaded': 'Mascot unloaded. You can enter a model URL to load another one.',
  'live2d.timeout': 'Loading timed out',
  'live2d.scriptFailed': 'Script failed to load',
  'live2d.coreFailed': 'Could not load Cubism Core: live2dcubismcore.js is unavailable from the CDN. Check your network / ad blocker, or try a network that can reach cubism.live2d.com.',
  'live2d.urlRequired': 'Enter a Live2D model URL (ending in .model3.json)',
  'live2d.urlInvalid': 'Invalid model URL. Enter a full http(s) URL.',
  'live2d.urlProtocol': 'The model URL must be an http(s) link or a site path starting with /',
  'live2d.urlSuffix': 'The model URL should end with .model3.json (for example https://example.com/model/model3.json)',
  'live2d.webgl': 'Failed to load Live2D: this browser cannot create a WebGL context (hardware acceleration may be disabled). Enable hardware acceleration and try again.',
  'live2d.webglContext': 'Could not create a WebGL context',
  'live2d.network': 'Failed to load the model: the .model3.json or its textures/motions could not be read ({detail}). Make sure the URL is reachable, the files are complete, and CORS is allowed; the remote server must return Access-Control-Allow-Origin.',
  'live2d.loadFailed': 'Failed to load the model: {detail}. Check the model URL, whether the textures/motions are complete, and whether the CDN allows cross-origin requests.',

  /* ---------- chat ---------- */
  'chat.pickRoom': 'Pick a live room to join the chat',
  'chat.connecting': 'Connecting to chat…',
  'chat.connected': 'Live chat connected',
  'chat.error': 'Chat error',
  'chat.closed': 'The live room is closed or the account is unavailable',
  'chat.disconnected': 'Chat connection lost',
  'chat.connectFailed': 'Chat connection failed',
  'chat.joining': 'Joining: {title}',
  'chat.notConnected': 'Chat is not connected yet. Rejoin the room.',
  'chat.eyebrow': 'LIVE CHAT',
  'chat.title': 'Live chat',
  'chat.currentRoom': 'Room: {title} · ',
  'chat.leave': 'Leave room',
  'chat.empty': 'No comments yet. Join a live room to take part.',
  'chat.inputPlaceholder': 'Type a chat message (max 500 characters)',
  'chat.inputPlaceholderSignedOut': 'Sign in and join a room to chat',
  'chat.send': 'Send',

  /* ---------- cover module ---------- */
  'cover.pick': 'Please choose an image',
  'cover.needCreateRoom': 'Create a live room first',
  'cover.needCover': 'Choose a cover image first',
  'cover.badType': 'Only JPG / PNG / WebP images are supported',
  'cover.tooLarge': 'The original image is over 30MB. Compress it or choose a smaller one.',
  'cover.decodeFailed': 'Could not decode this image. Try another JPG/PNG/WebP image.',
  'cover.badSize': 'The image dimensions are invalid. Choose another image.',
  'cover.canvasUnavailable': 'The browser cannot create a canvas, so cover compression failed',
  'cover.compressFailed': 'The image cannot be compressed below 2MB. Choose a smaller or simpler image.',
  'cover.uploadFailed': 'Cover upload failed (HTTP {status}): {detail}',
  'cover.missingUrl': 'The cover upload response is missing coverUrl',
  'cover.processFailed': 'Cover processing failed. Try another image.',
  'cover.uploadFailedFallback': 'Cover upload failed',

  /* ---------- overlay module ---------- */
  'overlay.canvasUnavailable': 'The browser cannot create a 2D canvas, so the Live2D overlay is unavailable',
  'overlay.captureUnsupported': 'This browser does not support canvas.captureStream, so the Live2D overlay cannot be used',

  /* ---------- footer ---------- */
  'footer.brand': 'CongLive',
  'footer.tech': 'WebRTC · WHIP · WHEP · Live2D',
  'footer.notice': 'Do not stream private content without permission',
};

const DICTS: Record<Lang, Record<I18nKey, string>> = { zh, en };

/* ------------------------------------------------------------------ *
 * Text descriptors (translate at render time, not at creation time)
 * ------------------------------------------------------------------ */

export const RAW_TEXT_KEY = '@@raw' as const;
export const BACKEND_TEXT_KEY = '@@backend' as const;

export type TextParam = string | number | TextMessage;
export type TextMessage = {
  key: I18nKey | typeof RAW_TEXT_KEY | typeof BACKEND_TEXT_KEY;
  params?: Record<string, TextParam>;
};

function format(template: string, params?: Record<string, TextParam>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    if (value === undefined) return match;
    return typeof value === 'object' ? translateMessage(value) : String(value);
  });
}

/** Translate one dictionary key, filling `{name}` placeholders from `params`. */
export function t(key: I18nKey, params?: Record<string, TextParam>): string {
  const template = DICTS[lang][key] ?? zh[key] ?? key;
  return format(template, params);
}

/** Build a translatable message descriptor. */
export function msg(key: I18nKey, params?: Record<string, TextParam>): TextMessage {
  return { key, params };
}

/** Wrap a literal value (user text, technical detail) that needs no translation. */
export function rawText(value: string): TextMessage {
  return { key: RAW_TEXT_KEY, params: { v: value } };
}

/** Wrap a backend-provided message: known Chinese errors are mapped in English. */
export function backendText(value: string, status?: number): TextMessage {
  return {
    key: BACKEND_TEXT_KEY,
    params: status === undefined ? { v: value } : { v: value, status },
  };
}

/** Translate a message descriptor with the currently selected language. */
export function translateMessage(message: TextMessage): string {
  if (message.key === RAW_TEXT_KEY) return String(message.params?.v ?? '');
  if (message.key === BACKEND_TEXT_KEY) {
    const raw = String(message.params?.v ?? '');
    const status = typeof message.params?.status === 'number' ? message.params.status : undefined;
    return localizeBackendDetail(raw, status);
  }
  return t(message.key, message.params);
}

/** Error that carries a translatable message instead of a fixed string. */
export class LocalizedError extends Error {
  readonly text: TextMessage;

  constructor(text: TextMessage) {
    super(typeof text.key === 'string' ? text.key : '');
    this.name = 'LocalizedError';
    this.text = text;
  }
}

/** Turn any thrown value into a translatable message. */
export function errorMessage(error: unknown, fallback: TextMessage): TextMessage {
  if (error instanceof LocalizedError) return error.text;
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
  return raw ? rawText(raw) : fallback;
}

/* ------------------------------------------------------------------ *
 * Backend Chinese error mapping (English only; unknown text stays as-is)
 * ------------------------------------------------------------------ */

const EN_STATUS: Record<number, string> = {
  400: 'Bad request',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to do that',
  404: 'The requested resource was not found',
  409: 'The request conflicts with the current state',
  413: 'The uploaded content is too large',
  429: 'Too many requests. Please try again later',
  500: 'The server encountered an error',
  502: 'The media server (SRS) is temporarily unavailable',
  504: 'The media server (SRS) timed out',
};

const ZH_STATUS: Record<number, string> = {
  400: '请求无效',
  401: '登录状态已失效，请重新登录',
  403: '没有权限执行该操作',
  404: '请求的资源不存在',
  409: '请求与当前状态冲突',
  413: '上传内容过大',
  429: '请求过于频繁，请稍后重试',
  500: '服务器内部错误',
  502: '媒体服务器（SRS）暂时不可用',
  504: '媒体服务器（SRS）响应超时',
};

/** Common Chinese backend messages → English; checked in order. */
const BACKEND_ERROR_EN: Array<[RegExp, string]> = [
  [/登录状态.*(失效|过期)|token\s*(失效|过期|无效)|需要登录|请先登录|未登录/i, 'Your session has expired. Please sign in again.'],
  [/用户名或密码|密码错误|账号或密码|用户名.*不存在/i, 'Incorrect username or password'],
  [/用户名.*(已存在|已被占用|被占用)|已注册/i, 'That username is already taken'],
  [/主播尚未开播|尚未开播|未开始直播|直播未开始/i, 'The host has not started streaming yet'],
  [/直播间.*(不存在|已下架|已被下架|已关闭|已结束)|直播.*(不存在|已下架)/i, 'The live room does not exist or has ended'],
  [/没有权限|无权限|权限不足|无权/i, 'You do not have permission for this action'],
  [/请求过于频繁|操作过于频繁|稍后再试|稍后重试/i, 'Too many requests. Please try again later'],
  [/媒体服务器|SRS/i, 'The media server (SRS) is temporarily unavailable'],
  [/超时|timed?\s*out/i, 'The request timed out'],
  [/过大|太大|超过\s*2\s*MB|413/i, 'The uploaded content is too large'],
  [/封面|cover/i, 'Cover processing failed'],
  [/SDP|信令|signaling/i, 'Media negotiation failed'],
  [/无效|格式错误|不合法|非法|参数错误/i, 'The request was invalid'],
  [/服务器|内部错误|服务不可用/i, 'The server encountered an error'],
];

function statusText(status: number | undefined): string {
  if (!status) return '';
  return (lang === 'zh' ? ZH_STATUS : EN_STATUS)[status] ?? '';
}

/**
 * Localize a backend detail. Chinese mode keeps the original text (it is
 * already Chinese); English mode maps common Chinese backend errors, keeps
 * unknown text unchanged, and falls back to the HTTP status text when empty.
 */
export function localizeBackendDetail(raw: string, status?: number): string {
  const value = String(raw || '').trim();
  if (lang === 'zh') return value || statusText(status);
  if (!value) return statusText(status);
  for (const [pattern, text] of BACKEND_ERROR_EN) {
    if (pattern.test(value)) return text;
  }
  return value;
}

/* ------------------------------------------------------------------ *
 * Language store + hook
 * ------------------------------------------------------------------ */

function detectLanguage(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch {
    // Storage can be blocked in private/embedded contexts.
  }
  const nav = typeof navigator === 'undefined'
    ? ''
    : navigator.languages?.[0] || navigator.language || '';
  return /^zh/i.test(nav) ? 'zh' : 'en';
}

let lang: Lang = detectLanguage();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function subscribeLang(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function applyDocumentLanguage(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('app.title');
}

export function setLang(next: Lang): void {
  if (next === lang) return;
  lang = next;
  try {
    localStorage.setItem(LANG_STORAGE_KEY, next);
  } catch {
    // Persisting is best-effort.
  }
  applyDocumentLanguage();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // One broken subscriber must not stop the others.
    }
  }
}

/** Current language plus a re-render on every switch. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang, getLang);
}

/** Alias kept for readability at call sites. */
export function useI18n(): { lang: Lang; t: typeof t; setLang: typeof setLang } {
  return { lang: useLang(), t, setLang };
}

applyDocumentLanguage();
