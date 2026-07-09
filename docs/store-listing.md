# Chrome Web Store Listing Draft

## Extension Name

FormPilot - Smart Form Testing Assistant

## Short Description

Generate local-looking test profiles and fill registration, checkout, and profile forms from a privacy-conscious MV3 popup.

## Detailed Description

FormPilot helps developers, QA testers, and growth teams test forms faster. Generate realistic profile data, fill visible fields on the active tab, save reusable contact profiles, and validate registration or checkout flows without repeatedly typing the same test data.

FormPilot is built as a Chrome Manifest V3 extension with a compact popup workspace. It does not register a permanent all-site content script. Page scripts are injected only when you click Fill, use My Profile fill, or trigger the keyboard shortcut.

Core features:

Generate test profiles for 19 countries and regions, including local-looking names, phone formats, addresses, cities, states, and postal codes.

Generate US profiles by state or city through meiguodizhi.com.

Fill common registration, account, contact, shipping, billing, and profile forms.

Review fill readiness before running Fill, including profile completeness, likely page matches, fill mode, AI readiness, address mode, and My Profile completeness.

Follow compact workflow guidance for the safe prepare-scan-fill sequence before changing page fields.

See a shortcut confidence hint with the active fill shortcut and the same public-profile safety boundary as the Fill button.

See compact scan-summary chips and a scan-based fill plan preview for likely matches, required-field coverage, and sensitive required fields that FormPilot will skip before running Fill.

See the last-fill result in the main workspace with compact matched, skipped, missed, and skip-reason counts.

Use empty-fields-only mode to preserve existing page values while filling blank fields.

Save My Profile with real name, email, phone, shipping address, billing address, and payment summary metadata.

Auto-save My Profile edits locally with visible status feedback.

Use Mail.tm temporary inboxes for disposable test email workflows.

See inline service recovery states when Mail.tm or optional address enrichment is unavailable, with fallback behavior kept visible in the popup.

Lock generated fields before regenerating, copy individual fields, profile blocks, or postal mailing-address lines, save archives, and restore recent fill history.

Optionally enrich addresses through OpenStreetMap Nominatim or Geoapify, with the map lookup toggle remembered locally.

Optionally use an OpenAI-compatible API to map unusual form fields.

Privacy and safety boundary:

My Profile stores contact and address data plus payment summary metadata only. It does not store full card numbers, CVV, or SSN.

The main Fill action and keyboard shortcut use public profile fields only.

Empty-fields-only mode changes overwrite behavior only; it does not add sensitive fields to fill payloads.

Externally generated sensitive test-like display fields, when available, are not part of standard auto-fill payloads.

Generated-profile cache, archives, and recent fill history keep public profile fields only.

Custom OpenAI-compatible endpoints are requested through runtime optional host permissions.

FormPilot is a testing and productivity tool. It is not intended for impersonation, fraud, or misuse on systems where you do not have permission to test.

## Category

Developer Tools

## Primary Audience

Developers, QA testers, product teams, growth teams, and form-heavy web app builders.

## Permission Justification

`activeTab` is used to fill the current page only after a user action.

`scripting` is used for on-demand content script injection.

`storage` is used for local settings, generated data cache, archives, history, and My Profile.

`contextMenus` is used for the right-click entry point.

Fixed host permissions are used for IP lookup, Mail.tm, meiguodizhi.com, Geoapify, OpenStreetMap Nominatim, and the default OpenAI endpoint.

Optional host permissions are used for custom OpenAI-compatible API endpoints configured by the user.

## Screenshot Suggestions

Use `output/playwright/popup-main.png` to show the main profile generator.

Use the main popup screenshot to highlight the fill-readiness surface and scan-based fill plan preview before Fill.

Use the main popup screenshot to show the workflow guidance for preparing data, scanning the page, and filling after review.

Use the main popup screenshot to show the compact service recovery state for optional inbox and address services when relevant.

Use `output/playwright/popup-settings.png` to show Settings readiness for password rules, AI, address enrichment, and archives.

Use `output/playwright/popup-profile.png` to show My Profile and payment summary metadata.

Use `output/playwright/form-fixture-mobile.png` to show the local QA fixture and sensitive decoy check.

Use `assets/marketing/formpilot-hero.png` as the GitHub README hero.

Use `assets/marketing/formpilot-workflow-demo.png` as a supporting screenshot for the prepare-scan-review-fill workflow demo and safety boundary.

Use `assets/marketing/formpilot-store-promo.png` as the Chrome Web Store promotional tile or social preview image.

Refresh all marketing assets from `assets/marketing/formpilot-hero.html`, `assets/marketing/formpilot-workflow-demo.html`, and `assets/marketing/formpilot-store-promo.html` with `node scripts/render-hero.cjs` after updating popup or fixture screenshots.

## Review Notes

The extension has no build step and can be loaded unpacked from the repository root. Runtime package contents are produced by `node scripts/package-extension.cjs` and checked by `.github/workflows/release-check.yml`. Local release checks can also run `node scripts/verify-extension-runtime.cjs` to load the unpacked extension in Chrome or Edge and confirm the MV3 service worker starts.

The sensitive-field boundary is intentional. My Profile supports payment summary metadata only, and the embedded manual fixture keeps full card number, CVV, and SSN decoys empty.

Product direction and non-goals are tracked in `docs/roadmap.md` so store copy, README positioning, and contribution guidance stay aligned.

Release notes are tracked in `CHANGELOG.md`, and maintainer release checks are tracked in `docs/release-audit.md`.
