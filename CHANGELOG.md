# Changelog

All notable changes to FormPilot are tracked here. The project follows semantic versioning for extension releases.

## 1.8.0 - Release Candidate

### Added

- My Profile for reusable contact, shipping, billing, and payment-summary metadata.
- My Profile payment-summary inputs now normalize pasted card metadata to last-four and `MM/YY` expiry while keeping the no-full-card/CVV/SSN storage boundary visible.
- My Profile actions now separate import/export/copy/save management controls from the isolated clear action, with the fill action kept as the single primary CTA.
- Settings now start with a compact overview for password rules, AI readiness, address enrichment, and archive count.
- Active-page scan preview now shows visible field count, likely standard-field matches, required-field coverage, sensitive required fields that will be skipped, page type, and CAPTCHA presence in compact scan-summary chips before a fill action without writing or storing page data.
- Active-page scan preview now includes a scan-based fill plan preview for matched public fields, unmatched required labels, and sensitive required labels that will be skipped before a fill action.
- Main popup now includes compact first-run workflow guidance for preparing data, scanning the page, and filling only after reviewing the plan.
- Main popup now includes a shortcut confidence hint that shows the active fill shortcut and repeats the public-profile safety boundary.
- Main workspace fill-readiness now combines generated profile completeness, page match preview, fill mode, AI readiness, address mode, and My Profile completeness into one pre-fill signal.
- Generated profile overview now shows a compact missing-field hint only when a profile is incomplete, then hides again after the profile is restored.
- The country picker now includes an expandable in-popup coverage panel that lists all 19 supported generated countries and highlights the current selection.
- Local auto-save status for My Profile edits.
- My Profile completeness feedback for contact, shipping, billing, and payment-summary sections.
- Main workspace generated-profile overview for completeness, missing fields, lock count, and source.
- Empty-fields-only fill mode to preserve existing page values while filling blanks.
- Postal mailing-address copy for the generated public contact/address profile.
- last-fill result surface in the main workspace, with compact filled, skipped, missed, and skip-reason counts after each fill action.
- My Profile import/export for non-sensitive contact, address, and payment-summary metadata.
- My Profile import now reports ignored unsupported fields after sanitizing local JSON files.
- Payment summary storage limited to issuer, network, last four, expiry, and billing note.
- Identity, account, and contact block-copy actions in the popup.
- `meiguodizhi.com` support for US state and city profile generation.
- Mail.tm temporary inbox support with verification-code copy.
- External service recovery states for Mail.tm registration failures and address enrichment fallback, keeping recovery copy visible inside the popup.
- Local manual form fixture for selector coverage and sensitive decoy checks.
- Popup keyboard QA with `scripts/verify-popup-keyboard.cjs` for modal focus trapping, Escape close, focus return, and screenshot refresh.
- Sticky command dock in the popup keeps Copy All, Regenerate, and Fill visible while scanning longer generated profiles.
- Runtime package tooling with `scripts/package-extension.cjs`.
- Runtime package boundary verification with `scripts/verify-package.cjs`.
- Release verification with `scripts/verify-release.cjs`, `scripts/verify-fixture.cjs`, browser fixture QA through `scripts/verify-fixture-browser.cjs`, and local unpacked-extension smoke testing through `scripts/verify-extension-runtime.cjs`.
- Reproducible marketing asset rendering with `scripts/render-hero.cjs` for the GitHub README hero, workflow demo at `assets/marketing/formpilot-workflow-demo.png`, and Chrome Web Store promo image, now including the Settings readiness screenshot.
- GitHub workflow, issue templates, pull request template, roadmap, architecture notes, privacy policy, security policy, and store listing draft.
- Cross-platform required-file case checks in the release gate, so Windows-local verification catches path casing that would fail on Linux CI.
- Split GitHub release checks into Ubuntu static/package verification and Windows real-browser popup and fixture QA.
- Shared browser verification harness for Chrome or Edge discovery, CDP calls, unpacked-extension diagnostics, and safe temporary-profile cleanup.

### Changed

- Popup UI was reorganized into a compact workspace with clearer header actions, command strip, profile modal, section labels, and light/dark theme polish.
- Popup visual styling now uses a quieter developer-tool palette with less decorative glow and more stable information surfaces.
- Settings sections now use clearer grouped surfaces and live status summaries instead of a long undifferentiated form.
- Country and location generation copy now separates 19-country profile generation from US-only state/city address generation.
- Popup header was refined into a compact workbench status panel with a stable brand mark, clearer location state, and light/dark treatment.
- The popup command strip is now a translucent sticky dock with light and dark theme treatment.
- Reduced-motion mode now removes modal, spinner, pulse, progress, toast, and hover movement while preserving layout and focus states.
- Content scripts are injected on demand instead of being registered permanently in the manifest.
- README and store copy now describe the permission model, supported generated countries, release checks, and safety boundary.
- README now starts with a Quick Start path for loading the unpacked extension, running the primary release gate, and building the runtime-only package.
- Packaging now includes runtime files only and excludes docs, screenshots, fixtures, local agent metadata, and release tooling.
- Runtime smoke testing now checks for the unpacked extension service worker target through CDP instead of attaching to every extension worker, making local browser verification less brittle.
- Copy All now omits empty public fields, removes trailing whitespace from copied profile text, and uses the same copied-button feedback as field and section copy actions.
- Copy All empty state now stays out of the clipboard and shows a clear no-content toast instead of copied feedback.
- Modal dialogs now keep keyboard focus inside the active dialog and return focus to the triggering control when closed.
- Generated profile sections are now collapsible, default expanded, and keyboard-accessible for faster scanning in the compact popup.
- Generated profile sections now show compact completion badges, so missing identity, account, or contact fields are visible before expanding a section.
- Generated profile section collapse state now persists locally as UI-only state, so compact review layouts stay stable across popup reopen and refresh.
- My Profile modal readability was tightened with clearer section hierarchy, brighter labels, stronger input surfaces, and a more stable action footer.
- My Profile completeness chips now focus the first missing local field in a section, making partial profiles faster to finish.
- My Profile edits now auto-save locally through the same whitelist used by manual save, import, and export.
- My Profile now disables the billing-from-shipping shortcut until a shipping address exists, then re-enables it live as the address is entered.
- My Profile copy now outputs only filled sections and fields, and shows a no-profile toast without writing to the clipboard when the local profile is empty.
- My Profile clear now requires a second click inside the popup, avoiding accidental deletion without a blocking browser dialog.
- History clear now uses the same in-popup second-click confirmation pattern instead of a blocking browser dialog.
- Single history item delete now also requires an in-popup second click, matching the safer deletion pattern across the popup.
- History record loading now uses a real keyboard-focusable button with visible focus feedback instead of a mouse-only row click target.
- Mail.tm verification-code copy controls now use keyboard-focusable buttons with accessible labels and visible focus feedback.
- Mail.tm refresh and AI connection test controls now expose localized accessible names with stable keyboard focus feedback.
- Mail.tm inbox now uses a compact two-column message panel with a fixed refresh control instead of stretching the refresh action like a primary CTA.
- Mail.tm refresh failures now render an inline inbox error state instead of leaving the panel looking empty.
- Mail.tm registration failures now keep the fallback email usable and leave an inline service recovery state visible instead of hiding the inbox panel.
- Address enrichment now distinguishes Geoapify/OSM success from local fallback in both toast copy and the generated-profile source pill.
- Address enrichment fallback now renders an inline service recovery state beside the source controls, aligned with the generated-profile source and fill-readiness address pills.
- The address enrichment toggle now persists locally, and Settings distinguishes disabled, OSM, and Geoapify address modes.
- Command dock toggles now show explicit on/off text states and keep their hidden checkbox inputs keyboard-focusable.
- Generated profile overview status pills now use a stable two-column layout and expose matching accessible labels.
- Fill-readiness status pills, page match preview counts, scan-based fill plan preview, and sensitive skip preview are derived UI-only state and stay out of storage, Copy All, My Profile, history, archives, and page fill payloads.
- Generated profile overview progress now sits inside the score block, keeping the identity summary and status area visually balanced.
- Generated section-copy buttons now keep stable dimensions while showing copied feedback.
- Shared copy feedback now survives rapid repeated copy clicks and restores the original button label, tooltip, and accessible name instead of getting stuck on the checkmark.
- Archive delete now uses the same in-popup second-click confirmation pattern with stable button sizing and accessible state.
- Archive management now includes local search with result counts and a filtered empty state.
- AI settings now include a show/hide control for the OpenAI-compatible API key, with stable labels and keyboard-accessible state.
- AI mode now requires enabled AI settings and a saved API key; disabling AI settings clears the command-dock AI toggle and prevents hidden stale state from triggering AI generation or smart fill.
- AI smart-fill mapping now drops identity, financial, employment, and payment credential fields before page fill.
- Empty AI smart-fill values are skipped instead of clearing existing page fields.
- Main Fill, My Profile Fill, AI smart fill, and keyboard shortcut fill now share the empty-fields-only option.
- Main Fill now uses the shared loading state with disabled and `aria-busy` feedback while a fill is running.
- Main Fill now temporarily disables Copy All, Regenerate, AI mode, and empty-fields-only controls while a fill is running, then restores their previous state.
- Generated-profile cache, archives, and recent fill history now store public-only profile fields and migrate old sensitive display fields away on load.
- Runtime and popup browser verifiers now use the same harness, reducing duplicated launch and cleanup behavior across local and CI checks.
- The README hero and store promo now render from current popup and fixture screenshots instead of being manually refreshed standalone assets.
- Generated field action buttons now use clearer lock, copy, and refresh labels with stable accessible names, pressed state, and non-emoji lock visuals.
- Generated sensitive display copy buttons now expose field-specific labels while staying manual-copy only.
- Main workspace generated-profile overview now carries stateful complete, missing, locked, and source feedback in both visuals and accessibility labels.
- History now includes local search with live result counts, filtered empty state, and compact keyboard-verified layout.

### Safety Boundary

- Generated sensitive fields from third-party profile sources are display-only and manual-copy only.
- Main Fill, My Profile Fill, and keyboard shortcut fill strip `currentData.sensitive` before sending data to pages.
- Generated-profile cache, archives, and recent fill history strip generated sensitive display fields before storage.
- My Profile does not store or auto-fill full card numbers, CVV, SSN, or generated sensitive fields.
- My Profile import/export is sanitized through the My Profile whitelist and drops unsupported sensitive fields.
- My Profile import reports ignored unsupported fields without adding them to storage or fill payloads.
- Copy All copies public profile fields only; generated sensitive display fields require per-field manual copy.
- Generated sensitive display copy controls are label-only UI affordances and do not expand fill, cache, history, archive, import, or export payloads.
- AI smart-fill does not auto-fill full card numbers, CVV/CVC, SSN, tax IDs, national IDs, passport numbers, driver's license numbers, bank account numbers, income, salary, employer, company name, or employment status.
- Empty-fields-only mode only changes overwrite behavior; it does not expand fill payloads or sensitive-field access.
- The manifest does not register permanent `content_scripts` and does not include a permanent `<all_urls>` host permission.

### Verification

- `node scripts/verify-release.cjs`
- `node scripts/verify-fixture.cjs`
- `node scripts/verify-fixture-browser.cjs`
- `node scripts/verify-popup-keyboard.cjs`
- `node scripts/render-hero.cjs`
- `node scripts/verify-extension-runtime.cjs`
- `node scripts/package-extension.cjs`
- `node scripts/verify-package.cjs`
- Browser keyboard focus check for My Profile modal open, Tab wrap, Shift+Tab wrap, and Escape close.
- Browser popup check for generated-section expand/collapse state, sensitive-section ARIA state, and horizontal overflow.
- Browser popup check that generated-section collapse preferences persist through storage and restore after popup reload.
- Browser popup check that the sticky command dock remains pinned and keeps primary actions visible after scrolling.
- Browser popup check for workflow guidance compact state, keyboard expansion, safe-fill copy, and horizontal overflow.
- Browser popup check for the header workbench visual contract, brand mark, location state, tap target size, and horizontal overflow.
- Browser popup check for generated-profile overview completeness, missing-field text, lock-count updates, source visibility, and horizontal overflow.
- Release gate check for fill-readiness markup, scan match preview, scan-based fill plan preview, sensitive skip preview, styling, derived-state renderer, documentation, and storage/payload exclusions.
- Browser popup check for generated-profile section completion badges, live partial states, accessibility labels, and stable dimensions.
- Browser popup check for Copy All empty-state feedback without clipboard writes.
- Browser popup check for country-scope helper copy, US-location helper copy, stable US generate button sizing, and horizontal overflow.
- Browser popup check for reduced-motion behavior with modal and spinner animations disabled.
- Browser popup check for generated field action button labels, lock pressed state, stable dimensions, and horizontal overflow.
- Browser visual contract check for My Profile label contrast, input surface separation, footer placement, and screenshot timing after modal animation.
- Browser auto-save check for My Profile status feedback, local persistence, and sensitive-field exclusions.
- Browser check for the My Profile billing-from-shipping shortcut disabled, enabled, synced, and persisted states.
- Browser popup check for My Profile compact copy output, empty-state feedback, and sensitive-field exclusion.
- Browser completeness check for My Profile score, progress bar, section chips, missing-field focus, and live updates after edits.
- Fixture smart-fill safety check for AI mapping sensitive-field removal and empty-value skipping.
- Fixture empty-fields-only check for preserving existing values, filling blanks, and reporting skipped filled fields.
- Browser fixture check for embedded fill, smart-fill safety, empty-fields-only behavior, mobile horizontal overflow, and fixture screenshot refresh.
- Browser popup check for empty-fields-only toggle visibility, persistence, and horizontal overflow.
- Browser popup check for external service recovery states covering Mail.tm registration fallback and address enrichment local fallback.
- Browser popup check for AI command-mode readiness, stale-toggle cleanup, and non-AI regeneration after AI settings are disabled.
- Browser popup check for postal mailing-address copy format, feedback, and sensitive-field exclusion.
- Browser popup check for fill result toast formatting and compact history summary rendering.
- Browser popup check for Fill button busy-state accessibility, guarded command-dock controls, and clean restoration.
- Browser popup check that generated-profile cache, archives, and recent fill history remain public-only after migration and new saves.
- Browser popup screenshot refresh now waits for transient toast and copied-button feedback to clear before capturing release images.
- Browser marketing rendering check refreshes the reproducible README hero and store promo from the main, Settings, My Profile, and fixture screenshots, then verifies fixed export layouts have no overflow.
- Required-file exact-case check for release assets, GitHub templates, screenshots, docs, and runtime files.
- Release gate check that browser verifiers use `scripts/lib/browser-harness.cjs` instead of duplicating Chrome, CDP, or temporary-profile cleanup logic.
- Zip boundary inspection for `dist/formpilot-1.8.0.zip`
