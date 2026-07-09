# Release Audit

This file is the release-readiness checklist for FormPilot maintainers. Keep it current when the manifest, permissions, storage boundary, screenshots, release tooling, or Chrome Web Store copy changes.

## Current Candidate

- Version: `1.8.0`
- Package: `dist/formpilot-1.8.0.zip`
- Runtime package contents: `manifest.json`, `background.js`, `icons/`, `popup/`, `scripts/content.js`, `scripts/generators.js`, `scripts/japan-generators.js`, and `scripts/selectors/`.
- Non-runtime files must stay out of the package: local workflow metadata directories, `.github/`, `docs/`, `tests/`, `output/`, `assets/marketing/`, `README.md`, release tooling scripts, local logs, and dependency folders.
- The release gate checks required file paths with exact casing so Windows-local verification catches paths that would fail on Linux CI.
- Browser verifiers share `scripts/lib/browser-harness.cjs` for Chrome or Edge discovery, CDP calls, unpacked-extension diagnostics, and safe temporary-profile cleanup.
- The README hero, workflow demo, and store promo are reproducible marketing assets rendered from `assets/marketing/formpilot-hero.html`, `assets/marketing/formpilot-workflow-demo.html`, `assets/marketing/formpilot-store-promo.html`, and current screenshots by `scripts/render-hero.cjs`.
- The README starts with a Quick Start section for local unpacked install, the primary release gate, and runtime-only package verification.
- GitHub Actions runs static release checks and package inspection on Ubuntu, then runs real-browser popup and fixture browser QA on Windows after the static job passes.

## Required Checks

Run these before publishing a release candidate:

```powershell
node scripts/verify-release.cjs
node scripts/verify-fixture.cjs
node scripts/verify-fixture-browser.cjs
node scripts/verify-popup-keyboard.cjs
node scripts/render-hero.cjs
node scripts/verify-extension-runtime.cjs
node scripts/package-extension.cjs
node scripts/verify-package.cjs
```

The runtime smoke test needs a local Chromium-based browser that allows unpacked-extension loading. Use `CHROME_PATH` to point at Microsoft Edge, Chromium, Chrome for Testing, or another compatible browser if stable Google Chrome rejects automation flags. The check confirms the `background.js` service worker appears in the Chrome DevTools Protocol target list and removes its temporary profile through the shared browser harness.

The popup keyboard check uses the same browser family and shared harness to open the real extension popup page, verify the header workbench polish, verify the sticky command dock after scroll, verify workflow guidance, verify the shortcut confidence hint, verify AI command-mode readiness and stale-toggle cleanup, verify fill-readiness feedback, verify the scan-based fill plan preview, verify external service recovery states, verify generated-profile overview and section-completion feedback, verify generated-section expand/collapse behavior, verify My Profile visual readability and completeness feedback, verify the Settings overview and API key show/hide control, verify modal focus trapping and Escape close, settle transient toast and copied-button states, and refresh popup screenshots.

The workflow guidance check verifies the compact safe-fill guide starts collapsed, expands from the keyboard, explains prepare-scan-fill order, says scans only read visible fields while sensitive fields remain skipped or manual, stays out of storage and fill payloads, and avoids horizontal overflow.

The shortcut confidence hint check verifies the popup shows the active or fallback fill-form shortcut, explains that shortcut fill uses the same public-profile and empty-fields-only boundary as Fill, stays out of storage and fill payloads, and avoids horizontal overflow.

The fill-readiness check verifies the compact pre-fill surface is derived from existing popup state, combines profile, page scan match preview, fill mode, AI, address, and My Profile status, and stays out of storage, history, archives, Copy All, My Profile fill, and page fill payloads.

The page scan preview check verifies the active-page scan summary stays popup-only, exposes a labelled live region, renders field count, likely standard-field matches, required-field feedback, sensitive required-field skip feedback, and the scan-based fill plan preview as compact labelled chips, keeps the scan action accessible, does not return page input values, and avoids horizontal overflow.

The last-fill result check verifies the post-fill summary remains visible in the main workspace, uses compact labelled metrics for filled, skipped, missed, and skipped-field reasons, stays derived from the content-script response, and does not enter storage helpers or fill payload helpers.

The popup field action check verifies generated-profile lock, copy, and refresh buttons expose field-specific labels, stable lock pressed state, stable dimensions, and no horizontal overflow.

The Mail.tm inbox check verifies verification-code copy buttons stay keyboard-accessible, refresh failures render an inline accessible error state, and registration failures keep a fallback email usable while leaving an inline service recovery state visible without horizontal overflow.

The external service recovery check verifies address enrichment failure renders an inline local-fallback state beside the source controls, stays aligned with the generated-profile source and fill-readiness address pills, and stays out of storage and fill payloads.

The country-scope helper check verifies the popup distinguishes 19-country profile generation from `meiguodizhi.com` US state/city generation, keeps helper text visible, and keeps the US generate button stable.

The Copy All check verifies the sticky-dock copy action writes public profile fields only, shows copied-button feedback, restores its compact icon, keeps empty states out of the clipboard, and never includes generated sensitive display fields.

The section-copy feedback check verifies repeated rapid copy clicks keep the temporary copied state but still restore the original visible label, tooltip, and accessible name after the timer settles.

The My Profile copy check verifies local profile copy output includes only filled sections and fields, keeps payment data limited to summary metadata, keeps empty local profiles out of the clipboard, and never includes full card numbers, CVV, SSN, or generated sensitive fields.

The My Profile import check verifies local JSON import reports ignored unsupported fields after sanitization while keeping the status badge stable.

The My Profile clear check verifies the first click enters an in-popup confirmation state without deleting local data, the second click clears whitelisted profile fields and storage, and the button returns to its stable idle state.

The History clear check verifies the first click enters an in-popup confirmation state without deleting stored history, the second click clears local history and renders the empty state, and the button keeps stable dimensions.

The Fill loading check verifies the primary Fill button exposes disabled and `aria-busy` state while busy, temporarily guards command-dock controls, keeps stable dimensions, then restores cleanly before screenshots.

The AI command-mode check verifies the dock AI toggle appears only after AI settings and an API key are saved, persists only while settings are ready, clears when AI settings are disabled, and does not call AI generation from stale hidden state.

The sensitive display copy check verifies generated sensitive fields expose field-specific manual-copy labels, restore their labels after copy feedback, keep compact dimensions, and remain outside fill and storage payloads.

The reduced-motion check emulates `prefers-reduced-motion: reduce` and verifies modal and spinner animations stop while the popup remains usable without horizontal overflow.

The settings key visibility check opens the real Settings modal, toggles the OpenAI-compatible API key between password and text display, verifies the visible label and `aria-pressed` state, confirms the key value is unchanged, and guards against horizontal overflow.

The settings overview check verifies the compact Settings summary for password rules, AI readiness, address enrichment, and archive count, including disabled, OSM, and Geoapify address modes plus live updates after AI and Geoapify fields change.

The generated-profile overview check verifies the source pill distinguishes Geoapify, OSM, local fallback, US location, AI, and local generation without adding that UI-only source state to fill or storage payloads.

The browser fixture check serves the repository on localhost, opens the manual fixture in a temporary Chromium profile, runs the embedded fill, smart-fill safety, and empty-fields-only checks, guards against mobile horizontal overflow, and refreshes `output/playwright/form-fixture-mobile.png`.

The marketing asset renderer opens `assets/marketing/formpilot-hero.html`, `assets/marketing/formpilot-workflow-demo.html`, and `assets/marketing/formpilot-store-promo.html`, waits for `output/playwright/popup-main.png`, `output/playwright/popup-settings.png`, `output/playwright/popup-profile.png`, and `output/playwright/form-fixture-mobile.png`, verifies fixed export layouts have no overflow, and refreshes `assets/marketing/formpilot-hero.png`, `assets/marketing/formpilot-workflow-demo.png`, plus `assets/marketing/formpilot-store-promo.png`.

## Manual Browser Checks

- Load the repository root as an unpacked extension from `chrome://extensions` or `edge://extensions`.
- Open the popup at extension width and confirm the main workspace renders without horizontal overflow.
- Confirm the workflow guidance starts compact, expands with keyboard focus on its toggle, and explains the safe prepare-scan-fill sequence without writing any data.
- Confirm the shortcut confidence hint shows the active shortcut or an unbound state and says shortcut fill uses the same public-profile and empty-fields-only boundary as Fill.
- Confirm the fill-readiness surface updates after profile edits, page scan match preview, scan-based fill plan preview, empty-fields-only mode, AI readiness, address mode, and My Profile completeness changes without storing page scan data.
- Scan a page with required sensitive fields and confirm the preview says those fields will be skipped before Fill.
- Confirm the header workbench shows the brand mark, compact product copy, readable location state, and a stable IP refresh target in dark and light themes.
- Confirm the generated-profile overview shows completeness, section completion badges, missing fields, lock count, and source without changing fill payloads.
- Confirm the country selector explains 19-country profile generation, and the location source area clearly says `meiguodizhi.com` accepts US states or cities only.
- Confirm Mail.tm registration or refresh failures show inline service recovery copy, keep fallback email usable, and do not hide the inbox recovery panel.
- Confirm map address lookup failure shows the inline local-fallback service recovery state while generated profile source and fill-readiness address pills say local fallback.
- Toggle empty-fields-only mode and confirm it preserves existing page values while still filling blank fields.
- Scroll the popup and confirm Copy All, Regenerate, and Fill stay reachable in the sticky command dock.
- Click Copy All and confirm it shows copied feedback, restores its icon, and copies only public profile fields.
- Clear generated public fields and confirm Copy All shows a no-content toast without writing to the clipboard or showing copied feedback.
- Trigger Fill during manual QA and confirm the button shows a loading state, is temporarily disabled, and restores after completion or error.
- While Fill is running, confirm Copy All, Regenerate, AI mode, and empty-fields-only controls are temporarily disabled and then restored.
- Disable AI in Settings after turning on the dock AI mode and confirm the AI toggle disappears, stores off, and Regenerate uses local generation.
- Collapse and expand the generated profile sections and confirm fields reappear without losing values.
- Reopen or refresh the popup after collapsing a generated profile section and confirm the section state restores without changing profile data.
- Confirm generated field lock, copy, and refresh buttons show field-specific tooltips and keep the same compact dimensions in locked and unlocked states.
- Expand External Data and confirm each sensitive display copy button shows a field-specific tooltip, then returns to that tooltip after copy feedback.
- Open Settings and confirm the API Key control starts hidden, switches to visible with the show/hide button, then returns to hidden without changing the field value.
- Open My Profile and confirm the modal footer does not cover editable fields.
- Edit a My Profile field and confirm the local save status returns to saved without pressing Save.
- Clear My Profile shipping address fields and confirm the billing-from-shipping shortcut disables, then re-enables after entering a shipping address and syncs all billing address fields.
- Click My Profile Copy with filled, partially filled, and empty local profile states; confirm empty labels are omitted and empty profiles show a no-profile toast without writing to the clipboard.
- Click My Profile Clear once and confirm it asks for a second click without deleting data; click it again and confirm the profile clears.
- Clear one My Profile field and confirm the completeness score updates immediately, then click the partial completeness chip and confirm focus moves to the first missing field.
- Confirm My Profile labels, input borders, and the primary fill action remain readable in dark and light themes.
- Confirm reduced-motion mode removes modal, spinner, progress, toast, and hover movement without changing layout.
- Run `node scripts/verify-popup-keyboard.cjs` and confirm each modal keeps Tab focus inside the active modal, Escape closes it, and focus returns to the trigger.
- In History, click Clear History once and confirm history remains; click it again and confirm the empty state appears.
- Import/export a My Profile local JSON file and confirm only whitelisted contact, address, and payment-summary fields round-trip.
- Import a My Profile JSON file with unsupported fields and confirm the popup reports ignored fields without storing or filling them.
- Run `node scripts/verify-fixture-browser.cjs` and confirm the embedded fixture, smart-fill safety, and empty-fields-only checks pass in a real browser.
- Run `tests/manual/form-fixture.html` manually only when investigating a selector issue interactively.
- Run the embedded smart-fill safety check in the fixture when AI mapping behavior changes.
- Run the embedded empty-fields-only check in the fixture when overwrite behavior changes.
- Confirm full card number, CVV, and SSN fixture decoys remain empty after fill.
- Refresh `output/playwright/popup-main.png`, `output/playwright/popup-settings.png`, `output/playwright/popup-profile.png`, `output/playwright/form-fixture-mobile.png`, `assets/marketing/formpilot-hero.png`, `assets/marketing/formpilot-workflow-demo.png`, and `assets/marketing/formpilot-store-promo.png` when the UI changes, and confirm popup screenshots do not capture transient toast or copied-button feedback.
- Run `node scripts/render-hero.cjs` after popup screenshot changes and confirm the README hero, workflow demo, and store promo reflect the current product UI.
- Run `node scripts/verify-package.cjs` after packaging and confirm the zip contains runtime files only.

## Safety Boundary Review

- Main Fill and keyboard shortcut fill must send public profile fields only.
- `getPublicProfileData()` must strip `currentData.sensitive`.
- Generated-profile cache, archives, and recent fill history must store public-only profile data and migrate old records that contain generated sensitive display fields.
- `buildMyProfileFillData()` must not include full card numbers, CVV, SSN, or generated sensitive fields.
- My Profile payment fields are limited to issuer, network, last four, expiry, and billing note.
- My Profile import/export must use the My Profile whitelist and drop unknown fields, full card numbers, CVV, SSN, and generated sensitive fields.
- My Profile import must report ignored unsupported fields without expanding storage, export, or fill payload fields.
- My Profile manual save, auto-save, import, and export must all pass through the same whitelist boundary.
- My Profile copy must omit empty labels and stay within the same contact, address, and payment-summary metadata boundary.
- AI smart-fill mapping must remove identity, financial, employment, and payment credential fields before sending data to the content script.
- Empty AI mapping values must be skipped instead of clearing existing page fields.
- Empty-fields-only mode must skip already-filled page fields for main Fill, My Profile Fill, AI smart fill, and keyboard shortcut fill.
- Generated-profile section collapse preferences must stay UI-only and must not enter fill payloads, My Profile, import/export, or Copy All.
- Workflow guidance state, shortcut confidence state, fill-readiness state, page scan match preview, scan-based fill plan preview, and sensitive skip preview must stay UI-only and must not enter cached data, My Profile, import/export, history, archives, Copy All, keyboard shortcut fill, or fill payload messages.
- Generated sensitive display fields remain manual-copy only.
- Copy All must stay public-only and must not include generated sensitive display fields.

## Permission Review

- Keep `activeTab`, `scripting`, `storage`, and `contextMenus` as the required manifest permissions.
- Keep fixed host permissions scoped to known services documented in `README.md` and `PRIVACY.md`.
- Keep custom OpenAI-compatible endpoints behind optional host permissions.
- Do not add permanent `content_scripts` or a permanent `<all_urls>` host permission.

## Documentation Review

- `README.md` should show the current product tour screenshots, supported countries, release checks, and permission model.
- `CHANGELOG.md` should include the current manifest version and user-facing changes.
- `docs/store-listing.md` should match the current capabilities and permission justifications.
- `docs/architecture.md` should match the popup, background, content-script, and data-boundary contracts.
- `docs/roadmap.md` should keep near-term work focused on selector reliability, data depth, and compact UX improvements.
- `PRIVACY.md` and `SECURITY.md` should be reviewed whenever storage, permissions, AI providers, or external services change.
