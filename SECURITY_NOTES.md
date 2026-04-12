# Security Notes

## Upstream Vulnerabilities

9 upstream vulnerabilities in OpenClaw@2026.4.11 transitive dependencies
(Lark SDK `@larksuiteoapi/node-sdk` and Discord `axios`/`tar` deps).

**Mitigation:** Blocked by deny-by-default network policy in the allspark
sandbox. Lark and Discord endpoints are not reachable.

**Action:** Revisit when OpenClaw ships axios/tar dependency bumps.
