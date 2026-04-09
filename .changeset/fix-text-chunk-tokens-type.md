---
"@ontos-ai/knowhere-sdk": patch
---

Update `TextChunk.tokens` to match the current API payload shape of `string[]`, and normalize legacy numeric token values out of parsed results so the runtime contract matches the published TypeScript types.
