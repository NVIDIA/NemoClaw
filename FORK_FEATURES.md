<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fork Feature Inventory

> **Purpose:** Living document of all fork-specific features in `Tempuskg/NemoClaw`.
> Referenced by the weekly upstream sync script and PR review checklist.
> Update this file whenever a fork feature is added or removed.

---

## High Conflict Risk

These features modify files that upstream also actively changes. Pay close attention during sync merges.

| Feature | Key Files | Description |
|---------|-----------|-------------|
| **Backup / Restore** | `bin/nemoclaw.js`, `bin/lib/sandbox-backup.js`, `scripts/backup-workspace.sh` | Full sandbox backup to local archive; restore with sandbox recreation, inference re-provisioning, and GitHub token sync. |
| **Gateway Recovery** | `bin/nemoclaw.js` (`getReconciledSandboxGatewayState`) | Auto-selects/starts NemoClaw gateway when missing or unreachable. Reports `identity_drift`, `gateway_unreachable_after_restart`, `gateway_missing_after_restart`. Hydrates registry on-the-fly for live sandboxes missing local entries. |
| **WSL2 Fixes** | `bin/nemoclaw.js` (onboard + dashboard), `scripts/nemoclaw-start.sh` | Dashboard binds to `0.0.0.0`; control UI origin allowlist patched with WSL host IP; authenticated dashboard URLs surfaced; Ollama discovery uses resolved WSL endpoint. |
| **GitHub Token Sync** | `bin/nemoclaw.js` (`syncSandboxGithubTokenEnv`) | Seeds `GH_TOKEN`/`GITHUB_TOKEN` into sandbox env after restore/recreate. |
| **Main Agent Repair** | `bin/nemoclaw.js` (`repair-main` command) | In-sandbox migration that restores explicit `main` agent wiring in older sandboxes. |
| **Agent Persistence Overlays** | `scripts/nemoclaw-start.sh` | Overlay system via `/sandbox/.nemoclaw/agents-overlay.json`. Merges duplicate agent IDs field-wise instead of replacing. Unconditional overlay merge before inference overrides. |
| **Agent Webchat Visibility** | `scripts/nemoclaw-start.sh` (`ensure_agent_webchat_sessions`) | Creates webchat session entries for all configured agents at startup so they appear in Control UI chat dropdown. |
| **Sandbox Startup Guards** | `scripts/nemoclaw-start.sh` | Background launch (no foreground block), bounded probe timeouts (`--max-time`), `set -eu` without `pipefail` for `/bin/sh` compatibility, best-effort writes for read-only `openclaw.json`. |
| **Custom CLI Commands** | `bin/nemoclaw.js` | `dashboard`, `destroy`, `discord-probe`, `policy-add`, `policy-list`, `setup-spark`, `deploy` commands. |

## Medium Conflict Risk

| Feature | Key Files | Description |
|---------|-----------|-------------|
| **Custom Test Suite** | `test/*.test.js` (~20+ fork-specific tests) | Tests for backup-restore, discord-bridge, turn-orchestrator, service management, security hardening, gateway recovery, credential exposure, etc. |
| **Pinned OpenClaw Version** | `Dockerfile.base` | Pins `openclaw@2026.3.11`; suppresses "Update available" banner with `update.checkOnStart=false`. |

## Low Conflict Risk (Additive)

These features add new files that upstream is unlikely to touch.

| Feature | Key Files | Description |
|---------|-----------|-------------|
| **Discord Bridge** | `scripts/discord-bridge.js`, `bin/lib/discord-diagnostics.js`, `test/discord-bridge.test.js`, `test/discord-diagnostics.test.js` | Zero-dependency Discord REST polling bridge. Forwards messages between a Discord channel and the sandboxed OpenClaw agent. |
| **Turn Orchestrator** | `scripts/turn-orchestrator.js`, `scripts/lib/turn-orchestrator.js`, `test/turn-orchestrator.test.js` | Multi-agent turn-taking orchestration for serialized conversations across named agents. |
| **Wiki System** | `scripts/wiki-init.sh`, `wiki/`, `wiki-raw/` | LLM wiki directory structure inside sandboxes for main and sub-agents. |
| **DGX Spark Support** | `scripts/setup-spark.sh`, `spark-install.md` | cgroup v2 + Docker group configuration for DGX Spark. |
| **Docs-to-Skills Generator** | `scripts/docs-to-skills.py` | Converts Markdown docs with YAML frontmatter into Agent Skills (agentskills.io spec). |
| **Service Management** | `scripts/start-services.sh` | Manages Telegram bridge, Discord bridge, and cloudflared tunnel as background services with PID tracking. |
| **CoreDNS Fix (Colima)** | `scripts/fix-coredns.sh`, `scripts/lib/runtime.sh` | Patches CoreDNS forwarding in k3s when running under Colima. |
| **Runtime Detection** | `scripts/lib/runtime.sh` | Detects Colima, Docker Desktop, Podman, and custom Docker runtimes. |
| **Debug Utilities** | `debug_full_runner.js`, `debug_onboard.js`, `debug_state.js` | Development debug scripts for "the-crucible" sandbox. |
| **OpenShell Upload Workaround** | Various restore/sync paths | `touch` target file inside sandbox before `openshell sandbox upload` to avoid 0-byte symlink bug. |
| **Upstream Sync Process** | `scripts/sync-upstream.sh`, `.github/workflows/upstream-sync.yaml`, `FORK_FEATURES.md` | This weekly sync automation. |

---

## Checklist for Sync Reviews

After merging upstream, verify:

- [ ] All commands listed in "Custom CLI Commands" still present in `bin/nemoclaw.js`
- [ ] `scripts/nemoclaw-start.sh` preserves: `ensure_agent_webchat_sessions()`, overlay merge, bounded probes, background launch
- [ ] Fork-specific tests compile and pass (`npx vitest run`)
- [ ] Coverage ratchet passes (`npx tsx scripts/check-coverage-ratchet.ts`)
- [ ] TypeScript plugin builds (`cd nemoclaw && npm run build`)
- [ ] Docker images build (`docker build -f Dockerfile.base .` && `docker build .`)
