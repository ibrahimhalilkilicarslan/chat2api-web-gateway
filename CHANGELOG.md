# Changelog

## Unreleased

### Added

- Cross-platform native Session Connector transport with independent,
  short-lived capabilities for Windows, macOS, and Linux
- Admin onboarding copy and workflow for a portable connector using an isolated
  installed-browser profile

### Security

- Native and browser-extension capabilities use different secrets and cannot be
  replayed across transport endpoints
- Native completion rejects browser origins, requires an explicit connector
  header, follows no CORS path, and preserves server-side credential validation

## 2.1.0 - 2026-07-30

### Added

- API-key expiry, exact IP/CIDR policies, safe grace-period rotation, and
  editable key policies
- P50/P95/error/account operational metrics, SQLite maintenance visibility, and
  metadata-only audit CSV export
- Exact admin-host restriction in addition to origin and CSRF controls
- Isolated SQLite restore drill, optional off-host rclone copy, coarse webhook
  alerts, and guarded Coolify release automation
- Dependency-free curl, Node.js, and Python client examples
- OpenAI compatibility smoke, explicitly gated load smoke, production-license
  audit, and full-history secret scanning

### Security

- Existing API-key values remain hash-only and raw replacement keys are shown
  once
- Spreadsheet formula injection is neutralized in audit CSV exports
- Legacy upstream false positives are allowlisted by exact Gitleaks fingerprint,
  not by broad path or commit exclusions
- Database migration and admin-host boundaries have dedicated regression tests
