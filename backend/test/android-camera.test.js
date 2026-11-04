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

test('broadcast page offers 720p/540p/360p and 30/24/15 fps settings persisted in SharedPreferences', () => {
  const screen = activity();
  const settings = videoSettings();
  assert.match(settings, /Resolution\("720p", "720p", 1280, 720, 2_000_000\)/);
  assert.match(settings, /Resolution\("540p", "540p", 960, 540, 1_200_000\)/);
  assert.match(settings, /Resolution\("360p", "360p", 640, 360, 800_000\)/);
  assert.match(settings, /val FPS_OPTIONS: List<Int> = listOf\(30, 24, 15\)/);
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
  assert.match(screen, /putExtra\(ScreenStreamService\.EXTRA_VIDEO_BITRATE, videoResolution\.bitrateBps\)/);
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

test('Android package version is bumped to 0.7.7 (versionCode 19)', () => {
  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /versionCode = 19/);
  assert.match(gradle, /versionName = "0\.7\.7"/);
  // The in-app header shows the same version.
  assert.match(activity(), /text = "v0\.7\.7"/);
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
  const sources = [activity(), service(), playbackClient(), live2dViewer(), previewBridge()];
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
