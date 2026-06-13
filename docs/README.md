# ZApi — Documentation Index

| File                                           | Content                                                                                                                                                    | Last updated   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| [01_STATUS.md](./01_STATUS.md)                 | Health table, provider comparison, quick start, critical architecture changes summary                                                                      | 2026-06-14     |
| [02_ARCHITECTURE.md](./02_ARCHITECTURE.md)     | System overview, mermaid sequence diagrams (normal + tool-calling flows), two-path WAF strategy, timeout layers, error retry, account management           | 2026-06-14     |
| [03_CODE_MAP.md](./03_CODE_MAP.md)             | Module layout with descriptions, key interfaces table, config constants table, evaluate helpers table, dependencies table                                  | 2026-06-14     |
| [04_CHANGELOG.md](./04_CHANGELOG.md)           | Session history: stabilization, tool calling, WAF bypass, DeepSeek PoW, docs audit                                                                         | Sessions 1–67  |
| [05_OPEN_QUESTIONS.md](./05_OPEN_QUESTIONS.md) | Active tech-debt items (D1-D11), resolved issues archive, behavioral quirks, API compatibility notes                                                       | 2026-06-14     |

> Source material: `../.agent-brief.md` — raw session log. Structured docs extracted from **67+ development sessions** across June 7–14, 2026.

## Key architecture changes

- **S53**: Aliyun WAF detection (CAPTCHA + Cloud WAF share resolver)
- **S54**: CDP timeout protection — `evaluateWithTimeout` / `evaluateInBrowser`
- **S55**: Browser-evaluate migration, account binding (`chatTokenOwner`), 5-min timeouts
- **S61**: Multi-provider isolation via `child_process.fork()`, shared/ module pool
- **S62**: WAF bypass: removed `Authorization: Bearer`, Path 2 rewritten via page fetch
- **S67**: Docs audit: dead code removed, discrepancies fixed, architecture rewritten with mermaid
