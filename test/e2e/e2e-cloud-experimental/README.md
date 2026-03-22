# e2e-cloud-experimental — sandbox case suite

Case scripts run **after** Phase 3 (install + onboard). The main script runs every **`checks/*.sh`** in sorted order, then **Phase 5b** POSTs **`/v1/chat/completions`** on `https://inference.local` from inside the sandbox and expects **PONG** (model = `CLOUD_EXPERIMENTAL_MODEL`; host needs **`python3`** to parse JSON). **Phase 5c** validates **`.agents/skills/*/SKILL.md`** on the repo checkout and checks **`/sandbox/.openclaw`** (and **`openclaw.json`**) inside the sandbox over SSH; if the migrated snapshot had no host skills directory, **`/sandbox/.openclaw/skills`** may be missing — the suite records an honest **SKIP** for that sub-check (not a PASS). **Phase 5d** injects `skill-smoke-fixture` into the sandbox and runs one `openclaw agent` turn that must return token `SKILL_SMOKE_VERIFY_K9X2` from that skill file. **Phase 6** is final cleanup. Set `RUN_E2E_CLOUD_EXPERIMENTAL_SKIP_FINAL_CLEANUP=1` (legacy: `RUN_SCENARIO_A_SKIP_FINAL_CLEANUP=1`) to leave the sandbox up for debugging.

To run the inject + dialogue verification directly: **`NVIDIA_API_KEY=nvapi-... SANDBOX_NAME=... SKILL_ID=skill-smoke-fixture bash test/e2e/e2e-cloud-experimental/features/skill/verify-sandbox-skill-via-agent.sh`** (after `test/e2e/e2e-cloud-experimental/features/skill/add-sandbox-skill.sh`).

Scripts under **`skip/`** are **not** executed by the main suite — run them manually when you want those checks (e.g. flaky network policy / egress).

## Ready checks (`ready/`, sorted by filename)

| Script | What it checks |
|--------|----------------|
| `01-onboard-completion.sh` | `nemoclaw list` / `status`, `openshell inference get` + expected model |
| `02-inference-local-http.sh` | SSH into sandbox → `GET https://inference.local/v1/models` → HTTP 200 |
| `03-security-checks.sh` | Host security checks (e.g. VDR3 #13: `NVIDIA_API_KEY` not in `ps`); extend with more sections in-file |
| `04-nemoclaw-openshell-status-parity.sh` | Bug 5982550: sandbox via `sandbox status --json` or `sandbox list` Ready; inference via `inference get --json` or text (nvidia-nim + model); `nemoclaw list` model matches |

## Opt-in (`skip/` — not run by `test-e2e-cloud-experimental.sh`)

| Script | What it checks |
|--------|----------------|
| `05-network-policy.sh` | VDR3 #6/#15: `openshell policy get --full` + SSH egress whitelist / blocked URL |

Run manually after onboard, from repo root:

```bash
bash test/e2e/e2e-cloud-experimental/skip/05-network-policy.sh
```

Same env defaults as ready checks (`SANDBOX_NAME`, `CLOUD_EXPERIMENTAL_MODEL`, etc.). Optional: `E2E_CLOUD_EXPERIMENTAL_EGRESS_BLOCKED_URL` if `example.com` is allowlisted.

## Contract

- **Environment** (exported by the main script): `SANDBOX_NAME`, `CLOUD_EXPERIMENTAL_MODEL`, `REPO`, `NVIDIA_API_KEY`
- **Exit code**: `0` = case passed, non-zero = failed (main script stops)
- **Naming**: `NN-short-name.sh` (e.g. `01-onboard-completion.sh`) so order is stable
- **Self-contained**: use `#!/bin/bash` and `set -euo pipefail` (or explicit checks + `exit 1`)

## Adding a case

1. Add `checks/NN-your-check.sh` (next sort order)
2. Do not edit `test-e2e-cloud-experimental.sh` unless you need new env vars — then export them in Phase 3/5 handoff in the main script

## Running a single case

After a successful onboard on this machine, from repo root:

```bash
bash test/e2e/e2e-cloud-experimental/checks/01-onboard-completion.sh
```

`02-inference-local-http.sh` only needs `SANDBOX_NAME` / `NEMOCLAW_SANDBOX_NAME` (default `e2e-cloud-experimental`).

`03-security-checks.sh` needs `NVIDIA_API_KEY` for the current checks; it scans local `ps` only.

`04-nemoclaw-openshell-status-parity.sh` needs **`node` on PATH** (post-install shell). Uses `SANDBOX_NAME` / `CLOUD_EXPERIMENTAL_MODEL` defaults like `01`.

`01-onboard-completion.sh` defaults to sandbox `e2e-cloud-experimental` and model `moonshotai/kimi-k2.5` (same as the main suite). If yours differ:

```bash
export SANDBOX_NAME=my-sandbox
export CLOUD_EXPERIMENTAL_MODEL=nvidia/nemotron-3-super-120b-a12b   # must appear in: openshell inference get
bash test/e2e/e2e-cloud-experimental/checks/01-onboard-completion.sh
```

(Legacy env names `SCENARIO_A_MODEL` / `NEMOCLAW_SCENARIO_A_MODEL` still work in case defaults.)

`REPO` is only needed if a case uses it; `01-onboard-completion.sh` does not.

## Standalone: chat demo only

To verify **`inference.local`** chat completions without running the full suite, use **`../demo-inference-local-chat.sh`** (from `test/e2e/`) after a successful onboard — same SSH + JSON flow as Phase 5b.
