# Built-in provider notes

The gateway contains fixed adapters for DeepSeek, GLM, Kimi, MiMo, MiniMax,
Perplexity, Qwen, Qwen AI, and Z.ai.

These adapters use provider web-session credentials and undocumented endpoints.
Compatibility is best-effort, not an uptime guarantee. Before enabling one:

1. Review the provider's current terms and automation policy.
2. Use a dedicated, low-value test account.
3. Enter credentials only through the HTTPS admin console.
4. Start with the provider disabled; enable it after credentials are saved.
5. Run one non-stream and one stream request.
6. Disable the account immediately if authentication or anti-bot controls trigger.

Do not place tokens, cookies, HAR files, or provider payloads in source control.
The old embedded OAuth/browser login flow was intentionally removed.

| Provider | Notes |
| --- | --- |
| DeepSeek | [deepseek.md](deepseek.md) |
| GLM | [glm.md](glm.md) |
| Kimi | [kimi.md](kimi.md) |
| MiMo | [mimo.md](mimo.md) |
| MiniMax | [minimax.md](minimax.md) |
| Perplexity | [perplexity.md](perplexity.md) |
| Qwen | [qwen.md](qwen.md) |
| Qwen AI | [qwen-ai.md](qwen-ai.md) |
| Z.ai | [zai.md](zai.md) |
