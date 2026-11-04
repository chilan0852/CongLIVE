# CongLive v0.6.4 — Lobby & Recording Fix

## Fixes
- Public `/api/streams` now returns only streams that the SRS publish hook has marked live; blocked, deleted, banned-owner, and offline rooms are excluded.
- Android and Web clients apply a second live-only filter for compatibility with older API deployments.
- Recording playback URLs are now generated from the same validated public origin that served the recording-list request. This prevents direct-API Android clients (`:3000`) from receiving a playback URL that unexpectedly points at the Web port (`:8081`).
- Recording listing responses are marked `Cache-Control: no-store` so clients do not retain stale signed playback URLs.
- Recording ownership matching is centralized and checks the exact stream-key filename prefix.

## Upgrade
1. Back up `server/.env`, the MySQL volume, and `server/recordings/`.
2. Replace the project with this release, preserving those data locations.
3. Run `cd server && docker compose up -d --build backend web`.
4. Rebuild and install the Android APK from `android/` (version 0.6.4).

This source release has automated Node.js tests and static checks. It has not been validated against the user's live VPS or physical Android device.
