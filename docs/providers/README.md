# Provider support

Only the DeepSeek web-session adapter is compiled and routable.

| Provider | Mode | Input | Notes |
| --- | --- | --- | --- |
| DeepSeek (`deepseek`) | Web session | Text chat | [deepseek.md](deepseek.md) |

Official API and other web providers are intentionally absent. Existing legacy
rows in an upgraded SQLite database are preserved for reversibility but are
hidden from runtime routing and the admin UI.

Do not commit tokens, cookies, HAR files, or provider payloads.
