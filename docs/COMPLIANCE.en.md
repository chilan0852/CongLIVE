# Compliance review (engineering view)

Date: 2026-11-04. **This is not legal advice.** Consult a qualified lawyer/compliance adviser before public operation.

## Checked

- Project-owned code: MIT; no third-party models, Cubism Core, secrets, certificates, APKs or recordings are committed.
- Promo video: no Live2D model, QR code or domain; no third-party music; sound effects synthesized by `make_audio.py`; screenshots show only this project's UI.
- Server: the public `/m/` static route for private models has been removed from Compose/Nginx and returns 404. Model files remain on the server disk but are no longer served over the web. For testing, use an access-controlled private URL or load models locally.
- Third-party dependencies: see `THIRD_PARTY_NOTICES.md`; Cubism Core is loaded at runtime from the official CDN only.

## Operator responsibilities

1. Public live/VOD: ICP and public-security filings, real-name verification, minors protection, content moderation, and any required culture/audiovisual licenses.
2. Camera, screen and microphone: participant consent, privacy notice, recording retention and deletion.
3. Copyright and terms: music, film, games, fonts, covers, chat, Live2D models and terms of service.
4. Security: admin passwords, HTTPS, admin access control, backups and logs.
5. Infringement reporting and takedown channels.

## Residual risks

- Public SRS/API/admin endpoints may be scanned; no WAF, rate limiting or risk control is included.
- Private model files remain on the deployment disk; encrypt them or move them outside the deployment directory.
- Content moderation, real-name verification, minors protection, copyright and recording consent must be added by the operator.
- Verify third-party license versions with an SBOM before release.

## Conclusion

The code is open source under MIT. The **deployer/operator** is solely responsible for live content, capture behavior, third-party assets and local licensing. The project provides no compliance guarantee.

---
[中文版本](COMPLIANCE.md)
