# Client Quickstart

Chat2API exposes the supported subset of the OpenAI chat-completions contract.
Create a scoped client key in the admin console, then store the key in a secret
manager or a mode-`0600` environment file.

```bash
export OPENAI_BASE_URL="https://gateway.example.com/v1"
export OPENAI_API_KEY="<client-key>"
```

Run one of the dependency-free examples:

```bash
bash examples/curl.sh
node examples/node.mjs
python3 examples/python.py
```

Use a separate key per application. Set only the required `chat` and/or
`models` scopes, an explicit model allowlist, RPM and daily quotas, an expiry
date, and an IP/CIDR allowlist where the client has stable egress addresses.
Rotate a key in the admin console, migrate the client during the selected grace
period, then verify that the old key expires.

The gateway supports text-only `GET /v1/models` and
`POST /v1/chat/completions`. It rejects tools, media, JSON mode, arbitrary
sampling controls, `/v1/completions`, and `/v1/responses` rather than silently
emulating them.

Never put API keys in query strings, source code, browser bundles, screenshots,
support tickets, or command-line history.
