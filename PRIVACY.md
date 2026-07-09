# Privacy Policy

FormPilot is a local-first Chrome extension for generating profile data and filling forms on the active tab.

## Data Stored Locally

FormPilot uses `chrome.storage.local` for generated profile cache, locked fields, settings, archives, recent fill history, theme preference, optional API keys, and My Profile contact/address data.

My Profile stores name, email, phone, shipping address, billing address, and payment summary metadata only. Payment summary metadata is limited to issuer, network, last four, expiry, and billing note.

FormPilot does not store full card numbers, CVV, or SSN in My Profile.

My Profile import/export creates and reads a user-selected local JSON file. Import uses the My Profile whitelist before saving, so unknown fields, full card numbers, CVV, SSN, and other unsupported sensitive fields are ignored.

## Data Sent to Web Pages

FormPilot fills forms only after a user action: clicking Fill, using My Profile fill, or triggering the configured keyboard shortcut.

The standard fill payload excludes externally generated sensitive display fields. Keyboard shortcut fill and main Fill use public profile fields only. Generated-profile cache, archives, and recent fill history also store public profile fields only, and old cached/archive/history entries with generated sensitive display fields are stripped when loaded.

Optional AI form mapping is sanitized before page fill. Identity, financial, employment, and payment credential fields such as full card numbers, CVV/CVC, SSN, tax IDs, national IDs, passport numbers, driver's license numbers, bank account numbers, income, salary, employer, company name, and employment status are removed from smart-fill mappings.

## External Services

FormPilot may contact these services when the related feature is used:

`ipapi.co` and `ip-api.com` for IP-based country and city detection.

`meiguodizhi.com` for US state or city profile generation.

`api.mail.tm` for temporary inbox creation and message fetching.

`api.geoapify.com` and `nominatim.openstreetmap.org` for optional address enrichment.

An OpenAI-compatible endpoint configured by the user for optional AI profile generation or form field mapping.

Custom OpenAI-compatible endpoints are requested through runtime optional host permissions.

## Permissions

FormPilot does not register a permanent all-site content script. Page scripts are injected on demand into the active tab when a fill or scan action is requested.

Fixed host permissions are limited to known service domains. Broad custom endpoint access is requested at runtime only when a user-configured API origin needs it.

## User Control

Users can clear generated data, history, archives, and My Profile data from the extension UI. Browser extension storage can also be removed by uninstalling the extension or clearing site and extension data through Chrome. Exported My Profile local JSON files are controlled by the user after download.

## Changes

Review this file whenever permissions, storage behavior, external services, AI features, or auto-fill payloads change.
