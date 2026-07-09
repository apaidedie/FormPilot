# Security Policy

FormPilot is a local-first Chrome Manifest V3 extension. Security reports are welcome, especially around permission scope, content-script injection, storage behavior, and form-fill boundaries.

## Supported Versions

Security fixes target the latest version in `manifest.json`.

## Reporting A Vulnerability

Open a private security advisory on GitHub when available. If advisories are unavailable, contact the maintainer through the repository owner profile and keep exploit details out of public issues until a fix is available.

Do not include real full card numbers, CVV, SSN, API keys, passwords, private addresses, or live account data in reports. Use a minimal local fixture or redacted sample instead.

## Project Safety Boundary

FormPilot must not store or auto-fill full card numbers, CVV, SSN, or generated sensitive third-party fields. Generated-profile cache, archives, and recent fill history must stay public-only; generated sensitive display fields are active-session manual-copy only. My Profile may store contact and address data plus payment summary metadata only: issuer, network, last four, expiry, and billing note.

The extension must not register a permanent `<all_urls>` content script. Page scripts are injected on demand after user action, and custom AI-compatible endpoints use runtime optional host permissions.

## Verification

Run the release gate before publishing or reviewing sensitive changes:

```powershell
node scripts/verify-release.cjs
```

Run the browser fixture when selector or fill behavior changes:

```powershell
node scripts/verify-fixture-browser.cjs
```

For interactive debugging, you can still serve the repository manually:

```powershell
python -m http.server 8876 --bind 127.0.0.1
```

Then open `http://127.0.0.1:8876/tests/manual/form-fixture.html` and confirm the embedded check passes.
