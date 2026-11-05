import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const activity = () => read('android/app/src/main/java/com/conglive/app/MainActivity.kt');
const service = () => read('android/app/src/main/java/com/conglive/app/ScreenStreamService.kt');
const videoSettings = () => read('android/app/src/main/java/com/conglive/app/VideoSettings.kt');
const l10n = () => read('android/app/src/main/java/com/conglive/app/L10n.kt');
const playbackClient = () => read('android/app/src/main/java/com/conglive/app/WebRtcPlaybackClient.kt');
const live2dViewer = () => read('android/app/src/main/java/com/conglive/app/Live2DViewer.kt');
const previewBridge = () => read('android/app/src/main/java/com/conglive/app/CameraPreviewBridge.kt');
const voiceRoom = () => read('android/app/src/main/java/com/conglive/app/VoiceRoomClient.kt');

test('Android manifest declares camera permission and camera foreground-service type', () => {
  const xml = read('android/app/src/main/AndroidManifest.xml');
  assert.match(xml, /android\.permission\.CAMERA/);
  assert.match(xml, /android\.permission\.FOREGROUND_SERVICE_CAMERA/);
  assert.match(xml, /android:foregroundServiceType="[^"]*camera[^"]*"/);
  assert.match(xml, /android\.hardware\.camera\.any" android:required="false"/);
});

test('camera mode uses Camera2 and publishes one video track through WHIP', () => {
  const stream = service();
  assert.match(stream, /Camera2Enumerator\(applicationContext\)/);
  assert.match(stream, /Camera1Enumerator\(false\)/);
  assert.match(stream, /enumerator\.createCapturer\(/);
  // v0.7.5: the capture format comes from the broadcast-page settings, not hard-coded values.
  assert.match(stream, /cameraCapturer\?\.startCapture\(captureWidth, captureHeight, fps\)/);
  assert.match(stream, /CameraPreviewBridge\.publish\(video, egl\.eglBaseContext, frontCamera\)/);
  assert.match(stream, /DefaultVideoEncoderFactory\(egl\.eglBaseContext, true, false\)/);
  assert.match(stream, /connection\.addTrack\(screenTrack, listOf\("conglive-live"\)\)/);
  assert.match(stream, /camera\.switchCamera/);
});

test('camera mode does not bypass explicit user camera permission request', () => {
  const screen = activity();
  assert.match(screen, /ContextCompat\.checkSelfPermission\(this, Manifest\.permission\.CAMERA\)/);
  assert.match(screen, /cameraPermission\.launch\(Manifest\.permission\.CAMERA\)/);
  assert.match(screen, /EXTRA_CAMERA_MODE, true/);
});

test('camera preview keeps the 0.7.4 z-order, init-before-addView and lifecycle fixes', () => {
  const bridge = read('android/app/src/main/java/com/conglive/app/CameraPreviewBridge.kt');
  const screen = activity();
  assert.match(bridge, /track\.addSink\(renderer\)/);
  assert.match(bridge, /activeTrack\?\.removeSink\(renderer\)/);
  assert.match(screen, /CameraPreviewBridge\.attach\(preview\)/);
  assert.match(screen, /CameraPreviewBridge\.detach\(preview\)/);
  // The local preview renderer must sit above the Activity window on all devices.
  assert.ok(
    (screen.match(/setZOrderOnTop\(true\)/g) ?? []).length >= 2,
    'camera preview and WHEP renderer must both call setZOrderOnTop(true)'
  );
  const attachAt = screen.indexOf('CameraPreviewBridge.attach(preview)');
  const addAt = screen.indexOf('card.addView(preview)');
  assert.ok(attachAt > 0 && addAt > attachAt, 'camera preview renderer must be initialized before addView');
  // Status broadcasts must not rebuild the preview on every tick (black-screen regression from 0.7.4).
  assert.match(
    screen,
    /if \(currentTab == 1 && cameraStreamingActive != wasCameraStreamingActive\) render\(\)/
  );
});

test('camera capture resources are stopped and preview bridge is cleared on stop', () => {
  const stream = service();
  assert.match(stream, /capturer\?\.stopCapture\(\)/);
  assert.match(stream, /capturer\?\.dispose\(\)/);
  assert.match(stream, /CameraPreviewBridge\.clear\(\)/);
});

test('broadcast page offers v0.7.9 1080p/720p/540p/360p and 60/30/24/15 fps settings persisted in SharedPreferences', () => {
  const screen = activity();
  const settings = videoSettings();
  assert.match(settings, /Resolution\("1080p", "1080p", 1920, 1080, 6_000_000\)/);
  assert.match(settings, /Resolution\("720p", "720p", 1280, 720, 2_000_000\)/);
  assert.match(settings, /Resolution\("540p", "540p", 960, 540, 1_200_000\)/);
  assert.match(settings, /Resolution\("360p", "360p", 640, 360, 800_000\)/);
  assert.match(settings, /val FPS_OPTIONS: List<Int> = listOf\(60, 30, 24, 15\)/);
  assert.match(settings, /const val HIGH_RESOLUTION_ID = "1080p"/);
  assert.match(settings, /const val HIGH_FPS = 60/);
  assert.match(settings, /const val DEFAULT_RESOLUTION_ID = "720p"/);
  assert.match(settings, /const val DEFAULT_FPS = 24/);
  // Buttons reuse the existing actionButton style and are painted from the persisted selection.
  assert.match(screen, /VideoSettings\.RESOLUTIONS\.forEach \{ option ->/);
  assert.match(screen, /actionButton\(option\.label, false\)/);
  assert.match(screen, /VideoSettings\.FPS_OPTIONS\.forEach \{ fps ->/);
  assert.match(screen, /actionButton\("\$fps fps", false\)/);
  assert.match(screen, /putString\(VideoSettings\.KEY_RESOLUTION, videoResolution\.id\)/);
  assert.match(screen, /putInt\(VideoSettings\.KEY_FPS, videoFps\)/);
  assert.match(screen, /prefs\.getString\(VideoSettings\.KEY_RESOLUTION, VideoSettings\.DEFAULT_RESOLUTION_ID\)/);
  assert.match(screen, /prefs\.getInt\(VideoSettings\.KEY_FPS, VideoSettings\.DEFAULT_FPS\)/);
});

test('broadcast page passes the selected quality to ScreenStreamService via Intent extras', () => {
  const screen = activity();
  assert.match(screen, /private fun putVideoExtras\(intent: Intent\)/);
  assert.match(screen, /putExtra\(ScreenStreamService\.EXTRA_VIDEO_WIDTH, videoResolution\.width\)/);
  assert.match(screen, /putExtra\(ScreenStreamService\.EXTRA_VIDEO_HEIGHT, videoResolution\.height\)/);
  assert.match(screen, /putExtra\(ScreenStreamService\.EXTRA_VIDEO_BITRATE, VideoSettings\.effectiveBitrate\(videoResolution, videoFps\)\)/);
  assert.match(screen, /putExtra\(ScreenStreamService\.EXTRA_VIDEO_FPS, videoFps\)/);
  // Both the screen-capture and camera-capture Intents carry the same extras.
  assert.equal((screen.match(/putVideoExtras\(this\)/g) ?? []).length, 2);
});

test('ScreenStreamService applies settings: landscape camera, portrait screen, prepareVideo and startCapture', () => {
  const stream = service();
  assert.match(stream, /const val EXTRA_VIDEO_WIDTH = "video_width"/);
  assert.match(stream, /const val EXTRA_VIDEO_HEIGHT = "video_height"/);
  assert.match(stream, /const val EXTRA_VIDEO_BITRATE = "video_bitrate"/);
  assert.match(stream, /const val EXTRA_VIDEO_FPS = "video_fps"/);
  assert.match(stream, /getIntExtra\(EXTRA_VIDEO_WIDTH, fallback\.width\)/);
  assert.match(stream, /getIntExtra\(EXTRA_VIDEO_HEIGHT, fallback\.height\)/);
  assert.match(stream, /getIntExtra\(EXTRA_VIDEO_BITRATE, fallback\.bitrateBps\)/);
  assert.match(stream, /getIntExtra\(EXTRA_VIDEO_FPS, VideoSettings\.DEFAULT_FPS\)/);
  // Camera uses landscape dimensions; screen sharing exchanges them for portrait.
  assert.match(stream, /val captureWidth = if \(useCamera\) width else height/);
  assert.match(stream, /val captureHeight = if \(useCamera\) height else width/);
  // Encoder/capture format comes from the settings, with the 1 second keyframe interval.
  assert.match(
    stream,
    /prepareVideo\(captureWidth, captureHeight, bitrateBps, fps, iFrameInterval = VideoSettings\.DEFAULT_IFRAME_INTERVAL\)/
  );
  assert.match(stream, /source\.adaptOutputFormat\(width, height, fps\)/);
  assert.match(stream, /capturer\?\.startCapture\(captureWidth, captureHeight, fps\)/);
  // Bitrate and frame rate are applied to the video RTP sender.
  assert.match(stream, /applyVideoEncodingParameters\(videoTransceiver\.sender\)/);
  assert.match(stream, /encoding\.maxBitrateBps = videoBitrateBps/);
  assert.match(stream, /encoding\.maxFramerate = videoFps/);
});

test('Android package version is bumped to 0.8.2 (versionCode 24)', () => {
  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /versionCode = 24/);
  assert.match(gradle, /versionName = "0\.8\.2"/);
  // The in-app header shows the same version.
  assert.match(activity(), /text = "v0\.8\.2"/);
});

test('cover picking uses ACTION_OPEN_DOCUMENT and uploads a <=2MB imageData data URL', () => {
  const screen = activity();
  const covers = read('android/app/src/main/java/com/conglive/app/CoverSupport.kt');
  // The system photo picker runs through ACTION_OPEN_DOCUMENT, so no storage permission is needed.
  assert.match(screen, /ActivityResultContracts\.OpenDocument\(\)/);
  assert.match(screen, /coverPicker\.launch\(arrayOf\("image\/\*"\)\)/);
  // 2MB decoded limit, JPEG data URL and the {imageData} -> {coverUrl} contract.
  assert.match(covers, /const val MAX_BYTES: Int = 2 \* 1024 \* 1024/);
  assert.match(covers, /data:image\/jpeg;base64,/);
  assert.ok(screen.includes('"/api/streams/$streamId/cover"'), 'cover upload must post to /api/streams/:id/cover');
  assert.ok(screen.includes('.put("imageData", prepared.dataUrl)'), 'cover upload body must be {imageData}');
  assert.match(screen, /optString\("coverUrl"\)/);
});

test('lobby and 我的直播记录 render coverUrl with gradient + title initial fallback', () => {
  const screen = activity();
  assert.match(screen, /optString\("coverUrl"\)/);
  assert.match(screen, /coverFrame\(stream\.title, stream\.coverUrl/);
  // No cover (or failed download) still paints a gradient card with the title's first character.
  assert.match(screen, /text = title\.trim\(\)\.take\(1\)/);
  assert.match(screen, /CoverLoader\.load\(coverUrl, image\)/);
  // Cover downloads use HttpURLConnection + BitmapFactory, not Glide/Coil.
  const covers = read('android/app/src/main/java/com/conglive/app/CoverSupport.kt');
  assert.match(covers, /HttpURLConnection/);
  assert.match(covers, /BitmapFactory\.decodeByteArray/);
  const gradle = read('android/app/build.gradle.kts');
  assert.doesNotMatch(gradle, /glide|coil/i);
});

test('Live2D 看板娘 entry loads a local WebView page with CDN pixi.js and a model URL input', () => {
  const screen = activity();
  const viewer = read('android/app/src/main/java/com/conglive/app/Live2DViewer.kt');
  const html = read('android/app/src/main/assets/live2d/viewer.html');
  // Bottom navigation gets a dedicated 看板娘 tab; the label is localized in v0.7.7.
  assert.match(screen, /"✨" to "nav\.live2d"/);
  assert.match(l10n(), /"nav\.live2d" to \("看板娘" to "Mascot"\)/);
  assert.match(screen, /private fun renderLive2D\(\)/);
  assert.match(screen, /actionButton\(tr\("live2d\.load"\), true\)/);
  // The page itself is a local asset; scripts come from CDNs and no model is bundled.
  assert.match(viewer, /file:\/\/\/android_asset\/live2d\/viewer\.html/);
  assert.match(viewer, /javaScriptEnabled = true/);
  assert.match(viewer, /url\.contains\("\.model3\.json"\)/);
  assert.match(viewer, /window\.loadLive2DModel/);
  assert.match(html, /pixi-live2d-display/);
  assert.match(html, /PIXI\.live2d\.Live2DModel\.from/);
  assert.match(html, /window\.hideLive2D/);
  assert.match(html, /window\.showLive2D/);
  // The Live2D companion is UI only; it must never be composited into WebRTC.
  assert.doesNotMatch(viewer, /PeerConnection|addTrack|VideoTrack/);
});

test('v0.8.2 Live2D 看板娘 picks a local model zip and loads it through JSZip blob URLs', () => {
  const screen = activity();
  const viewer = live2dViewer();
  const html = read('android/app/src/main/assets/live2d/viewer.html');
  // 看板娘页新增「选择模型包」按钮；用系统文件选择器选 zip（兼容 octet-stream）。
  assert.match(screen, /actionButton\(tr\("live2d\.pickZip"\), true\)/);
  assert.match(l10n(), /"live2d\.pickZip" to \(/);
  assert.match(screen, /private val live2DZipPicker = registerForActivityResult\(ActivityResultContracts\.OpenDocument\(\)\)/);
  assert.match(screen, /live2DZipPicker\.launch\(arrayOf\("application\/zip", "application\/octet-stream"\)\)/);
  // content URI 被复制到 cacheDir 的 live2d-model-<ts>.zip，WebView 读到的是 file:// URL。
  assert.match(screen, /copyLive2DZipToCache\(uri: Uri\)/);
  assert.match(screen, /cacheDir, "live2d-model-" \+ System\.currentTimeMillis\(\) \+ "\.zip"/);
  assert.match(screen, /viewer\.loadLocalZip\(file\)/);
  // Live2DViewer：加载 file:///android_asset/live2d/viewer.html?zip=<encoded file url>，
  // 并开启 file:// 页面之间的访问权限；URL 输入方式继续保留。
  assert.match(viewer, /fun loadLocalZip\(file: File\)/);
  assert.match(viewer, /ASSET_URL \+ "\?" \+ ZIP_QUERY \+ "=" \+ Uri\.encode\(fileUrl\)/);
  assert.match(viewer, /settings\.allowFileAccessFromFileURLs = true/);
  assert.match(viewer, /settings\.allowUniversalAccessFromFileURLs = true/);
  assert.match(viewer, /fun loadModel\(rawUrl: String\)/);
  assert.match(viewer, /window\.loadLive2DModel/);
  // viewer.html：JSZip CDN + 读取 zip 参数 → 解压 → blob URL → 改写 FileReferences。
  assert.match(html, /jszip@/);
  assert.match(html, /JSZip\.loadAsync/);
  assert.match(html, /window\.loadLive2DZip = function/);
  assert.match(html, /URL\.createObjectURL/);
  assert.match(html, /URL\.revokeObjectURL/);
  assert.match(html, /get\('zip'\)/);
  assert.match(html, /FileReferences/);
  assert.match(html, /window\.loadLive2DModel\(modelJsonUrl\)/);
  // pixi 6 的 legacy url.resolve 会破坏 blob: URL，用 URL 标准替换后再交给 pixi。
  assert.match(html, /patchPixiResolve/);
  assert.match(html, /PIXI\.utils\.url\.resolve = function/);
  // 错误提示：没有模型文件 / 读取失败 / JSZip CDN 失败（中英双语）。
  assert.match(html, /zipNoModel/);
  assert.match(html, /zipReadFailed/);
  assert.match(html, /jszipMissing/);
  assert.match(html, /jszip@[0-9.]+\/dist\/jszip\.min\.js[\s\S]*?__congliveJszipError/);
});

// ---------------------------------------------------------------------------
// v0.7.7: in-app Chinese / English language switch
// ---------------------------------------------------------------------------

test('L10n.kt defines zh/en, defaults to the system language and persists app_language', () => {
  const l10nSrc = l10n();
  assert.match(l10nSrc, /enum class Lang\(val code: String\)/);
  assert.match(l10nSrc, /ZH\("zh"\)/);
  assert.match(l10nSrc, /EN\("en"\)/);
  assert.match(l10nSrc, /fun fromSystem\(\): Lang/);
  assert.match(l10nSrc, /Locale\.getDefault\(\)\.language\.lowercase\(Locale\.US\)\.startsWith\("zh"\)/);
  assert.match(l10nSrc, /const val PREF_KEY = "app_language"/);
  assert.match(l10nSrc, /fun read\(context: Context\): Lang/);
  assert.match(l10nSrc, /fun write\(context: Context, lang: Lang\)/);
  assert.match(l10nSrc, /putString\(PREF_KEY, lang\.code\)/);
  assert.match(l10nSrc, /fun t\(lang: Lang, key: String, vararg args: Any\?\): String/);
  assert.match(l10nSrc, /String\.format\(Locale\.US, template, \*args\)/);
});

test('dictionary has zh/en for every screen and every key the app uses', () => {
  const l10nSrc = l10n();
  const defined = new Set(
    [...l10nSrc.matchAll(/"([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)+)" to \(/g)].map((match) => match[1])
  );
  assert.ok(defined.size >= 180, `expected a full dictionary, got ${defined.size} entries`);
  for (const key of [
    'nav.lobby', 'nav.broadcast', 'nav.recordings', 'nav.profile', 'nav.live2d',
    'auth.welcome', 'auth.login', 'auth.register',
    'lobby.title', 'lobby.empty', 'chat.title', 'chat.placeholder',
    'broadcast.title', 'broadcast.qualityTitle', 'broadcast.stop',
    'recordings.title', 'recordings.empty',
    'profile.title', 'profile.language', 'profile.settings',
    'live2d.title', 'live2d.load',
    'status.languageChanged', 'status.liveConfirmed',
    'svc.iceConnected', 'svc.cameraStarted', 'svc.stopped',
    'playback.connected', 'bridge.firstFrame', 'cover.initialFallback'
  ]) {
    assert.ok(defined.has(key), `dictionary must define ${key}`);
  }
  // Both languages exist for representative strings from every page.
  assert.match(l10nSrc, /"直播大厅" to "Live Lobby"/);
  assert.match(l10nSrc, /"创建直播" to "Create a Stream"/);
  assert.match(l10nSrc, /"我的录像" to "My Recordings"/);
  assert.match(l10nSrc, /"语言 \/ Language" to "Language \/ 语言"/);
  assert.match(l10nSrc, /"Live2D 看板娘" to "Live2D Mascot"/);
  assert.match(l10nSrc, /"还没有评论，发出第一条弹幕吧。" to "No comments yet — send the first one\."/);
  assert.match(l10nSrc, /"账号已被管理员封禁" to "The account has been banned by an administrator"/);

  // Every tr("…") / L10n.t("…") call site must resolve to a dictionary entry.
  const sources = [activity(), service(), playbackClient(), live2dViewer(), previewBridge(), voiceRoom()];
  const used = new Set();
  for (const src of sources) {
    for (const match of src.matchAll(/(?:tr|L10n\.t)\(\s*"([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)+)"/g)) used.add(match[1]);
  }
  assert.ok(used.size >= 120, `expected many localized call sites, got ${used.size}`);
  const missing = [...used].filter((key) => !defined.has(key)).sort();
  assert.deepEqual(missing, [], `missing dictionary keys: ${missing.join(', ')}`);
});

test('我的 page offers 中文 / English switching that persists and rebuilds the UI in place', () => {
  const screen = activity();
  assert.match(screen, /lang = L10n\.read\(this\)/);
  assert.match(screen, /private fun switchLanguage\(newLang: Lang\)/);
  assert.match(screen, /L10n\.write\(this, newLang\)/);
  assert.match(screen, /actionButton\(tr\("lang\.zh"\), false\) \{ switchLanguage\(Lang\.ZH\) \}/);
  assert.match(screen, /actionButton\(tr\("lang\.en"\), false\) \{ switchLanguage\(Lang\.EN\) \}/);
  assert.match(screen, /private fun renderProfile\(\)[\s\S]*?val language = panel\(\)/);
  // The view hierarchy is rebuilt immediately: no Activity.recreate(), no app restart.
  assert.match(screen, /buildShell\(\)\s*\n\s*render\(\)/);
  assert.doesNotMatch(screen, /\.recreate\(\)/);
  // The language also reaches the preview bridge, the Live2D page and the streaming service.
  assert.match(screen, /CameraPreviewBridge\.setLanguage\(newLang\)/);
  assert.match(screen, /live2DViewer\?\.setLanguage\(newLang\)/);
  assert.match(screen, /putExtra\(ScreenStreamService\.EXTRA_LANGUAGE, lang\.code\)/);
  // Every page renders through the dictionary.
  for (const render of ['renderAuthCard', 'renderLobby', 'renderBroadcast', 'renderRecordings', 'renderProfile', 'renderLive2D']) {
    assert.match(screen, new RegExp(`private fun ${render}\\(\\)`));
  }
  assert.ok((screen.match(/tr\("/g) ?? []).length >= 100, 'the whole UI must go through tr()');
  // No hard-coded Chinese user-visible strings (comments are allowed).
  const chineseCodeLines = screen
    .split('\n')
    .filter((line) => /[\u4e00-\u9fff]/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(chineseCodeLines, [], 'MainActivity must not hard-code Chinese UI text');
});

test('ScreenStreamService localizes status/errors and broadcasts machine-readable status codes', () => {
  const stream = service();
  for (const constant of [
    'EXTRA_LANGUAGE = "language"',
    'EXTRA_STATUS_CODE = "status_code"',
    'STATUS_CAMERA_STARTED = "camera_started"',
    'STATUS_CAMERA_FRONT = "camera_front"',
    'STATUS_CAMERA_BACK = "camera_back"',
    'STATUS_PUSH_OK = "push_ok"',
    'STATUS_CONNECTING = "connecting"',
    'STATUS_STOPPED = "stopped"',
    'STATUS_FAILED = "failed"'
  ]) {
    assert.ok(stream.includes(constant), `service must define ${constant}`);
  }
  // Language: SharedPreferences `app_language` with the Activity's Intent extra as fallback.
  assert.match(stream, /fun currentLanguage\(\): Lang/);
  assert.match(stream, /L10n\.read\(applicationContext\)/);
  assert.match(stream, /getStringExtra\(EXTRA_LANGUAGE\)/);
  assert.match(stream, /L10n\.t\(currentLanguage\(\), key, \*args\)/);
  assert.match(stream, /putExtra\(EXTRA_STATUS_CODE, code\)/);
  assert.match(stream, /putExtra\(EXTRA_LANGUAGE, currentLanguage\(\)\.code\)/);
  // Chinese messages became dictionary lookups; notifications are localized too.
  assert.match(stream, /sendStatus\(tr\("svc\.cameraStarted"\), STATUS_CAMERA_STARTED\)/);
  assert.match(stream, /sendStatus\(tr\("svc\.iceConnected"\), STATUS_PUSH_OK\)/);
  assert.match(stream, /stopStreaming\(tr\("svc\.stopped"\), STATUS_STOPPED\)/);
  assert.match(stream, /NotificationChannel\(CHANNEL_ID, tr\("svc\.channelName"\)/);
  assert.match(stream, /setContentTitle\(tr\("brand\.app"\)\)/);
  const chineseCodeLines = stream
    .split('\n')
    .filter((line) => /[\u4e00-\u9fff]/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  assert.deepEqual(chineseCodeLines, [], 'no hard-coded Chinese remains in the service code');
});

test('MainActivity drives streaming state from status codes, not from localized text', () => {
  const screen = activity();
  assert.match(screen, /val code = intent\?\.getStringExtra\(ScreenStreamService\.EXTRA_STATUS_CODE\)/);
  assert.match(screen, /ScreenStreamService\.STATUS_CAMERA_STARTED -> cameraStreamingActive = true/);
  assert.match(screen, /ScreenStreamService\.STATUS_CAMERA_FRONT -> cameraFacingFront = true/);
  assert.match(screen, /ScreenStreamService\.STATUS_CAMERA_BACK -> cameraFacingFront = false/);
  assert.match(screen, /ScreenStreamService\.STATUS_PUSH_OK/);
  assert.match(screen, /ScreenStreamService\.STATUS_STOPPED,\s*\n\s*ScreenStreamService\.STATUS_FAILED -> \{/);
  assert.doesNotMatch(screen, /message\.contains\(/);
});

test('WHEP playback, Live2D page and camera preview localize user-visible status', () => {
  const playback = playbackClient();
  assert.match(playback, /private val lang: Lang = L10n\.read\(context\)/);
  assert.match(playback, /private fun tr\(key: String, vararg args: Any\?\): String = L10n\.t\(lang, key, \*args\)/);
  assert.match(playback, /tr\("playback\.firstFrame"\)/);
  assert.match(playback, /tr\("playback\.connected"\)/);
  assert.match(playback, /tr\("playback\.failed"/);
  assert.match(activity(), /currentToken,\s*\n\s*lang\s*\n\s*\)/);

  const viewer = live2dViewer();
  assert.match(viewer, /private var language: Lang = lang/);
  assert.match(viewer, /fun setLanguage\(newLang: Lang\)/);
  assert.match(viewer, /fun tr\(key: String, vararg args: Any\?\): String = L10n\.t\(language, key, \*args\)/);
  assert.match(viewer, /tr\("live2d\.loadFailed"\)/);
  assert.match(viewer, /window\.setLive2DLanguage/);
  assert.match(viewer, /JSONObject\.quote\(language\.code\)/);

  const bridge = previewBridge();
  assert.match(bridge, /fun setLanguage\(lang: Lang\)/);
  assert.match(bridge, /var onStatus: \(\(String\) -> Unit\)\? = null/);
  assert.match(bridge, /report\("bridge\.firstFrame"\)/);
  assert.match(bridge, /L10n\.t\(language, key, \*args\)/);

  const html = read('android/app/src/main/assets/live2d/viewer.html');
  assert.match(html, /window\.setLive2DLanguage = function \(code\)/);
  assert.match(html, /var STRINGS = \{/);
  assert.match(html, /en: \{/);
  assert.match(html, /title: 'Live2D Mascot'/);
});

test('0.7.6 fixes are preserved in 0.7.7 (quality, z-order, init-before-addView, covers, Live2D)', () => {
  const screen = activity();
  const stream = service();
  const bridge = previewBridge();
  // Resolution / frame-rate settings and Intent extras.
  assert.match(screen, /VideoSettings\.RESOLUTIONS\.forEach \{ option ->/);
  assert.match(screen, /VideoSettings\.FPS_OPTIONS\.forEach \{ fps ->/);
  assert.equal((screen.match(/putVideoExtras\(this\)/g) ?? []).length, 2);
  assert.match(stream, /cameraCapturer\?\.startCapture\(captureWidth, captureHeight, fps\)/);
  assert.match(stream, /applyVideoEncodingParameters\(videoTransceiver\.sender\)/);
  // SurfaceView z-order + init-before-addView for the camera preview and WHEP renderer.
  assert.ok((screen.match(/setZOrderOnTop\(true\)/g) ?? []).length >= 2);
  const attachAt = screen.indexOf('CameraPreviewBridge.attach(preview)');
  const addAt = screen.indexOf('card.addView(preview)');
  assert.ok(attachAt > 0 && addAt > attachAt);
  assert.match(screen, /CameraPreviewBridge\.detach\(preview\)/);
  assert.match(bridge, /track\.addSink\(renderer\)/);
  assert.match(bridge, /activeTrack\?\.removeSink\(renderer\)/);
  // Cover picking / rendering, and the Live2D UI-only entry.
  assert.match(screen, /ActivityResultContracts\.OpenDocument\(\)/);
  assert.match(screen, /coverFrame\(stream\.title, stream\.coverUrl/);
  assert.match(screen, /CoverLoader\.load\(coverUrl, image\)/);
  assert.match(screen, /"✨" to "nav\.live2d"/);
  const viewer = live2dViewer();
  assert.doesNotMatch(viewer, /PeerConnection|addTrack|VideoTrack/);
});

// ---------------------------------------------------------------------------
// v0.7.9: 1080p60 capacity gating, standalone room, latency monitor, domain
// ---------------------------------------------------------------------------

test('v0.7.9 quality profiles: 1080p60 is the only high-bitrate profile and bitrate is clamped', () => {
  const settings = videoSettings();
  const stream = service();
  // Resolution/FPS table plus the capacity-gated high profile.
  assert.match(settings, /fun effectiveBitrate\(resolution: Resolution\?, fps: Int, requestedBps: Int = 0\): Int/);
  assert.match(settings, /fun effectiveBitrate\(width: Int, height: Int, fps: Int, requestedBps: Int\): Int/);
  assert.match(settings, /fun requiresHighCapacity\(resolution: Resolution\?, fps: Int\): Boolean/);
  assert.match(settings, /const val LOW_BITRATE_CEILING = 2_000_000/);
  assert.match(settings, /const val HIGH_BITRATE_CEILING = 8_000_000/);
  // 1080p portrait/landscape + 60fps are valid service inputs; only that profile
  // may exceed the low-bitrate ceiling.
  assert.match(stream, /const val MAX_VIDEO_FPS = 60/);
  assert.match(stream, /videoFps = if \(requestedFps in VideoSettings\.FPS_OPTIONS\) requestedFps else VideoSettings\.DEFAULT_FPS/);
  assert.match(stream, /\.effectiveBitrate\(configuredWidth, configuredHeight, videoFps, requestedBitrate\)/);
  assert.match(stream, /val clampedBitrate = VideoSettings\s*\n\s*\.effectiveBitrate\(width, height, fps, bitrateBps\)/);
  assert.match(stream, /encoding\.maxBitrateBps = videoBitrateBps/);
  assert.match(stream, /encoding\.maxFramerate = videoFps/);
  // The broadcast page sends the clamped bitrate, not the raw 6 Mbps profile.
  assert.match(activity(), /VideoSettings\.effectiveBitrate\(videoResolution, videoFps\)\)/);
});

test('v0.7.9 broadcast page checks GET /api/capacity and gates 1080p/60fps with a reason', () => {
  const screen = activity();
  const l10nSrc = l10n();
  // Capacity is fetched when the broadcast page opens and again right before going live.
  assert.match(screen, /private fun refreshCapacity\(force: Boolean = false, done: \(\(\) -> Unit\)\? = null\)/);
  assert.match(screen, /apiRequest\("GET", "\/api\/capacity", null, false\)/);
  assert.match(screen, /capacity\.optBooleanCompat\("allow1080p60"\)/);
  assert.match(screen, /if \(index == 1\) refreshCapacity\(\)/);
  assert.match(screen, /refreshCapacity\(force = true\) \{ startCaptureAfterCapacity\(\) \}/);
  // 1080p and 60fps stay disabled unless the server reports allow1080p60=true.
  assert.match(screen, /val allowHighQuality = capacityAllow1080p60 == true/);
  assert.match(screen, /if \(option\.id == VideoSettings\.HIGH_RESOLUTION_ID\) button\.isEnabled = allowHighQuality/);
  assert.match(screen, /if \(fps >= VideoSettings\.HIGH_FPS\) button\.isEnabled = allowHighQuality/);
  // A disabled profile is explained, and a high-quality start is rejected + reset.
  assert.match(screen, /private fun capacitySummaryText\(\)/);
  assert.match(screen, /tr\("broadcast\.capacityDisabled", capacityLimitReason\(\)\)/);
  assert.match(screen, /private fun resetHighQualitySelection\(\)/);
  assert.match(screen, /tr\("broadcast\.highQualityBlocked", capacityLimitReason\(\)\)/);
  for (const key of [
    'broadcast.capacityTitle', 'broadcast.capacityAllowed', 'broadcast.capacityChecking',
    'broadcast.capacityDisabled', 'broadcast.capacityUnavailable', 'broadcast.highQualityReset',
    'broadcast.highQualityBlocked'
  ]) {
    assert.ok(l10nSrc.includes(`"${key}" to (`), `dictionary must define ${key}`);
  }
});

test('v0.7.9 lobby opens a standalone room page with detail API, viewers, WHEP and back navigation', () => {
  const screen = activity();
  // Tapping a lobby card (or its button) opens the full-screen room.
  assert.match(screen, /setOnClickListener \{ openRoom\(stream\) \}/);
  assert.match(screen, /actionButton\(tr\("lobby\.enter"\), true\) \{ openRoom\(stream\) \}/);
  assert.match(screen, /private fun openRoom\(stream: LiveStream\)/);
  assert.match(screen, /private fun renderRoom\(stream: LiveStream\)/);
  assert.match(screen, /private fun leaveRoom\(message: String\? = null\)/);
  // Full-screen: shell chrome is hidden while the room is open.
  assert.match(screen, /private fun applyChromeVisibility\(\)/);
  assert.match(screen, /headerView\?\.visibility = if \(inRoom\) View\.GONE else View\.VISIBLE/);
  // Room contents: back, cover, title, host, WHEP player, latency, chat, viewers.
  assert.match(screen, /actionButton\(tr\("room\.back"\), false\) \{ leaveRoom\(\) \}/);
  assert.match(screen, /coverFrame\(stream\.title, stream\.coverUrl, large = true\)/);
  assert.match(screen, /heading\(stream\.title\)/);
  assert.match(screen, /tr\("room\.host", stream\.username\)/);
  assert.match(screen, /attachLiveRenderer\(top, 210, stream\)/);
  assert.match(screen, /tr\("room\.viewers", roomViewers\)/);
  assert.match(screen, /private fun fillRoomChat\(\)/);
  // Data: GET /api/streams/:id, WS viewers, ended/404 back to the lobby.
  assert.match(screen, /apiRequest\("GET", "\/api\/streams\/\$\{stream\.id\}", null, false\)/);
  assert.match(screen, /leaveRoom\(tr\("room\.notFound"\)\)/);
  assert.match(screen, /leaveRoom\(tr\("room\.ended"\)\)/);
  assert.match(screen, /"viewers" -> \{/);
  assert.match(screen, /data\.optLong\("streamId", -1L\)/);
  assert.match(screen, /roomViewers = viewers/);
  // The hardware back gesture leaves the room before the activity.
  assert.match(screen, /override fun onBackPressed\(\)/);
  assert.match(screen, /if \(roomStream != null\) \{\s*\n\s*leaveRoom\(\)/);
  // Live viewer counts arrive with the list and are rendered on lobby cards.
  assert.match(screen, /viewers = item\.optInt\("viewers", -1\)/);
});

test('v0.7.9 room shows WHEP latency from 1s getStats jitter buffer + RTT and cleans up', () => {
  const playback = playbackClient();
  const screen = activity();
  // 1 Hz getStats: jitterBufferDelay / jitterBufferEmittedCount + currentRoundTripTime.
  assert.match(playback, /private const val STATS_INTERVAL_MS = 1_000L/);
  assert.match(playback, /connection\.getStats\(object : RTCStatsCollectorCallback/);
  assert.match(playback, /"jitterBufferDelay"/);
  assert.match(playback, /"jitterBufferEmittedCount"/);
  assert.match(playback, /"currentRoundTripTime"/);
  assert.match(playback, /statsHandler\.postDelayed\(this, STATS_INTERVAL_MS\)/);
  // The sampler is stopped on close and the listener is released.
  assert.match(playback, /fun setLatencyListener\(listener: \(\(Int\) -> Unit\)\?\)/);
  assert.match(playback, /fun close\(\) \{[\s\S]*?stopStatsMonitoring\(\)/);
  assert.match(playback, /statsHandler\.removeCallbacksAndMessages\(null\)/);
  // The room page displays localized "latency ≈ Xms" and drops it when leaving.
  assert.match(screen, /client\.setLatencyListener \{ millis ->/);
  assert.match(screen, /private fun updateRoomLatency\(millis: Int\)/);
  assert.match(screen, /tr\("room\.latency", roomLatencyMillis\)/);
  assert.match(screen, /roomLatencyMillis = -1/);
  assert.match(screen, /private fun stopRoomPolling\(\)/);
  assert.match(screen, /roomPollRunnable\?\.let \{ mainHandler\.removeCallbacks\(it\) \}/);
});

test('v0.7.9 server address accepts bare domains, keeps port/protocol and checks /api/health', () => {
  const screen = activity();
  const l10nSrc = l10n();
  assert.match(screen, /private fun normalizeApiBase\(rawValue: String\): String\?/);
  // Bare domain -> https://; bare IPv4/IPv6 -> http:// (local VPS friendly).
  assert.match(screen, /value = if \(ipv4 \|\| ipv6\) "http:\/\/\$value" else "https:\/\/\$value"/);
  assert.match(screen, /value\.trimEnd\('\/'\)/);
  assert.match(screen, /java\.net\.URI\(value\)/);
  assert.match(screen, /if \(parsed\.host\.isNullOrBlank\(\)\) return null/);
  // Saved, then the same /api/health check runs.
  assert.match(screen, /private fun saveAndCheckServer\(rawValue: String\)/);
  assert.match(screen, /val value = normalizeApiBase\(rawValue\)/);
  assert.match(screen, /apiRequest\("GET", "\/api\/health", null, false\)/);
  assert.match(screen, /tr\("status\.serverNormalized", apiBase\)/);
  // Bilingual hints mention a bare domain.
  assert.match(l10nSrc, /live\.example\.com/);
});

test('v0.7.9 only the active room polls/stats: no PeerConnection in the lobby', () => {
  const screen = activity();
  const lobbyBody = screen.slice(screen.indexOf('private fun renderLobby()'), screen.indexOf('private fun openRoom(stream: LiveStream)'));
  assert.ok(lobbyBody.length > 0, 'renderLobby section must exist');
  assert.doesNotMatch(lobbyBody, /WebRtcPlaybackClient|attachLiveRenderer|attachPlayer/);
  // Polling and stats only exist in the room page and are stopped on leave/destroy.
  assert.match(screen, /private fun startRoomPolling\(\)/);
  assert.match(screen, /ROOM_POLL_INTERVAL_MS = 5_000L/);
  assert.match(screen, /stopRoomPolling\(\)[\s\S]{0,400}?teardownVoice\(\)\s*\n\s*stopLivePlayback\(\)\s*\n\s*disconnectChat\(\)/);
  assert.match(screen, /mainHandler\.removeCallbacksAndMessages\(null\)\s*\n\s*stopRoomPolling\(\)/);
  // Lobby list refreshes never rebuild the open room page.
  assert.match(screen, /if \(currentTab == 0 && roomStream == null\) render\(\)/);
  // 1080p60 keeps 6 Mbps; the service clamps everything else to 2 Mbps or less.
  assert.match(videoSettings(), /const val LOW_BITRATE_CEILING = 2_000_000/);
  assert.match(service(), /\.effectiveBitrate\(configuredWidth, configuredHeight, videoFps, requestedBitrate\)/);
});

// ---------------------------------------------------------------------------
// v0.8.0: full-duplex room voice (audio-only WebRTC mesh)
// ---------------------------------------------------------------------------

test('v0.8.0 voice signaling matches web/src/voice.ts and backend voice protocol', () => {
  const voice = voiceRoom();
  const screen = activity();
  // C→S message types.
  for (const type of ['voice-join', 'voice-leave', 'voice-offer', 'voice-answer', 'voice-candidate']) {
    assert.ok(voice.includes(`"${type}"`), `VoiceRoomClient must send ${type}`);
  }
  // S→C message types handled from the room socket.
  for (const type of ['voice-peers', 'voice-peer-joined', 'voice-peer-left', 'voice-offer', 'voice-answer', 'voice-candidate', 'voice-error']) {
    assert.ok(voice.includes(`"${type}"`), `VoiceRoomClient must handle ${type}`);
  }
  // Relay payloads: {target, sdp:{type,sdp}} / {target, candidate:{candidate,sdpMid,sdpMLineIndex}}.
  assert.match(voice, /\.put\("target", target\)/);
  assert.match(voice, /\.put\("sdp", JSONObject\(\)\.put\("type", sdpType\)\.put\("sdp", sdp\)\)/);
  assert.match(voice, /\.put\(\s*"candidate",\s*JSONObject\(\)/);
  assert.match(voice, /\.put\("sdpMLineIndex", candidate\.sdpMLineIndex\)/);
  // Peer records are {peerId,userId,username}; from/self/peers envelopes are decoded.
  assert.match(voice, /optString\("peerId"/);
  assert.match(voice, /optLong\("userId"/);
  assert.match(voice, /optString\("username"/);
  assert.match(voice, /optJSONObject\("from"\)/);
  assert.match(voice, /optJSONObject\("self"\)/);
  // Glare rule: the lexicographically smaller peerId sends the offer.
  assert.match(voice, /self\.peerId < peer\.peerId/);
  // Signaling rides the already authenticated room WS, not a new unauthenticated socket.
  assert.match(screen, /messageType\.startsWith\("voice-"\)/);
  assert.match(screen, /voiceClient\?\.handleSignal\(data\)/);
});

test('v0.8.0 voice mesh: mic only after join, one audio-only PC per peer, full release', () => {
  const voice = voiceRoom();
  const screen = activity();
  // One PeerConnection per remote participant, publishing the single local mic track.
  assert.match(voice, /private inner class PeerSession/);
  assert.match(voice, /peers\[info\.peerId\] = session/);
  assert.match(voice, /createPeerConnection\(config, createObserver\(session\)\)/);
  assert.match(voice, /addTrack\(local, listOf\(AUDIO_STREAM_ID\)\)/);
  assert.match(voice, /createAudioSource\(constraints\)/);
  assert.match(voice, /createAudioTrack\(AUDIO_TRACK_ID, source\)/);
  assert.match(voice, /JavaAudioDeviceModule\.builder/);
  assert.match(voice, /googEchoCancellation/);
  // The microphone and factory are created inside join() (after the explicit tap).
  assert.match(voice, /fun join\(\)/);
  assert.match(voice, /createAudioLocked\(\)/);
  assert.match(voice, /voice-join/);
  assert.ok(!/fun join\(\)[\s\S]*?createAudioLocked\(\)[\s\S]*?fun leave\(\)/.test(voice.replace(/createAudioLocked\(\)/g, '')),
    'sanity: join body contains the capture call');
  // Full release: voice-leave + close/dispose every PC + dispose tracks/factory/ADM/EglBase.
  assert.match(voice, /fun leave\(\)/);
  assert.match(voice, /fun dispose\(\)/);
  assert.match(voice, /releaseNative\(\)/);
  assert.match(voice, /pc\.close\(\)/);
  assert.match(voice, /pc\.dispose\(\)/);
  assert.match(voice, /localTrack\?\.dispose\(\)/);
  assert.match(voice, /audioSource\?\.dispose\(\)/);
  assert.match(voice, /factory\?\.dispose\(\)/);
  assert.match(voice, /audioModule\?\.release\(\)/);
  assert.match(voice, /eglBase\?\.release\(\)/);
  // Remote audio is played by the WebRTC ADM (no surface renderer / no extra track).
  assert.match(voice, /attachRemoteAudio/);
  assert.doesNotMatch(voice, /SurfaceViewRenderer|addSink/);
  // Activity requests the microphone only from the join action and tears down on leave/destroy.
  assert.match(screen, /private val voiceMicPermission = registerForActivityResult/);
  assert.match(screen, /Manifest\.permission\.RECORD_AUDIO/);
  assert.match(screen, /private fun onJoinVoice\(\)/);
  assert.match(screen, /private fun startVoiceJoin\(iceServers: List<PeerConnection\.IceServer>\)/);
  assert.match(screen, /private fun leaveVoice\(\)/);
  assert.match(screen, /private fun teardownVoice\(keepRelay: Boolean = false\)/);
  assert.equal((screen.match(/VoiceRoomClient\(/g) ?? []).length, 1, 'only the join path constructs the voice client');
  assert.match(screen, /client\.join\(\)/);
  // Leaving the room releases the mesh before the WS closes.
  const leaveRoomBody = screen.slice(screen.indexOf('private fun leaveRoom'), screen.indexOf('private fun startRoomPolling'));
  const voiceDownAt = leaveRoomBody.indexOf('teardownVoice()');
  const wsDownAt = leaveRoomBody.indexOf('disconnectChat()');
  assert.ok(voiceDownAt > 0 && wsDownAt > voiceDownAt, 'voice mesh must be released before the room socket closes');
  assert.match(screen, /stopRoomPolling\(\)[\s\S]*?teardownVoice\(\)/);
});

test('v0.8.0 voice panel shows participants/speaking, mute and zh/en messages without touching the player', () => {
  const screen = activity();
  const voice = voiceRoom();
  const l10nSrc = l10n();
  // Room page renders the voice card and only rebuilds that card on snapshots.
  assert.match(screen, /private fun fillVoiceCard\(\)/);
  assert.match(screen, /private fun addVoiceParticipant\(/);
  assert.match(screen, /heading\(tr\("voice\.title"\)\)/);
  assert.match(screen, /tr\("voice\.participants"/);
  assert.match(screen, /tr\("voice\.speaking"/);
  assert.match(screen, /tr\("voice\.join"\)/);
  assert.match(screen, /tr\("voice\.mute"\)/);
  assert.match(screen, /tr\("voice\.unmute"\)/);
  assert.match(screen, /tr\("voice\.leave"\)/);
  assert.match(screen, /private fun toggleVoiceMute\(\)/);
  // Remote speaking state comes from getStats audioLevel / totalAudioEnergy; the
  // local level is computed from the ADM PCM samples (no second AudioRecord).
  assert.match(voice, /STATS_INTERVAL_MS = 500L/);
  assert.match(voice, /getStats\(/);
  assert.match(voice, /"audioLevel"/);
  assert.match(voice, /"totalAudioEnergy"/);
  assert.match(voice, /SPEAKING_THRESHOLD/);
  assert.match(voice, /setSamplesReadyCallback/);
  assert.match(voice, /updateMicLevel/);
  assert.match(voice, /AudioRecordErrorCallback/);
  assert.match(voice, /reportMicError/);
  // A second factory/ADM keeps the room WHEP player's audio path independent.
  assert.match(voice, /setAudioDeviceModule\(adm\)/);
  assert.match(voice, /PeerConnectionFactory\.builder\(\)/);
  // Bilingual dictionary entries for the whole panel + errors.
  for (const key of [
    'voice.title', 'voice.hint', 'voice.join', 'voice.joining', 'voice.leave', 'voice.mute',
    'voice.unmute', 'voice.mutedBadge', 'voice.liveBadge', 'voice.participants', 'voice.speaking',
    'voice.empty', 'voice.retry', 'voice.error.micDenied', 'voice.error.micFailed',
    'voice.error.connectFailed', 'voice.error.auth', 'voice.error.notJoined',
    'voice.error.targetLeft', 'voice.error.invalidSignal', 'voice.error.rateLimited', 'voice.error.signal'
  ]) {
    assert.ok(l10nSrc.includes(`"${key}" to (`), `dictionary must define ${key}`);
  }
});

// ---------------------------------------------------------------------------
// v0.8.1: TURN relay credentials for the Android voice room
// ---------------------------------------------------------------------------

test('v0.8.1 Android voice fetches TURN credentials and falls back to STUN with a relay badge', () => {
  const screen = activity();
  const voice = voiceRoom();
  const l10nSrc = l10n();
  // Short-lived coturn REST credentials, authenticated with the user's Bearer token,
  // are fetched right before joining voice.
  assert.match(screen, /private fun prepareVoiceJoin\(\)/);
  assert.match(screen, /apiRequest\("GET", "\/api\/turn-credentials", null, true\)/);
  assert.match(screen, /private fun buildIceServers\(payload: JSONObject\?\): List<PeerConnection\.IceServer>/);
  // urls may be an array or a single string; username/credential are shared.
  assert.match(screen, /is JSONArray ->/);
  assert.match(screen, /obj\.optString\("username", ""\)\.trim\(\)/);
  assert.match(screen, /obj\.optString\("credential", ""\)\.trim\(\)/);
  // One IceServer per TURN/STUN URL, each with setUsername/setPassword.
  assert.match(screen, /PeerConnection\.IceServer\.builder\(url\)/);
  assert.match(screen, /builder\.setUsername\(username\)\.setPassword\(credential\)/);
  assert.match(screen, /startsWith\("turn:"\)/);
  // 503 / network / auth failure falls back to STUN and keeps voice usable.
  assert.match(screen, /private fun voiceStunFallbackIceServers\(\)/);
  assert.match(screen, /stun:stun\.l\.google\.com:19302/);
  assert.match(screen, /VoiceRelayMode\.STUN/);
  assert.match(screen, /voiceRelayCode = if \(result\.code in 200\.\.299\) null else result\.code/);
  // The fetched list is handed to VoiceRoomClient; RTCConfiguration reuses it for
  // every mesh peer (no hard-coded STUN inside the voice client any more).
  assert.match(screen, /VoiceRoomClient\(\s*\n\s*this,\s*\n\s*iceServers,/);
  assert.match(voice, /private val iceServers: List<PeerConnection\.IceServer>,/);
  assert.match(voice, /PeerConnection\.RTCConfiguration\(iceServers\)/);
  assert.doesNotMatch(voice, /stun:stun\.l\.google\.com|stun:stun\.cloudflare\.com/);
  assert.doesNotMatch(voice, /STUN_URL/);
  // The relay state is rendered in the voice card (TURN vs direct/STUN), bilingual.
  assert.match(screen, /private fun voiceRelayText\(\): String\?/);
  assert.match(screen, /tr\("voice\.relay\.checking"\)/);
  assert.match(screen, /tr\("voice\.relay\.turn"\)/);
  assert.match(screen, /tr\("voice\.relay\.stun"\)/);
  assert.match(screen, /tr\("voice\.relay\.fallback"/);
  for (const key of ['voice.relay.checking', 'voice.relay.turn', 'voice.relay.stun', 'voice.relay.fallback']) {
    assert.ok(l10nSrc.includes(`"${key}" to (`), `dictionary must define ${key}`);
  }
});

// ---------------------------------------------------------------------------
// v0.8.2: experimental AudioPlaybackCapture system audio for screen streaming
// ---------------------------------------------------------------------------

test('v0.8.2 screen streaming can inject AudioPlaybackCapture system audio with a microphone fallback', () => {
  const screen = activity();
  const stream = service();
  const l10nSrc = l10n();
  // 1) Broadcast page: persisted, default-off toggle that only appears for screen mode.
  assert.match(screen, /private var systemAudioCaptureEnabled = false/);
  assert.match(screen, /PREF_SYSTEM_AUDIO = "audio_system_capture"/);
  assert.match(screen, /prefs\.getBoolean\(PREF_SYSTEM_AUDIO, false\)/);
  assert.match(screen, /private fun persistSystemAudioSetting\(\)/);
  assert.match(screen, /putBoolean\(PREF_SYSTEM_AUDIO, systemAudioCaptureEnabled\)/);
  assert.match(screen, /tr\("broadcast\.systemAudioOn"\)/);
  assert.match(screen, /tr\("broadcast\.systemAudioOff"\)/);
  assert.match(screen, /tr\("broadcast\.systemAudioBody"\)/);
  // 2) The Service Intent extra is sent only for screen sharing.
  assert.match(screen, /ScreenStreamService\.EXTRA_SYSTEM_AUDIO,\s*\n\s*videoSourceMode == "screen" && systemAudioCaptureEnabled/);
  assert.match(stream, /const val EXTRA_SYSTEM_AUDIO = "system_audio"/);
  assert.match(stream, /getBooleanExtra\(EXTRA_SYSTEM_AUDIO, false\) && !cameraMode/);
  // 3) AudioPlaybackCapture configuration + 48 kHz mono PCM16 AudioRecord.
  assert.match(stream, /AudioPlaybackCaptureConfiguration\.Builder\(projection\)/);
  assert.match(stream, /addMatchingUsage\(AudioAttributes\.USAGE_MEDIA\)/);
  assert.match(stream, /AudioFormat\.ENCODING_PCM_16BIT/);
  assert.match(stream, /private const val SYSTEM_AUDIO_SAMPLE_RATE = 48000/);
  assert.match(stream, /AudioFormat\.CHANNEL_IN_MONO/);
  assert.match(stream, /AudioRecord\.Builder\(\)/);
  assert.match(stream, /setAudioPlaybackCaptureConfig\(configuration\)/);
  // The ADM's expected input format is aligned to the injected record (48 kHz mono).
  assert.match(stream, /admBuilder\.setInputSampleRate\(SYSTEM_AUDIO_SAMPLE_RATE\)/);
  assert.match(stream, /admBuilder\.setUseStereoInput\(false\)/);
  assert.match(stream, /screen\.getMediaProjection\(\)/);
  // 4) Reflection injection into JavaAudioDeviceModule.audioInput.audioRecord.
  assert.match(stream, /getDeclaredField\("audioInput"\)/);
  assert.match(stream, /getDeclaredField\("audioRecord"\)/);
  assert.match(stream, /audioRecordField\.set\(audioInput, record\)/);
  assert.match(stream, /adm\.prewarmRecording\(\)/);
  // 5) Injection happens after ScreenCapturerAndroid.startCapture() (projection ready)
  //    and before the WebRTC audio source / push is created.
  const startAt = stream.indexOf('else capturer?.startCapture(captureWidth, captureHeight, fps)');
  const injectAt = stream.indexOf('if (!useCamera && systemAudioRequested) tryEnableSystemAudioCapture()');
  const audioSourceAt = stream.indexOf('createAudioSource(audioConstraints)');
  assert.ok(startAt > 0 && injectAt > startAt && audioSourceAt > injectAt,
    'system-audio injection must be between startCapture and createAudioSource');
  // 6) Any failure falls back to the microphone and is reported with a status code.
  assert.match(stream, /STATUS_SYSTEM_AUDIO_FALLBACK/);
  assert.match(stream, /tr\("svc\.systemAudioFallback"/);
  assert.match(stream, /private fun releaseInjectedSystemAudioRecord\(\)/);
  assert.match(stream, /record\.state == AudioRecord\.STATE_INITIALIZED/);
  assert.match(stream, /releaseInjectedSystemAudioRecord\(\)\n        systemAudioRequested = false/);
  // 7) Toggle off keeps the original microphone path exactly as before.
  assert.match(stream, /if \(!useCamera && systemAudioRequested\) tryEnableSystemAudioCapture\(\)/);
  assert.match(stream, /val audio = factory!!\.createAudioSource\(audioConstraints\)/);
  assert.match(stream, /audioTrack = factory!!\.createAudioTrack\("conglive-microphone", audio\)/);
  // 8) Bilingual dictionary entries for the toggle and every fallback reason.
  for (const key of [
    'broadcast.systemAudioTitle', 'broadcast.systemAudioOn', 'broadcast.systemAudioOff',
    'broadcast.systemAudioBody', 'broadcast.systemAudioEnabledHint', 'broadcast.systemAudioDisabledHint',
    'broadcast.audioSource', 'broadcast.audioSourceSystem', 'broadcast.audioSourceMic',
    'svc.systemAudioEnabled', 'svc.systemAudioFallback', 'svc.systemAudioNoProjection',
    'svc.systemAudioNoAdm', 'svc.systemAudioBuffer', 'svc.systemAudioNotInitialized',
    'svc.systemAudioPrewarm', 'svc.systemAudioReflection'
  ]) {
    assert.ok(l10nSrc.includes(`"${key}" to (`), `dictionary must define ${key}`);
  }
});
