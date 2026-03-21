# NemoClaw Comprehensive Security Audit — 2026-03-22

Automated security audit of the full NemoClaw codebase (~9,600 LoC) across 10 parallel scan scopes.
Conducted against commit `1dbf82f` (upstream main, synced 2026-03-22).

## Executive Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 3 (+1 tracked) |
| HIGH | 25 |
| MEDIUM | 28 |
| LOW | 16 |
| INFO | 14 |
| **Total** | **87** |

After deduplication of findings reported by multiple agents, **67 unique actionable findings** remain.

---

## CRITICAL Findings (3 new + 1 tracked)

### C-1: Migration copies ALL host credentials into sandbox — TRACKED BY PR #156

- **Location**: `nemoclaw/src/commands/migration-state.ts:587`
- **Description**: `createSnapshotBundle()` copies the entire `~/.openclaw` directory — including `auth-profiles.json` with live API keys, GitHub PATs, npm tokens — verbatim into the sandbox. The fix (`sanitizeCredentialsInBundle()`) exists in PR #156, rebased and ready for review.
- **Status**: **Already addressed** — fix is in PR #156 (`security/sandbox-credential-exposure-and-blueprint-bypass`), pending merge.

### C-2: CHAT_UI_URL Python code injection in Dockerfile

- **Location**: `Dockerfile:97-98`
- **Description**: Docker build-arg `CHAT_UI_URL` interpolated directly into `RUN python3 -c "..."` string. A crafted URL like `http://x'; import subprocess; subprocess.run(['id'])#` injects arbitrary Python.
- **Impact**: Arbitrary code execution at image build time; can exfiltrate `NVIDIA_API_KEY`.
- **Fix**: Use `ENV` + `os.environ.get()` inside Python instead of build-arg interpolation.

### C-3: Telegram & Discord enabled in baseline sandbox policy (data exfiltration channels)

- **Location**: `nemoclaw-blueprint/policies/openclaw-sandbox.yaml:161-200`
- **Description**: Both messaging APIs are always-on with no `binaries:` restriction. Any process in the sandbox can POST arbitrary data to attacker-controlled Telegram bots or Discord webhooks.
- **Impact**: Unconditional data exfiltration from every sandbox.
- **Fix**: Remove `telegram` and `discord` from baseline; they already exist as opt-in presets.

### C-4: Snapshot manifest path traversal — arbitrary host filesystem write

- **Location**: `migration-state.ts:662-692`
- **Description**: `restoreSnapshotToHost()` reads `manifest.stateDir` from `snapshot.json` (no validation) and uses it as a write target. A tampered manifest can overwrite arbitrary files.
- **Impact**: Arbitrary host filesystem write; potential privilege escalation.
- **Fix**: Validate `manifest.stateDir` and `manifest.configPath` are within `~/.nemoclaw/` before write operations.

---

## HIGH Findings (25) — Top Priority

### Network Policy & Sandbox

| # | Finding | Location | Fix |
|---|---------|----------|-----|
| H-1 | `github` baseline uses `access: full` — write access to all repos | `openclaw-sandbox.yaml:89-100` | Replace with explicit read-only `rules:` |
| H-2 | `npm_registry` baseline allows `PUT` (publish) | `openclaw-sandbox.yaml:149-158` | Restrict to `GET` only |
| H-3 | Telegram path `/bot*/**` — any bot token usable as exfil channel | `openclaw-sandbox.yaml:172` | Remove from baseline; restrict in preset |
| H-4 | Jira preset uses `*.atlassian.net` wildcard — cross-tenant | `presets/jira.yaml:12` | Require tenant-specific subdomain |
| H-5 | HuggingFace preset allows `POST /**` with no binary restriction | `presets/huggingface.yaml:18-34` | Add `binaries:` and split read/write |
| H-6 | Interactive onboard "list" path skips preset allowlist check | `onboard.js:896-902` | Apply `knownPresets.has(name)` validation |

### Command Injection & Shell Safety

| # | Finding | Location | Fix |
|---|---------|----------|-----|
| H-7 | `NEMOCLAW_GPU` env var — newline bypasses `shellQuote()` | `nemoclaw.js:107,131` | Validate against `^[a-z0-9:._-]+$` |
| H-8 | `sandboxName` uses double-quotes instead of `shellQuote()` | `onboard.js:190,420,439,497,515` | Replace with `shellQuote()` |
| H-9 | `runCapture()` uses `execSync` (no argv-safe variant) | `runner.js:48` | Add `spawnCapture()` with argv array |
| H-10 | `isRepoPrivate()` interpolates param into `execSync` shell string | `credentials.js:86` | Use `execFileSync("gh", [...])` |
| H-11 | Preset name not validated against allowlist before `applyPreset()` | `nemoclaw.js:331-337` | Check `allPresets` before calling |
| H-12 | `walkthrough.sh` — `$NVIDIA_API_KEY` unquoted in tmux command | `walkthrough.sh:88` | Export into tmux session env |

### Credential Exposure

| # | Finding | Location | Fix |
|---|---------|----------|-----|
| H-13 | API key visible in `/proc`/`ps aux` via CLI argument | `onboard.js:718`, `nemoclaw.js:87` | Pass via `opts.env` to `spawnSync` |
| H-14 | Error logging can echo credential-containing command prefix | `runner.js:25,40` | Redact `--credential` in log output |
| H-15 | Telegram bridge exports `NVIDIA_API_KEY` into agent env | `telegram-bridge.js:109` | Use credential file or proxy |
| H-16 | Telegram bridge open by default without `ALLOWED_CHAT_IDS` | `telegram-bridge.js:35-37` | Make `ALLOWED_CHAT_IDS` mandatory |

### Container & Supply Chain

| # | Finding | Location | Fix |
|---|---------|----------|-----|
| H-17 | NIM container bound to `0.0.0.0:8000` — LAN-exposed, no auth | `nim.js:141-143` | Bind to `127.0.0.1` only; add `--cap-drop ALL` |
| H-18 | NIM images pinned by `:latest` tag — no digest verification | `nim-images.json` | Pin by `@sha256:<digest>` |
| H-19 | All GitHub Actions pinned to mutable tags, not SHAs | All 6 workflow files | Pin to full commit SHA |
| H-20 | `npm install` instead of `npm ci` in PR workflow | `pr.yaml:44,63,68` | Replace with `npm ci` |
| H-21 | `docs-preview-pr.yaml` has `contents: write` on PR-triggered workflow | `docs-preview-pr.yaml:21-23` | Scope to deploy job only |
| H-22 | `DOCKER_HOST` env var trusted unconditionally — daemon redirection | `platform.js:71-74` | Validate `unix://` or `tcp://127.0.0.1` only |

### Migration & Snapshot

| # | Finding | Location | Fix |
|---|---------|----------|-----|
| H-23 | `cpSync` preserves symlinks — sandbox escape vector | `migration-state.ts:476` | Add symlink target validation or `dereference: true` |
| H-24 | Python `shutil.copytree` follows symlinks — captures host files | `snapshot.py:39,98` | Pass `symlinks=True` |
| H-25 | `--run-id` path traversal in `runner.py` | `runner.py:261,277` | Validate against strict regex |

---

## MEDIUM Findings (28)

| # | Finding | Location |
|---|---------|----------|
| M-1 | Sentry.io: `method: "*"` with unclear binary restriction | `openclaw-sandbox.yaml:61-64` |
| M-2 | Landlock `best_effort` — silent no-op on older kernels | `openclaw-sandbox.yaml:39-40` |
| M-3 | YAML policy merge is text-based — duplicate keys shadow baseline | `policies.js:124-170` |
| M-4 | Docker preset allows `POST` to registries — push without restriction | `presets/docker.yaml:17-35` |
| M-5 | Outlook preset `POST /**` to Graph API — full M365 access | `presets/outlook.yaml:17-19` |
| M-6 | Slack preset `hooks.slack.com` — unrestricted webhook posting | `presets/slack.yaml:28-35` |
| M-7 | Credentials stored in plaintext JSON — no encryption at rest | `credentials.js:21-26` |
| M-8 | `HOME` fallback to `/tmp` creates world-readable credential path | `credentials.js:9` |
| M-9 | GitHub token stored from `gh auth` without user consent | `credentials.js:100-105` |
| M-10 | `write-auth-profile.py` TOCTOU — file created before `chmod` | `write-auth-profile.py:4,13` |
| M-11 | Deploy `.env` persists on remote VM with all secrets | `nemoclaw.js:156-173` |
| M-12 | `--no-verify` disables TLS for cloud inference endpoint | `onboard.js:723,742,762` |
| M-13 | `shellQuote()` does not protect against newline injection | `runner.js:65-67` |
| M-14 | `.env` on remote host — no `chmod 600`, not deleted after setup | `nemoclaw.js:169` |
| M-15 | `setup.sh` passes API key unquoted in double-quoted string | `setup.sh:136` |
| M-16 | Health-check endpoint polled without authentication | `nim.js:155,189` |
| M-17 | `sudo -E` inherits entire env (including secrets) to root | `nemoclaw.js:87` |
| M-18 | `blueprint.yaml` digest field is empty — no integrity check | `blueprint.yaml:7` |
| M-19 | `pr-limit.yaml` user-controlled `AUTHOR` in `::error::` directive | `pr-limit.yaml:26,38` |
| M-20 | `docs-to-skills.py` output path not bounded — directory traversal | `docs-to-skills.py:824,837` |
| M-21 | Snapshot directories created world-readable (default umask) | `migration-state.ts:585`, `snapshot.py:35` |
| M-22 | `CREDENTIAL_FIELDS` set is incomplete — misses OAuth fields | unmerged PR #156 |
| M-23 | `removeAuthProfileFiles` scoped only to `agents/` subtree | unmerged PR #156 |
| M-24 | `sandboxes.json` registry deserialized without schema validation | `registry.js:14,26` |
| M-25 | `resolveOpenshell` trusts binary on execute-permission only | `resolve-openshell.js:19-46` |
| M-26 | `StrictHostKeyChecking=no` on all deploy SSH/SCP operations | `nemoclaw.js:141-186` |
| M-27 | Telegram bridge — no rate limiting, sequential DoS | `telegram-bridge.js:160-224` |
| M-28 | SSH key material left in `/tmp` on unclean shutdown | `telegram-bridge.js:101-103` |

---

## Immediate Actions Taken

1. **`.gitignore` updated**: Added `DRAFT-*.md` pattern to prevent accidental commit of the Intigriti disclosure draft (`DRAFT-intigriti-migration-cred.md`) found on disk.

---

## Recommended PR Sequence

### PR 1: Critical — Baseline policy hardening (C-3)
Remove `telegram` and `discord` from baseline `openclaw-sandbox.yaml`. Restrict `github` and `npm_registry` to read-only.

### PR 2: Critical — Dockerfile injection fix (C-2)
Replace build-arg interpolation with `ENV` + `os.environ.get()`.

### PR 3: Critical — Snapshot manifest validation (C-4)
Add `isWithinRoot` checks on manifest paths. Create snapshot dirs with `mode: 0o700`.

### PR 4: High — Shell safety hardening (H-7 through H-12)
Replace double-quote interpolation with `shellQuote()`. Validate env vars. Add `spawnCapture()`.

### PR 5: High — Credential exposure fixes (H-13 through H-16)
Pass credentials via `opts.env`. Redact in error logs. Make `ALLOWED_CHAT_IDS` mandatory.

### PR 6: High — Container security (H-17, H-18, H-22)
Bind NIM to loopback. Pin images by digest. Validate `DOCKER_HOST`.

### PR 7: High — CI/CD supply chain (H-19 through H-21)
Pin Actions to SHA. Replace `npm install` with `npm ci`. Scope workflow permissions.

### PR 8: High — Symlink and path traversal (H-23 through H-25)
Validate symlink targets. Fix Python copytree. Guard `--run-id`.

---

## Methodology

10 parallel security audit agents scanned the following scopes:

| Scope | Files | Findings |
|-------|-------|----------|
| CLI entry & runner | `bin/nemoclaw.js`, `bin/lib/runner.js` | 15 |
| Credential handling | `credentials.js`, `onboard.js`, `write-auth-profile.py` | 13 |
| Network policies | `policies.js`, sandbox YAML, all presets | 19 |
| Install scripts | `install.sh`, all `scripts/*.sh` | 24 |
| Migration & snapshot | `migration-state.ts`, `state.ts`, `snapshot.py` | 15 |
| Inference & NIM | `inference-config.js`, `local-inference.js`, `nim.js` | 14 |
| Telegram bridge | `telegram-bridge.js`, `slash.ts` | 10 |
| Platform & registry | `platform.js`, `preflight.js`, `registry.js` | 15 |
| Test coverage gaps | All `test/*.test.js`, e2e tests | 14 |
| CI/CD & config | All workflows, `blueprint.yaml`, `docs-to-skills.py` | 16 |
