# SHEIN Review Exporter

Early Manifest V3 Chrome extension for exporting reviews that are normally accessible from a SHEIN product page.

## Current state

The data model, deterministic fallback deduplication, CSV/JSON export, persisted progress, cancellation, and retry primitives are implemented and unit tested. The current DOM collector is deliberately conservative and must be calibrated against live SHEIN pages before completeness claims are trusted.

## Local checks

```powershell
npm test
```

Load `D:\web` as an unpacked extension from `chrome://extensions` only for development. The extension requests temporary access to the active tab when the user clicks it; it does not request access to every website.

## Boundaries

The extension does not bypass authentication, CAPTCHA, regional restrictions, anti-automation controls, or rate limits. It does not collect authentication tokens. If the site prevents ordinary access, collection stops and retains the progress gathered so far.
