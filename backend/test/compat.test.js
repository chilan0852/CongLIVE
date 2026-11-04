import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mysqlBoolean } from '../src/mysql-utils.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('mysqlBoolean normalizes mysql2 BOOLEAN numeric values', () => {
  assert.equal(mysqlBoolean(1), true);
  assert.equal(mysqlBoolean(0), false);
  assert.equal(mysqlBoolean(true), true);
  assert.equal(mysqlBoolean(false), false);
  assert.equal(mysqlBoolean('1'), true);
  assert.equal(mysqlBoolean('0'), false);
  assert.equal(mysqlBoolean('TRUE'), true);
  assert.equal(mysqlBoolean('false'), false);
  assert.equal(mysqlBoolean(null), false);
  assert.equal(mysqlBoolean(undefined), false);
  assert.equal(mysqlBoolean(2), false);
});

test('SRS is configured for WebRTC WHIP/WHEP and RTC-to-RTMP MP4 DVR', async () => {
  const conf = await read('../../server/srs.conf');
  assert.match(conf, /rtc_server\s*\{[\s\S]*?enabled\s+on;/);
  assert.match(conf, /candidate\s+\$CANDIDATE;/);
  assert.match(conf, /protocol\s+tcp;/);
  assert.match(conf, /use_auto_detect_network_ip\s+off;/);
  assert.match(conf, /api_as_candidates\s+off;/);
  assert.match(conf, /tcp\s*\{[\s\S]*?enabled\s+on;/);
  assert.match(conf, /rtc_to_rtmp\s+on;/);
  assert.match(conf, /dvr_path[\s\S]*?\.mp4;/);
  assert.match(conf, /on_publish\s+http:\/\/backend:3000\/api\/srs\/on_publish/);
  assert.match(conf, /on_unpublish\s+http:\/\/backend:3000\/api\/srs\/on_unpublish/);
  assert.match(conf, /on_play\s+http:\/\/backend:3000\/api\/srs\/on_play/);
});

test('Docker exposes WebRTC media only and keeps SRS management API private', async () => {
  const compose = await read('../../server/docker-compose.yml');
  assert.match(compose, /image: ossrs\/srs:v6\.0\.195/);
  assert.match(compose, /8000:8000\/udp/);
  assert.match(compose, /8000:8000\/tcp/);
  assert.match(compose, /127\.0\.0\.1:1985:1985/);
  assert.doesNotMatch(compose, /1935:1935/);
  assert.match(compose, /SRS_HOOK_SECRET: \$\{SRS_HOOK_SECRET/);
  assert.match(compose, /\.\/srs\.runtime\.conf:\/usr\/local\/srs\/conf\/conglive\.conf:ro/);
});

test('Android uses native WebRTC, WHIP and H264; it no longer depends on RootEncoder or HLS playback', async () => {
  const gradle = await read('../../android/app/build.gradle.kts');
  const service = await read('../../android/app/src/main/java/com/conglive/app/ScreenStreamService.kt');
  const activity = await read('../../android/app/src/main/java/com/conglive/app/MainActivity.kt');
  assert.match(gradle, /io\.github\.webrtc-sdk:android:/);
  assert.doesNotMatch(gradle, /RootEncoder|media3-exoplayer-hls/);
  assert.match(service, /ScreenCapturerAndroid/);
  assert.match(service, /H264/);
  assert.match(service, /application\/sdp/);
  assert.match(activity, /whepPath/);
  assert.doesNotMatch(activity, /flvUrl|切换 HLS|RTMP publish/);
});

test('Web user client plays live video with WHEP and no HLS/FLV dependency', async () => {
  const source = await read('../../web/src/main.tsx');
  const pkg = JSON.parse(await read('../../web/package.json'));
  assert.match(source, /RTCPeerConnection/);
  assert.match(source, /\/whep/);
  assert.doesNotMatch(source, /hls\.js|flv\.js|playUrl|flvUrl/);
  assert.equal(pkg.dependencies['hls.js'], undefined);
  assert.equal(pkg.dependencies['flv.js'], undefined);
});

test('Android and Web public stream list clients use only live WHEP streams', async () => {
  const api = await read('../src/index.js');
  const activity = await read('../../android/app/src/main/java/com/conglive/app/MainActivity.kt');
  const web = await read('../../web/src/main.tsx');
  assert.match(api, /s\.is_live=TRUE/);
  assert.match(activity, /whepPath = item\.optString\("whepPath"/);
  assert.match(web, /s\.is_live === true && !!s\.whepPath/);
});

test('Recording URL uses the same public origin as the API request', async () => {
  const { recordingApiBaseForRequest } = await import('../src/recordings-utils.js');
  assert.equal(recordingApiBaseForRequest({ headers: { host: '203.0.113.8:3000' }, protocol: 'http' }, {
    publicHost: '203.0.113.8', fallbackBase: 'http://203.0.113.8:8081/api/recordings',
  }), 'http://203.0.113.8:3000/api/recordings');
  assert.equal(recordingApiBaseForRequest({ headers: { host: '203.0.113.8:8081' }, protocol: 'http' }, {
    publicHost: '203.0.113.8', fallbackBase: 'http://203.0.113.8:8081/api/recordings',
  }), 'http://203.0.113.8:8081/api/recordings');
  assert.equal(recordingApiBaseForRequest({ headers: { host: 'live.example.com', 'x-forwarded-proto': 'https' }, protocol: 'http' }, {
    publicHost: 'live.example.com', fallbackBase: 'https://live.example.com/api/recordings',
  }), 'https://live.example.com/api/recordings');
});

test('recording ownership matches only the exact stream key prefix', async () => {
  const { recordingBelongsToStreams } = await import('../src/recordings-utils.js');
  assert.equal(recordingBelongsToStreams('live/abc123.20261103.mp4', ['abc123']), true);
  assert.equal(recordingBelongsToStreams('live/abc123.mp4', ['abc123']), true);
  assert.equal(recordingBelongsToStreams('live/notabc123.20261103.mp4', ['abc123']), false);
  assert.equal(recordingBelongsToStreams('live/abc1234.mp4', ['abc123']), false);
});

test('Android WebRTC uses the correct ADM package and consumes the MediaProjection grant only once', async () => {
  const gradle = await read('../../android/app/build.gradle.kts');
  const manifest = await read('../../android/app/src/main/AndroidManifest.xml');
  const service = await read('../../android/app/src/main/java/com/conglive/app/ScreenStreamService.kt');
  const playback = await read('../../android/app/src/main/java/com/conglive/app/WebRtcPlaybackClient.kt');
  assert.match(gradle, /io\.github\.webrtc-sdk:android:150\.7871\.04/);
  assert.match(service, /import org\.webrtc\.audio\.JavaAudioDeviceModule/);
  assert.match(playback, /import org\.webrtc\.audio\.JavaAudioDeviceModule/);
  assert.doesNotMatch(service, /manager\.getMediaProjection\(/);
  assert.match(service, /ScreenCapturerAndroid\(projectionData/);
  assert.match(manifest, /android\.permission\.MODIFY_AUDIO_SETTINGS/);
});

test('Native WHEP playback gathers ICE candidates before sending its SDP offer', async () => {
  const playback = await read('../../android/app/src/main/java/com/conglive/app/WebRtcPlaybackClient.kt');
  assert.match(playback, /iceGatheringComplete\s*=\s*CountDownLatch\(1\)/);
  assert.match(playback, /awaitOrTimeout\(iceGatheringComplete, 15_000\)/);
});

test('WebRTC deployment refuses an unknown SRS public candidate and documents TURN/audio limitations', async () => {
  const install = await read('../../server/install.sh');
  const readme = await read('../../README.md');
  const guide = await read('../../WEBRTC-迁移说明-v0.7.0.md');
  assert.match(install, /无法确定 SRS 公网候选 IP/);
  assert.match(readme, /UDP 8000、TCP 8000/);
  assert.match(readme, /AudioPlaybackCapture.*尚未接入/);
  assert.match(guide, /TURN/);
});

test('Installer resolves SRS candidate and hook secret into a runtime config', async () => {
  const install = await read('../../server/install.sh');
  assert.match(install, /CANDIDATE="\$\{CANDIDATE:-\$\(get_env CANDIDATE\)\}"/);
  assert.match(install, /srs\.runtime\.conf/);
  assert.match(install, /s\|\\\$CANDIDATE\|/);
  assert.match(install, /s\|\\\$SRS_HOOK_SECRET\|/);
});
