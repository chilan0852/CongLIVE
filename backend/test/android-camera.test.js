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

test('Android package version is bumped to 0.7.6 (versionCode 18)', () => {
  const gradle = read('android/app/build.gradle.kts');
  assert.match(gradle, /versionCode = 18/);
  assert.match(gradle, /versionName = "0\.7\.6"/);
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
  // Bottom navigation gets a dedicated 看板娘 tab.
  assert.ok(screen.includes('看板娘'), 'navigation must expose a 看板娘 entry');
  assert.match(screen, /private fun renderLive2D\(\)/);
  assert.match(screen, /actionButton\("加载模型", true\)/);
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
