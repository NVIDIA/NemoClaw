<!-- markdownlint-disable MD041 -->
## Upstream Sync — {{ date }}

Merges `NVIDIA/NemoClaw` `main` into this fork.

## Pre-merge Checklist

### Build & Test

- [ ] `npm install` — dependencies resolve after merge
- [ ] `cd nemoclaw && npm run build` — TypeScript plugin compiles
- [ ] `npx vitest run` — all unit tests pass
- [ ] `make check` — lint and hooks pass
- [ ] `npx tsx scripts/check-coverage-ratchet.ts` — coverage ratchet holds

### Fork Features Preserved

> Refer to [FORK_FEATURES.md](../../FORK_FEATURES.md) for details on each feature.

#### High Conflict Risk

- [ ] `bin/nemoclaw.js` — all fork CLI commands present: `backup`, `restore`, `repair-main`, `discord-probe`, `dashboard`, `destroy`, `policy-add`, `policy-list`, `setup-spark`, `deploy`
- [ ] `bin/nemoclaw.js` — `getReconciledSandboxGatewayState()` gateway recovery logic intact
- [ ] `bin/nemoclaw.js` — `syncSandboxGithubTokenEnv()` GitHub token sync intact
- [ ] `bin/nemoclaw.js` — WSL2 dashboard URL and onboard fixes intact
- [ ] `scripts/nemoclaw-start.sh` — `ensure_agent_webchat_sessions()` present
- [ ] `scripts/nemoclaw-start.sh` — `agents-overlay.json` merge logic present
- [ ] `scripts/nemoclaw-start.sh` — bounded probe timeouts (`--max-time`) present
- [ ] `scripts/nemoclaw-start.sh` — background launch guard (no foreground block) present

#### Medium Conflict Risk

- [ ] Fork-specific tests still present in `test/` (discord-bridge, backup-restore, turn-orchestrator, etc.)
- [ ] `Dockerfile.base` — pinned openclaw version and update suppression preserved

#### Docker

- [ ] `docker build -f Dockerfile.base .` succeeds (if Dockerfile changed)
- [ ] `docker build .` succeeds (if Dockerfile changed)

## Post-merge Smoke Test (optional but recommended)

- [ ] `nemoclaw the-crucible status` — sandbox reports healthy
- [ ] `nemoclaw the-crucible backup` — backup completes
- [ ] Send a test message through the agent
