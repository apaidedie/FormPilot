# FormPilot

![Manifest V3](https://img.shields.io/badge/Chrome-MV3-34d399)
![No build step](https://img.shields.io/badge/no--build-plain%20HTML%2FCSS%2FJS-7dd3fc)
![Release gate](https://img.shields.io/badge/release%20gate-local%20%2B%20CI-fbbf24)
![License](https://img.shields.io/badge/license-MIT-111827)

FormPilot is a Chrome Manifest V3 workspace for generating realistic test profiles, saving reusable contact profiles, and filling forms only after an explicit user action.

It is built for developers, QA teams, and product builders who repeatedly test registration, checkout, onboarding, profile, shipping, and billing flows. The project stays intentionally inspectable: plain HTML/CSS/JS, no build step, no framework lock-in, and no permanent all-site content script.

![FormPilot hero](../assets/marketing/formpilot-hero.png)

## Quick Start

Install locally from source:

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select this repository root.

Check the project before you change it:

```powershell
node scripts/verify-release.cjs
```

Package a runtime-only zip when preparing a release:

```powershell
node scripts/package-extension.cjs
node scripts/verify-package.cjs
```

## At a Glance

| Signal | Current state |
| --- | --- |
| Runtime | Chrome Manifest V3 extension with plain HTML, CSS, and JavaScript. |
| Install | Load unpacked from the repository root; no build step or package manager. |
| Data coverage | Generated profiles for 19 countries and regions, plus US state/city generation through `meiguodizhi.com`. |
| Fill model | User-triggered active-tab fill with on-demand script injection. |
| Safety boundary | No full card number, CVV, SSN, generated sensitive field, permanent `<all_urls>`, or permanent `content_scripts` path. |
| Verification | Release gate, fixture contract, popup keyboard QA, unpacked-extension smoke test, runtime-only package builder, and zip boundary inspection. |

## Why FormPilot

Form testing usually breaks down into the same chores: invent a plausible person, choose a local address, keep one real contact profile handy, copy a verification code, fill the page, then verify sensitive payment or identity decoys were not touched. FormPilot keeps that workflow in one popup.

FormPilot focuses on four product promises:

- Fast test profile generation for 19 countries and regions, with local-looking names, phones, addresses, city/state data, and postal codes.
- Controlled form filling through active-tab, on-demand script injection instead of a permanent `<all_urls>` content script.
- A clear safety boundary: My Profile stores contact/address data and payment summary metadata only; full card numbers, CVV, SSN, and generated sensitive display fields are not part of normal auto-fill payloads.
- Optional AI field mapping follows the same boundary and does not auto-fill identity, financial, employment, or payment credentials.

## Product Tour

| Main workspace | Settings | My Profile | Fixture check |
| --- | --- | --- | --- |
| ![FormPilot popup](../output/playwright/popup-main.png) | ![FormPilot settings](../output/playwright/popup-settings.png) | ![My Profile modal](../output/playwright/popup-profile.png) | ![Manual form fixture](../output/playwright/form-fixture-mobile.png) |

## Workflow Demo

![FormPilot workflow demo](../assets/marketing/formpilot-workflow-demo.png)

Prepare. Scan. Review. Fill intentionally. The workflow demo shows the same safe path reviewers see in the popup: prepare a public profile, scan visible fields on the active page, review the fill plan, then trigger filling only through an explicit action while sensitive fields stay skipped or manual.

## Core Features

- Generate profiles from detected IP country or a selected country.
- Review supported generated countries inside the popup before choosing a country.
- Generate US profiles by state or city through `meiguodizhi.com`.
- Fill registration, account, contact, shipping, billing, and profile forms.
- Scan the active tab before filling to preview visible form fields, likely standard-field matches, required-field coverage, sensitive required fields that will be skipped, page type, CAPTCHA presence, and a compact scan-based fill plan without writing or storing page data.
- Follow the compact workflow guidance in the popup: prepare data, scan the page, review the plan, then fill by explicit action.
- See a shortcut confidence hint that displays the active fill shortcut and reminds users it follows the same public-profile and empty-fields-only boundary as Fill.
- Review a fill-readiness surface that combines generated profile completeness, page match preview, fill mode, AI readiness, address mode, and My Profile completeness before running Fill.
- See the last-fill result stay in the main workspace after a fill action, with matched, skipped, missed, and skip-reason counts.
- Preserve existing page values with an optional empty-fields-only fill mode.
- Save My Profile with real name, email, phone, shipping address, billing address, and payment summary metadata.
- Auto-save My Profile edits locally with a visible save status.
- See My Profile completeness at a glance and jump straight to the first missing local field.
- See generated-profile completeness, missing fields, lock count, and source in the main workspace.
- See identity, account, and contact section completeness while scanning or collapsing generated-profile sections.
- Keep generated-profile sections collapsed or expanded across popup reopen and refresh.
- Sync billing address from shipping address inside My Profile.
- Clear My Profile through a second-click confirmation to avoid accidental deletion.
- Import/export non-sensitive My Profile data as a local JSON file.
- Show or hide the OpenAI-compatible API key while configuring AI settings.
- Keep AI mode unavailable until AI is enabled and an API key is saved, then clear that command toggle again when AI settings are disabled.
- Review settings readiness for password rules, AI, address enrichment, and archives at a glance.
- Use Mail.tm temporary inboxes and copy verification codes from the popup, with inline service recovery states when registration or refresh fails.
- Lock individual generated fields before regenerating.
- Copy individual fields, identity/account/contact blocks, postal mailing-address lines, or the full profile, search saved archives, and search or restore recent fill history.
- Clear recent fill history through the same second-click confirmation pattern used for local profile data.
- Keep Copy All, Regenerate, and Fill reachable through a sticky command dock while reviewing long generated profiles.
- Optionally enrich addresses through OpenStreetMap Nominatim or Geoapify, with the map lookup toggle remembered locally and an inline service recovery state when map lookup falls back to local data.
- Optionally use an OpenAI-compatible API to scan page context and map unusual form fields.

## Supported Generated Countries

FormPilot currently supports generated profile data for United States, United Kingdom, Canada, Australia, China, Japan, South Korea, Germany, France, Russia, Spain, Italy, Brazil, India, Singapore, Taiwan, Hong Kong, Mexico, and Netherlands.

Each listed country has local names, phone format, city or state data, street data, and postal-code generation. Location search through `meiguodizhi.com` is currently limited to US states and cities.

The popup country picker includes an expandable coverage panel that mirrors this list and marks the active generated country.

## Permission Model

FormPilot uses fixed host access for known services: IP lookup, Mail.tm, `meiguodizhi.com`, Geoapify, OpenStreetMap Nominatim, and the default OpenAI API endpoint.

The extension does not register a permanent `<all_urls>` content script. It injects page scripts only when you click Fill, use My Profile fill, or trigger the keyboard shortcut. Custom OpenAI-compatible endpoints are requested as optional host permissions at runtime.

## Safety Boundary

FormPilot can display externally generated sensitive test-like data from third-party profile services, but those fields are manual-copy only and are not part of the standard auto-fill payload or the Copy All action.

Generated sensitive display fields are also excluded from the generated-profile cache, archives, and recent fill history. Cached profiles, archives, and history records keep public profile fields only.

My Profile stores contact and address data plus payment summary metadata only. Payment summary metadata is limited to issuer, network, last four, expiry, and billing note. It does not store full card numbers, CVV, or SSN.

My Profile import/export uses the same whitelist. Imported local JSON files are sanitized before storage; unknown fields and forbidden sensitive fields are dropped instead of being filled into pages.

Keyboard shortcut auto-fill and the main Fill action use public profile fields only. Empty-fields-only mode is stored locally and tells the content script to skip visible fields that already contain a value. Optional AI field mapping only becomes active when AI is enabled and an API key is saved, and it removes full card numbers, CVV/CVC, SSN, tax IDs, national IDs, passport numbers, driver's license numbers, bank account numbers, income, salary, employer, company name, and employment status before sending a smart-fill payload to the page.

Generated-profile section collapse preferences, section completion badges, workflow guidance state, shortcut confidence state, active-page match preview, scan-based fill plan preview, sensitive skip preview, external service recovery states, the fill-readiness surface, and the last-fill result surface are UI-only state. They do not enter profile generation, My Profile, import/export, Copy All, page scan storage, keyboard shortcut payloads, or any fill payload.

## Architecture

FormPilot is deliberately small enough to inspect. The popup owns generation, settings, history, archives, Mail.tm, My Profile, optional AI mapping, active-page scan summaries, shortcut confidence hint, the scan-based fill plan preview, the fill-readiness surface, the last-fill result surface, and the fill command. The content script is injected on demand and receives only the payload for the requested fill action.

Read the deeper architecture and data-boundary notes in [docs/architecture.md](architecture.md).

## Release Notes

Current release notes live in [CHANGELOG.md](../CHANGELOG.md). Maintainer release checks are tracked in [docs/release-audit.md](release-audit.md).

## Roadmap

The roadmap prioritizes selector reliability, country data depth, no-build maintainability, and polished extension UX. See [docs/roadmap.md](roadmap.md) for near-term work, later ideas, and explicit non-goals.

## Project Structure

| Path | Purpose |
| --- | --- |
| `manifest.json` | MV3 metadata, permissions, popup, background worker, commands, and optional host permissions. |
| `CHANGELOG.md` | Release notes for versioned user-facing changes and release verification evidence. |
| `background.js` | Context menu, keyboard shortcut, startup cleanup, and on-demand content script injection. |
| `popup/` | Popup UI and feature modules. |
| `scripts/content.js` | Page-side form scanning and filling after on-demand injection. |
| `scripts/generators.js` | Country data, profile generation, location services, and external address adapters. |
| `scripts/selectors/` | Field selector maps for common and Japan-specific forms. |
| `tests/manual/form-fixture.html` | Local fixture for selector coverage, My Profile payment summary metadata, and sensitive decoy protection. |
| `scripts/verify-release.cjs` | Release gate for syntax, manifest, permissions, safety boundaries, country support, docs, and package rules. |
| `scripts/lib/browser-harness.cjs` | Shared Chrome or Edge launcher, CDP client, and temporary-profile cleanup for browser verifiers. |
| `scripts/verify-fixture-browser.cjs` | Local Chrome form-fill QA for the fixture embedded checks and mobile fixture screenshot refresh. |
| `scripts/verify-popup-keyboard.cjs` | Local Chrome keyboard QA for popup modals, focus trapping, Escape close, and screenshot refresh. |
| `scripts/verify-extension-runtime.cjs` | Local Chrome smoke test that loads the repository as an unpacked extension and confirms the MV3 service worker starts. |
| `scripts/render-hero.cjs` | Local Chrome renderer for README, workflow demo, and store marketing assets, built from current visual QA screenshots. |
| `scripts/package-extension.cjs` | Chrome extension zip builder under `dist/`. |
| `scripts/verify-package.cjs` | Runtime zip boundary verifier for required entries, forbidden docs/test assets, and supported compression methods. |
| `docs/store-listing.md` | Chrome Web Store listing draft, permission justifications, and screenshot suggestions. |
| `docs/roadmap.md` | Current priorities, later work, and non-goals for contributors. |
| `docs/release-audit.md` | Maintainer checklist for release readiness, package boundary, and manual browser checks. |

## Development Checks

Run the release verification before packaging:

```powershell
node scripts/verify-release.cjs
```

The script checks JavaScript syntax, parses `manifest.json`, verifies the MV3 permission boundary, confirms My Profile does not auto-fill or import/export full card numbers, CVV, SSN, or generated sensitive fields, validates country-picker generator coverage, runs the fixture contract check, checks popup modal accessibility contracts, and checks local documentation assets.

Run the fixture contract check directly when changing selectors, content fill behavior, My Profile payloads, or the manual fixture:

```powershell
node scripts/verify-fixture.cjs
```

The fixture contract check keeps the deterministic fixture fields, selector maps, payment summary metadata, and sensitive decoys aligned without adding a browser dependency to the no-build project.

Run the browser fixture QA after selector, content-script fill, smart-fill, or empty-fields-only changes when Chrome or Edge is available:

```powershell
node scripts/verify-fixture-browser.cjs
```

The browser fixture check serves the repository on localhost, opens `tests/manual/form-fixture.html` in a temporary Chromium profile, runs the embedded fill, smart-fill safety, and empty-fields-only checks, confirms mobile layout has no horizontal overflow, then refreshes `output/playwright/form-fixture-mobile.png`.

Run the popup keyboard QA after modal, focus, or popup layout changes:

```powershell
node scripts/verify-popup-keyboard.cjs
```

The popup keyboard check loads FormPilot as an unpacked extension in Chrome or Edge, opens the real extension popup page, verifies the sticky command dock, workflow guidance, AI command-mode readiness, fill-readiness feedback, scan-based fill plan preview, external service recovery states, generated-profile overview feedback, My Profile completeness feedback and missing-field focus, My Profile and History clear confirmations, the Settings overview and API key show/hide control, modal Tab wrapping, Shift+Tab wrapping, Escape close, focus return, and refreshes `output/playwright/popup-main.png`, `output/playwright/popup-settings.png`, and `output/playwright/popup-profile.png`. Browser launch, CDP connection, and safe temporary-profile cleanup are shared with the runtime smoke test through `scripts/lib/browser-harness.cjs`.

Refresh the README, workflow demo, and store marketing assets after screenshot or product-positioning changes:

```powershell
node scripts/render-hero.cjs
```

The marketing renderer opens `assets/marketing/formpilot-hero.html`, `assets/marketing/formpilot-workflow-demo.html`, and `assets/marketing/formpilot-store-promo.html` in Chrome or Edge, waits for the current main, Settings, My Profile, and fixture screenshots to load, verifies fixed export dimensions with no overflow, then writes `assets/marketing/formpilot-hero.png`, `assets/marketing/formpilot-workflow-demo.png`, and `assets/marketing/formpilot-store-promo.png`.

Run the optional unpacked-extension smoke test before a release when Chrome or Edge is available locally:

```powershell
node scripts/verify-extension-runtime.cjs
```

Set `CHROME_PATH` if Chrome or Edge is installed outside the standard location. If stable Google Chrome rejects unpacked-extension flags in your environment, point `CHROME_PATH` to Microsoft Edge, Chromium, or Chrome for Testing. This check uses the shared browser harness to create a temporary browser profile, load the repository root as an unpacked MV3 extension, confirm the `background.js` service worker target appears through CDP, then remove the temporary profile.

Create a Chrome Web Store ready zip:

```powershell
node scripts/package-extension.cjs
node scripts/verify-package.cjs
```

The package script writes `dist/formpilot-1.8.0.zip` for the current manifest version. The package verifier checks that the zip includes only runtime extension files and excludes local workflow metadata, screenshots, fixtures, marketing sources, docs, and local tooling state.

For visual QA, serve the folder locally and inspect `popup/popup.html` at a 460px-wide viewport. The latest local checks captured `output/playwright/popup-main.png`, `output/playwright/popup-settings.png`, and `output/playwright/popup-profile.png`.

For form-fill QA, run `node scripts/verify-fixture-browser.cjs`. The fixture loads the current selector maps and content script, fills a deterministic profile, verifies that full card number, CVV, and SSN decoys stay empty, and includes embedded checks for AI mapping safety and empty-fields-only behavior. Serve the folder manually only when investigating a selector issue interactively.

GitHub Actions runs the static release gate, fixture contract check, package build, and zip boundary inspection through `.github/workflows/release-check.yml` on Ubuntu so case-sensitive paths are exercised. The same workflow then runs browser fixture QA, popup keyboard QA, and the marketing asset renderer on Windows with a real Chromium browser, then uploads the packaged extension zip as an artifact.

## Release Checklist

- Confirm the extension loads unpacked without manifest errors.
- Run `node scripts/verify-release.cjs`.
- Run `node scripts/verify-fixture.cjs` after selector, fixture, My Profile, or fill behavior changes.
- Run `node scripts/verify-fixture-browser.cjs` after selector, content-script fill, smart-fill, or empty-fields-only behavior changes.
- Run `node scripts/verify-popup-keyboard.cjs` after modal, focus, or popup layout changes.
- Run `node scripts/render-hero.cjs` after screenshot, README hero, workflow demo, or store promo changes.
- Run `node scripts/verify-extension-runtime.cjs` on a local Chrome or Edge install before publishing.
- Run the manual form fixture and confirm it reports Pass.
- Run the fixture empty-fields-only check after fill overwrite behavior changes.
- Refresh screenshots under `output/playwright/` and marketing assets under `assets/marketing/` after visual changes.
- Run `node scripts/package-extension.cjs` and inspect the zip contents before upload.
- Run `node scripts/verify-package.cjs` after packaging.
- Review `CHANGELOG.md` and `docs/release-audit.md` before tagging a release.
- Review `PRIVACY.md` when permissions, storage, AI, or external services change.

## Contributing

Keep changes small and verify the boundary between generated display data and auto-fill payloads. Selector improvements are welcome when they are backed by a local fixture, a real-world form pattern, or a focused regression case.

Use the issue templates for focused reports and include the checks you ran. Pull requests should keep the no-build architecture, narrow permission model, and sensitive-field boundary intact.

## Security

Please report sensitive security issues privately when possible. See `SECURITY.md` for supported version, reporting guidance, and the project safety boundary.

## License

MIT. See `LICENSE`.
