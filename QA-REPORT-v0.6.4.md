# CongLive v0.6.4 QA Report

Date: 2026-11-03

## Scope
- Hide offline rooms from the public live lobby.
- Correct recording playback URL origin selection to avoid Android API-port/Web-port mismatch.
- Add automated regression tests for live-only filtering, origin selection, and stream-key recording ownership matching.

## Results

| Check | Result |
|---|---|
| `npm test` in backend | PASS — 6/6 tests |
| Backend JavaScript syntax | PASS |
| New recording utility syntax | PASS |
| Web TSX transpilation syntax | PASS |
| Shell scripts (`bash -n`) | PASS |
| Compose YAML parse | PASS |
| Android XML parse | PASS |
| Kotlin parser scan | No syntax parser diagnostics observed; full compile unavailable |
| Android APK build | NOT RUN — Android SDK/Gradle dependencies unavailable |
| Docker image build | NOT RUN — Docker CLI/daemon unavailable |
| MySQL/SRS integration | NOT RUN — no running service stack in this environment |
| Physical-device playback | NOT RUN — requires user's VPS and Android device |

## Changes
- `GET /api/streams` now filters `s.is_live=TRUE`, in addition to deleted, blocked, and banned-owner conditions.
- Android and Web clients also filter the public room list to live rooms only.
- Recording list endpoints now build signed playback URLs from the validated request host/protocol when it matches `PUBLIC_HOST`. This keeps Android API requests and playback requests on the same public origin/port; configuration-derived fallback remains available.
- Recording-list responses use `Cache-Control: no-store` to avoid stale signed URLs.
- Recording ownership matching is moved to a tested helper.
- Android version updated to 0.6.4 / versionCode 10; backend package version updated to 0.6.4.

## Deployment
1. Back up `server/.env`, the MySQL named volume, and `server/recordings/`.
2. Overlay the hotfix or deploy the full project while preserving those data locations.
3. Run `cd server && docker compose up -d --build backend web`.
4. Rebuild/install the Android app from `android/` if using the updated client.
5. Confirm the lobby only shows a currently publishing stream. After stopping a stream, refresh and confirm its card disappears.
6. After a session recording is finalized, open the recording and confirm the URL uses the same origin/port as the API list request and returns HTTP 200/206.

## Limitations
This is source-level and local automated verification, not production acceptance. In particular, real DVR path mounting, file permissions, tokenized byte-range playback, and user-specific recordings must still be confirmed on the target VPS.
