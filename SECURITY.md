# Security Policy

## Reporting

Do not open a public issue containing credentials, cookies, API keys, provider
payloads, prompts, completions, SQLite files, or deployment configuration.

Before public release, configure a private security-reporting address or GitHub
private vulnerability reporting and replace this paragraph with the verified
contact method.

## Supported versions

Only the latest tagged release is intended to receive security fixes. This
policy takes effect when the first public version is tagged.

## Security boundaries

- Provider credentials are encrypted at rest.
- Client API keys are stored as one-way hashes.
- Raw keys are displayed once.
- Prompt and completion bodies are not persisted.
- The production container is non-root, read-only, and capability-free.
- Arbitrary upstream URLs and remote media fetching are disabled.

DeepSeek web endpoints are undocumented. Provider protocol changes and account
controls are operational risks, not security guarantees supplied by this
project.
