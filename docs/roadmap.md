# FormPilot Roadmap

FormPilot is aiming to be a small, trustworthy form-testing extension rather than a heavyweight automation platform. The project should stay easy to inspect, easy to load unpacked, and strict about sensitive-field boundaries.

## Current Focus

The current release line focuses on product polish, selector reliability, and confidence for contributors:

- Keep the popup fast, compact, and readable at extension width.
- Keep fill-readiness, page match preview, and scan-based fill plan preview visible as derived pre-fill signals rather than hidden in separate Settings or History screens.
- Keep dense generated fields organized into keyboard-accessible sections that stay easy to scan.
- Expand selector coverage only when a fixture or real form pattern proves the need.
- Keep `node scripts/verify-release.cjs`, `node scripts/verify-fixture.cjs`, `node scripts/verify-fixture-browser.cjs`, and `node scripts/verify-popup-keyboard.cjs` as the local and CI safety net, with `node scripts/verify-extension-runtime.cjs` as the local unpacked-extension smoke test before release.
- Keep non-sensitive My Profile import/export covered by the same whitelist as My Profile fill.
- Keep docs, screenshots, Chrome Web Store copy, and packaged runtime contents in sync.
- Keep `CHANGELOG.md` and `docs/release-audit.md` aligned with the current manifest version.

## Near-Term Work

These are the best first areas for contributors:

- Add focused fixture cases for common form layouts that are not covered yet, such as split address lines, region dropdown variants, phone-number formatting edge cases, and scan match-preview misses.
- Improve country data depth for the existing 19 countries and regions before adding many new picker entries.
- Add small popup UX refinements that reduce repeated work without increasing permissions, especially refinements that make the pre-fill plan clearer before a destructive or noisy test action.
- Improve Mail.tm and optional address enrichment error states so users understand when an external service is unavailable.
- Add more screenshots or a short demo capture for README and store review, while keeping generated artifacts out of the extension zip.

## Later Work

These are useful, but should wait until the core extension stays stable:

- More localized UI copy for users who prefer English-only or Chinese-only popup text.
- A broader public form-pattern gallery for selector regressions.
- Broader keyboard-only coverage beyond the modal stack, including dense field actions and archive/history list operations.
- Store-ready release notes generated from verified changes.

## Non-Goals

FormPilot should not become a credential vault, identity document generator, or broad unattended automation tool.

- Do not store or auto-fill full card numbers, CVV, SSN, or generated sensitive third-party fields.
- Do not add a permanent `<all_urls>` content script.
- Do not add a build system or dependency stack unless a future change clearly pays for the added maintenance cost.
- Do not add countries to the picker without local names, phone format, street data, city/state data, and postal-code behavior.

## Acceptance Bar

A roadmap item is ready to merge when it has a narrow user-facing outcome, preserves the permission and sensitive-field boundaries, updates docs when behavior changes, and passes the release gate. Selector and form-fill changes should also update or exercise `tests/manual/form-fixture.html` and pass `node scripts/verify-fixture.cjs`; behavior changes should also pass `node scripts/verify-fixture-browser.cjs` when Chrome or Edge is available. Release candidates should pass `node scripts/verify-extension-runtime.cjs` on a local Chrome or Edge install before packaging.
