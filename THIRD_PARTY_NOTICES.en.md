# Third-Party Notices

Project-owned code is [MIT](LICENSE). The following components/services are provided by third parties under their own licenses; this is an engineering list, not legal advice. Always verify the upstream LICENSE for the exact version you deploy.

| Component | Purpose | License / notes |
|---|---|---|
| SRS 6 (`ossrs/srs`) | WebRTC SFU / DVR | MIT (see upstream LICENSE) |
| MySQL 8.4 | Database | GPL-2.0 with FOSS Exception (per Oracle) |
| Node.js 22 / Alpine | Runtime/images | MIT and component licenses in the image |
| Express 4 | HTTP API | MIT |
| ws / jsonwebtoken / mysql2 / bcryptjs / cors / dotenv | Backend dependencies | MIT (bcryptjs MIT) |
| React 18 / React DOM | Web UI | MIT |
| Vite 6 | Web build | MIT |
| TypeScript 5 | Type checking/build | Apache-2.0 |
| pixi.js 6 | WebGL rendering | MIT |
| pixi-live2d-display 0.4 | Live2D loader | MIT |
| Live2D Cubism Core | Live2D runtime | **Proprietary**; loaded at runtime from the official CDN, not bundled; use subject to Live2D terms |
| AndroidX / Media3 / OkHttp | Android dependencies | Apache-2.0 |
| WebRTC Android SDK (`io.github.webrtc-sdk:android`) | Android WebRTC | BSD-3-Clause |
| Caddy 2 / Nginx | HTTPS / static serving | Apache-2.0 / BSD-2-Clause |
| Noto Sans CJK | Promo font (system font, not distributed) | SIL Open Font License 1.1 |
| FFmpeg | Promo build tool, not distributed | LGPL/GPL depending on build |

## Models and assets

- The repository does **not** contain any Live2D model (`.moc3`, `.model3.json`, textures, motions, expressions) or Cubism Core.
- Model authors' terms may prohibit redistribution; deployers must obtain permission and must not host restricted models in publicly downloadable locations.
- Screenshots/promo do not show third-party model artwork; promo sound effects are synthesized by the project's `make_audio.py`.

## Trademarks

"CongLive" is the name of this project. Other names, trademarks and brands belong to their respective owners; this project claims no affiliation or endorsement.

---
[中文版本](THIRD_PARTY_NOTICES.md)
