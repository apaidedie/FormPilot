## Summary

Describe the user-facing change and the files or areas touched.

## Roadmap Fit

Link the related area in `docs/roadmap.md`, or explain why this change should adjust the current direction.

## Safety Boundary

- [ ] This change does not store or auto-fill full card numbers, CVV, SSN, or generated sensitive fields.
- [ ] Main Fill, My Profile Fill, and keyboard shortcut behavior still use public fill payloads only.
- [ ] Manifest permissions remain narrow, or any new fixed host permission is justified in README and PRIVACY.

## Verification

- [ ] `node scripts/verify-release.cjs`
- [ ] `node scripts/verify-fixture.cjs` when selector, fill, profile, or fixture behavior changed.
- [ ] `node scripts/verify-fixture-browser.cjs` when selector, smart-fill, content-script fill, or empty-fields-only behavior changed.
- [ ] `node scripts/verify-popup-keyboard.cjs` when popup modal, focus, layout, or keyboard behavior changed.
- [ ] `node scripts/verify-extension-runtime.cjs` before release, or noted why Chrome/Edge was unavailable locally.
- [ ] `node scripts/package-extension.cjs`
- [ ] `node scripts/verify-package.cjs` after packaging.
- [ ] Manual form fixture checked when selector, fill, profile, or payment-summary behavior changed.
- [ ] Popup visual check refreshed when UI, copy, spacing, or motion changed.
- [ ] `CHANGELOG.md` and `docs/release-audit.md` updated when release-facing behavior changed.

## Notes

Mention any follow-up, intentionally skipped browser checks, or external service behavior that reviewers should know.
