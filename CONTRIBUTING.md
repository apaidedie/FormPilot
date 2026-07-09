# Contributing

Thanks for improving FormPilot. The project is intentionally small and no-build, so contributions should keep the extension easy to inspect and load unpacked.

## Development Rules

Keep JavaScript plain browser-compatible code unless a task explicitly introduces a build step.

Keep `DEBUG` and `FORMPILOT_DEBUG` disabled by default.

Do not add permanent broad host permissions when a fixed service origin or runtime optional permission is enough.

Do not add full card numbers, CVV, SSN, or generated sensitive fields to standard auto-fill payloads.

Check `docs/roadmap.md` before proposing broad features. It records the current focus, good contribution areas, later work, and non-goals.

## Selector Changes

Selector improvements should be backed by a real field pattern, the local fixture, or a focused regression case. Update `tests/manual/form-fixture.html` when the change expands an important supported form shape.

## Checks

Run the release verifier:

```powershell
node scripts/verify-release.cjs
```

Run the fixture contract verifier when selectors, content fill behavior, My Profile fields, or the manual fixture change:

```powershell
node scripts/verify-fixture.cjs
```

Run the browser fixture verifier when selector, smart-fill, content-script fill, or empty-fields-only behavior changes and Chrome or Edge is available:

```powershell
node scripts/verify-fixture-browser.cjs
```

Create the extension package before release-oriented changes are merged:

```powershell
node scripts/package-extension.cjs
```

The release verifier covers JavaScript syntax, manifest parsing, permission scope, sensitive auto-fill boundaries, generated country coverage, fixture contract alignment, documentation references, and GitHub community files.

For form-fill changes, use `node scripts/verify-fixture-browser.cjs` or serve the folder locally and run `tests/manual/form-fixture.html`.

For UI changes, refresh screenshots in `output/playwright/` and check for overflow at the extension popup width.

## Pull Requests

Use the pull request template. Keep the safety boundary section accurate and call out any permission, storage, AI endpoint, or external-service change.

For feature work, link the related roadmap area or explain why the project should change direction.

## Security Reports

Do not paste real full card numbers, CVV, SSN, API keys, passwords, or private addresses into issues or pull requests. Follow `SECURITY.md` for vulnerability reports.
