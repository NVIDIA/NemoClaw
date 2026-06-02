<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Brev Provisioning and Install Reference

Use when the local-first path does not settle the issue and a Brev run is approved. Covers box reuse/provisioning, reset, baseline/latest installs, dependency bootstrap, and `brev exec` footguns.

## Contents

- [Step 7: Reuse or Provision a Brev Box](#step-7-reuse-or-provision-a-brev-box)
- [Step 8: Validate on Baseline, Verify on Latest](#step-8-validate-on-baseline-verify-on-latest)
- [Comprehensive reset](#comprehensive-reset-run-before-each-install)
- [Step 8a: Install reported version](#step-8a-install-reported-version)
- [Step 8a.5: Bootstrap reproducer dependencies](#step-8a5-bootstrap-reproducer-dependencies)
- [Step 8a.5b: Brev exec environment quirks](#step-8a5b-brev-exec-environment-quirks)

---

## Step 7: Reuse or Provision a Brev Box

The skill prefers reuse over provisioning. A pool of `verify-stale-*` boxes (CPU and GPU) can be kept warm; reuse the matching one if available, otherwise provision.

```bash
# Auth + install URL already verified by Step 6.5 — no need to re-check or auto-login here.

# Determine class from Step 5: "cpu" or "gpu"
INSTANCE_CLASS="cpu"   # or "gpu"

INSTANCES=$(brev ls --json)

# Look for an existing running verify-stale-* box matching the required class.
# CPU boxes have no .gpu field set; GPU boxes do.
EXISTING=$(echo "$INSTANCES" | jq -r --arg class "$INSTANCE_CLASS" '
  .[]?
  | select(.name | startswith("verify-stale-"))
  | select(.status == "RUNNING")
  | select(($class == "gpu" and (.gpu // "" != ""))
        or ($class == "cpu" and (.gpu // "" == "")))
  | .name' | head -1)

PROVISIONED_NEW=0

if [ -n "$EXISTING" ]; then
  INSTANCE_NAME="$EXISTING"
  echo "Reusing existing verification box: $INSTANCE_NAME"
else
  # Concurrency cap: refuse if 4+ verify-stale-* boxes are already running.
  # Filter on .status to match the reuse query above — counting non-running boxes
  # would falsely block provisioning when prior boxes are stopped but not deleted.
  RUNNING=$(echo "$INSTANCES" | jq '[.[]? | select(.name | startswith("verify-stale-")) | select(.status == "RUNNING")] | length')
  if [ "$RUNNING" -ge 4 ]; then
    echo "ERROR: 4 verify-stale boxes already running. Wait for one to finish or reuse."
    exit 1
  fi

  INSTANCE_NAME="verify-stale-${ISSUE_NUMBER}-$(date +%s)"

  if [ "$INSTANCE_CLASS" = "gpu" ]; then
    # brev create auto-selects the cheapest GPU meeting the defaults
    # (>=20GB VRAM, >=500GB disk, compute >=8.0). Override with --type if needed.
    brev create "$INSTANCE_NAME"
  else
    # CPU case: pick the cheapest stoppable Linux SKU at runtime so the skill doesn't rot when
    # SKUs change. Bias the floor by reproducer-implied memory needs — the cheapest 2 GB SKU
    # cannot load a 4.8 GiB Ollama probe, and onboard fails at provider validation before any
    # sandbox-creation code runs. Surfaced during the #2007 e2e run (wasted ~25 min on a 2 GB
    # box that couldn't load `nemotron-3-nano:4b`).
    #
    # Memory floor heuristic:
    #   - Reproducer references Ollama or vLLM or names a model tag (e.g. `nemotron-3-nano:4b`,
    #     `llama3:8b`)        -> floor 16 GB (covers ~5 GB model + sandbox + gateway overhead).
    #   - Reproducer touches sandbox onboarding without a local model server   -> floor 8 GB.
    #   - Pure CLI-surface bug (no sandbox, no model)                          -> floor 4 GB.
    # Override the auto-pick by exporting VERIFY_STALE_CPU_TYPE if the team has hard preferences.
    CPU_RAM_FLOOR=${CPU_RAM_FLOOR:-8}
    CPU_TYPE=${VERIFY_STALE_CPU_TYPE:-$(brev search cpu --sort price --json \
      | jq -r --argjson floor "$CPU_RAM_FLOOR" \
          '[.[] | select(.stoppable == true and .ram_gb >= $floor)] | .[0].type // empty')}
    [ -n "$CPU_TYPE" ] || { echo "ERROR: no stoppable CPU SKU with >= ${CPU_RAM_FLOOR} GB RAM"; exit 1; }
    brev create "$INSTANCE_NAME" --type "$CPU_TYPE"
  fi

  PROVISIONED_NEW=1
fi

# Cleanup runs on success, error, and SIGINT.
# Delete only what we provisioned. Reused boxes stay warm for next time.
# `brev delete` is non-interactive by default — there is no --yes flag, and passing one errors.
echo ">>> Brev instance: $INSTANCE_NAME (provisioned_new=$PROVISIONED_NEW; manual cleanup: brev delete $INSTANCE_NAME)"
trap '[ "$PROVISIONED_NEW" = "1" ] && brev delete "$INSTANCE_NAME" >/dev/null 2>&1 || true' EXIT
```

Wallclock cap per verification: **60 minutes** default. The cap accommodates two full install passes (baseline + latest), comprehensive resets between them, and any reproducer dependency bootstrapping (Step 8a.5) — most of which run sequentially against a single Brev box. Bugs that genuinely require more than an hour to manifest fall out of v1 scope; if a provisioned box isn't ready in time, abort and treat as an infra failure (Step 11).

The previous design had a 25-min default with a 60-min extension for time-sensitive bugs (`memory leak`, `over time`, etc.). That split optimised for the wrong constraint — most issues fit comfortably under 60 min, and the keyword-based extension forced re-runs whenever a real install or bootstrap took longer than the optimistic 25-min budget. Single 60-min cap removes that paper cut.

---

## Step 8: Validate on Baseline, Verify on Latest

Two-pass design.

- **Baseline pass (8a–8c):** install the **reported version**, run the reproducer, confirm it actually exposes the bug as described. This is the gate that proves the script is real.
- **Latest pass (8d):** install **latest**, run the validated reproducer. This is what the confidence score is built on.

Without the baseline gate, a clean run on latest is ambiguous: maybe the bug really got fixed, maybe the script was never capable of triggering it. The baseline disambiguates.

### Comprehensive reset (run before each install)

NemoClaw spawns OpenShell sandboxes (containers), runtime services, and listening processes. A naive `rm -rf ~/.nemoclaw` doesn't clean those — the latest install would inherit baseline state and contaminate the result. Use this fuller reset between installs:

```bash
RESET=$(cat <<'SCRIPT'
nemoclaw destroy --all --force 2>/dev/null || true
# Anchor pkill patterns to "/nemoclaw" / "/openshell" path components so the kill doesn't
# match unrelated processes that happen to mention these strings (including the agent
# harness running this skill if its working dir contains the word).
pkill -9 -f '/nemoclaw([[:space:]]|$)' 2>/dev/null || true
pkill -9 -f '/openshell([[:space:]]|$)' 2>/dev/null || true
docker ps -a --filter "name=openshell-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
docker ps -a --filter "name=nemoclaw-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
# Sandbox state lives in ~/.openclaw (default-writable since #2227); ~/.nemoclaw holds CLI state.
# Wipe both so the latest install starts clean.
rm -rf ~/.nemoclaw ~/.openclaw 2>/dev/null
sudo -n rm -f /usr/local/bin/nemoclaw 2>/dev/null || true
sudo -n rm -rf /usr/local/lib/nemoclaw 2>/dev/null || true
for port in 8080 18789 9119; do fuser -k -n tcp $port 2>/dev/null || true; done
true
SCRIPT
)
```

Idempotent — fails silently when there's nothing to clean. Run via `brev exec "$INSTANCE_NAME" "$RESET"` before 8a's install and again before 8d's install.

**Sudo precondition.** All `sudo` invocations use `sudo -n` (non-interactive) so they fail fast instead of hanging on a password prompt. The skill assumes the Brev image's default user has passwordless sudo configured — Brev's stock images do; custom images may not. If `sudo -n` fails, the binary cleanup is best-effort and a stale `/usr/local/bin/nemoclaw` may persist. The user-local install path (`~/.nemoclaw`) is fully reset regardless.

### Step 8a: Install reported version

The installer accepts the target ref via the `NEMOCLAW_INSTALL_TAG` env var (verified against `install.sh` source — defaults to `latest` if unset). It is **not** a `--version` flag.

```bash
brev exec "$INSTANCE_NAME" "$RESET"

# Pass the provider env vars through so install.sh's bundled `[3/3] Onboarding` step
# doesn't fall back to the default `build` (NIM) provider — which requires NVIDIA_API_KEY
# and otherwise fails the install with a misleading error. When NEMOCLAW_PROVIDER=ollama
# (the common case), the bundled onboard uses the local Ollama we set up in Step 8a.5
# and either succeeds (ideal) or fails on a real Dockerfile/sandbox-build issue (which
# is what we want to detect). Pass NVIDIA_API_KEY only if the maintainer provided one
# at Step 5's prompt.
# Read NVIDIA_API_KEY from ~/.nvidia-api-key on the BOX (not from this shell's argv).
# The Step 5 propagation block already brev-copy'd the key file with 600 perms.
brev exec "$INSTANCE_NAME" "
  if [ -f ~/.nvidia-api-key ]; then export NVIDIA_API_KEY=\$(cat ~/.nvidia-api-key); fi
  NEMOCLAW_INSTALL_TAG=$REPORTED_VERSION \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_PROVIDER=${NEMOCLAW_PROVIDER:-ollama} \
    NEMOCLAW_MODEL=${NEMOCLAW_MODEL:-nemotron-3-nano:4b} \
    NEMOCLAW_SANDBOX_NAME=verify-stale-install \
    bash -c 'curl -fsSL $INSTALL_URL | bash'
" || BASELINE_INSTALL_FAILED=1

# Verify the resolved install version matches the requested version. This guards against the
# `VAR=val curl ... | bash` shell-scoping footgun where the env var binds to curl, not the
# downstream bash, and the install silently falls through to "latest". Surfaced during a
# rot-debugging investigation where v0.0.36 was silently installed when v0.0.26 was requested
# and several minutes of "convincing" output ran before anyone noticed. Always print the
# resolved state, never trust the requested state.
RESOLVED=$(brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" 2>&1 | tail -1)
echo "[verify-stale] baseline requested: $REPORTED_VERSION; resolved: $RESOLVED"
case "$RESOLVED" in
  *"$REPORTED_VERSION"*) ;;  # match — proceed
  *)
    echo "ERROR: baseline install resolved to '$RESOLVED' but $REPORTED_VERSION was requested."
    echo "  Common cause: env-var scoping in the install command. Verify the env vars are on"
    echo "  the BASH side of the curl|bash pipe, not the curl side. Setting"
    echo "  BASELINE_INSTALL_FAILED=1 to prevent verifying against the wrong version."
    BASELINE_INSTALL_FAILED=1
    ;;
esac

# The bundled onboard creates a sandbox name we don't want carrying through to the reproducer.
# Use a hyphen-only name (NemoClaw's name validator rejects underscores). Destroy it so the
# reproducer starts from a clean state.
brev exec "$INSTANCE_NAME" "sg docker -c 'nemoclaw destroy --all --force 2>/dev/null || true'"
```

If install fails (old releases rot — installer URLs, deps, OS images all drift over time, or the in-image Dockerfile patch step asserts against a code shape that's since changed), set `BASELINE_INSTALL_FAILED=1` and **skip 8b/8c**, going straight to 8d. Note "baseline-install-skipped" or "baseline-build-skipped" in the final comment depending on which phase rotted. Step 9's scoring rule handles the degraded mode (cap at 84).

**The reproducer's own `nemoclaw onboard` (Step 8b) must pass `--fresh`.** If install.sh's bundled onboard was in an in-progress or failed state when we destroyed the install sandbox, the reproducer's onboard would error with `Previous onboarding session failed. Re-run with --fresh to discard it`. `--fresh` ensures a clean start.

### Step 8a.5: Bootstrap reproducer dependencies

Brev's stock CPU images ship with NemoClaw installable but not the broader ecosystem the reproducer may need — local model servers (Ollama, vLLM), inference providers, third-party CLIs. **Default to maximum faithfulness: install the actual dependency the reporter used rather than substituting a stub.** Substituting trades faithfulness for speed; that trade is rarely worth it on a 60-min budget, and it almost always introduces a confound that makes the verdict less trustworthy.

**When to bootstrap (not substitute):**

- The reproducer references a specific model/server runtime (`NEMOCLAW_PROVIDER=ollama`, `NEMOCLAW_PROVIDER=vllm`, etc.).
- The reproducer references a specific model name with a tag (`nemotron-3-nano:4b`, `llama3:8b`, etc.).
- The reporter's environment in the issue body shows a configured provider (e.g., `OpenShell CLI: 0.0.26` plus an Ollama running on host).

**When to substitute (with -30 penalty):**

- Provider requires an API key the skill cannot safely supply (NIM, OpenAI, Anthropic, etc.). Stubbing a key won't pass validation faithfully and a real key shouldn't sit in a verify-stale run. Apply the -30 penalty (treat as synth-repro per Step 8b) and document the substitution in the comment.
- The bug is *provably* independent of the dependency (e.g., a CLI argument-parsing bug that errors before any provider runs). Note this explicitly in the comment.

**Canonical bootstraps:**

```bash
# Ollama + a specific model.
# The Ollama installer registers a systemd service (`ollama.service`) so the
# daemon survives between brev exec calls.
brev exec "$INSTANCE_NAME" "curl -fsSL https://ollama.com/install.sh | sh"
brev exec "$INSTANCE_NAME" "sudo systemctl start ollama && sleep 3"
brev exec "$INSTANCE_NAME" "ollama pull <model>"
brev exec "$INSTANCE_NAME" "ollama list"   # confirm before continuing
```

```bash
# vLLM + a model (HuggingFace-hosted).
brev exec "$INSTANCE_NAME" "pip install --quiet vllm"
brev exec "$INSTANCE_NAME" "nohup python -m vllm.entrypoints.openai.api_server --model <model> --host 127.0.0.1 --port 8000 >/var/log/vllm.log 2>&1 &"
brev exec "$INSTANCE_NAME" "sleep 30 && curl -fsS http://127.0.0.1:8000/v1/models"
```

Bootstrap **once before Step 8b's baseline run** and reuse for Step 8d's latest run. Don't reset Ollama/vLLM state between baseline and latest in the comprehensive reset — model downloads are expensive and unrelated to the NemoClaw install. Adjust the reset script to skip these external services explicitly if needed.

**If bootstrap fails** (network issue pulling the model, service won't start, etc.), this is an infra failure — abort to Step 11. Do not silently substitute; the user opted into faithfulness for a reason.

**Ollama coverage table.** Ollama is the default provider for verification runs because it's free, local, and self-hosted. It covers most bug classes faithfully but not all. Use this table to decide whether Ollama is sufficient or whether Step 5's API-key prompt should fire:

| Bug class | Ollama covers? | Notes |
|---|---|---|
| CLI surface (subcommand parsing, flag handling, oclif dispatch) | ✓ Always | Provider not exercised |
| Sandbox structure (build, file permissions, mounts, layout) | ✓ Always | Provider not exercised |
| Networking / policy (port forwards, NAT, egress rules, channels guards) | ✓ Always | Provider not exercised |
| Generic inference flow (does an agent turn complete, does the proxy route correctly) | ✓ Usually | Ollama can fail in the same shape as NIM/Gemini for most flow bugs |
| Provider-specific behavior (`Provider: NVIDIA` symptom, NIM-only error handling, `Provider: Gemini` quirks) | ✗ No | Different code paths; substitution doesn't exercise the bug |
| Model-specific behavior (`gemini-flash-3-preview` doesn't handle prompt X, `nemotron-3-nano:4b` works fine) | ✗ No | Wrong model = wrong outputs |
| Ollama-shape-specific (#2519 "Ollama-local 401" — local-vs-networked Ollama config) | △ Sometimes | A generic Ollama install may or may not reproduce; may need specific configuration |
| Performance / latency on specific silicon | ✗ No | Hardware substitution caveat (Step 10) and Step 8e perf rubric apply |
| Quota / rate-limit / API-key validation | ✗ No | Ollama doesn't have those failure modes |

When the table says ✗ No or △ Sometimes, Step 5's API-key prompt fires. When it says ✓, proceed with Ollama and skip the prompt.

### Step 8a.5b: Brev exec environment quirks

Two non-obvious gotchas surfaced during the #2007 e2e run that every subsequent `brev exec` call has to handle. Encode them once here so reproducer scripts don't have to relearn each time.

**PATH does not include `~/.local/bin` in non-login shells.** `nemoclaw`'s installer drops a shim at `~/.local/bin/nemoclaw` and updates PATH via `~/.bashrc` / `~/.profile`. `brev exec` spawns non-login, non-interactive shells that don't source those files, so a bare `brev exec "$INSTANCE" "nemoclaw --version"` returns `command not found` on a freshly-installed box. Fix: every reproducer script must explicitly export PATH at the top, OR every `brev exec` call must wrap with `bash -lc '...'`.

```bash
# Reproducer scripts: prepend this line.
export PATH="$HOME/.local/bin:$PATH"

# Or equivalently when calling brev exec ad-hoc:
brev exec "$INSTANCE" "bash -lc 'nemoclaw --version'"
```

**Docker group requires `sg docker -c '...'` after `usermod -aG`.** Adding the user to the `docker` group (`sudo usermod -aG docker ubuntu`) takes effect for new login sessions, but `brev exec` calls in the same Brev session keep the old gid. The reproducer's `nemoclaw onboard` will fail with `permission denied while connecting to /var/run/docker.sock` unless the call runs in a subshell with the docker group active.

```bash
# Reproducer execution: wrap with sg docker.
brev exec "$INSTANCE" "sg docker -c 'bash ~/reproducer.sh'"
```

Both patterns appear in the canonical setup script committed alongside the skill (or are encoded in your reproducer wrapper). Don't rely on the user discovering them mid-run.

**`openshell sandbox exec` argument-order footgun.** When the reproducer needs to run a command *inside* the sandbox (channels-guard checks, in-sandbox file inspection, etc.), the correct non-interactive form uses `-n <name>` and a `--` separator:

```bash
# Correct:
openshell sandbox exec -n ai -- bash -c 'source /sandbox/.bashrc; openclaw channels add telegram; echo "EXIT=$?"'

# Wrong (silently auto-detects sandbox by "last used", stuffs the leftover positional
# `ai` into bash's $0, prints "/bin/bash: line 1: ai: command not found" — the
# reproducer appears to fail but actually never ran inside the sandbox at all):
openshell sandbox exec ai bash -c '...'
```

Issue #2592's first run hit this — wasted ~15 min before the maintainer noticed. Always use the `-n <name> -- <cmd>` form when the reproducer touches in-sandbox commands.

**`brev exec` SSH-drop re-execution guard.** Brev's CLI silently retries from the top when the SSH connection drops mid-run, producing two parallel reproducer executions (we hit this on #2592 — one onboard process clobbered another's state, and both got billed). Use a sentinel file in the reproducer wrapper to make the script idempotent:

```bash
# At the top of the reproducer wrapper script:
SENTINEL=~/.verify-stale-running
if [ -f "$SENTINEL" ]; then
  echo "ERROR: another verify-stale run is in progress (sentinel: $SENTINEL)."
  echo "       If you're sure no other run is active, rm $SENTINEL and re-invoke."
  exit 1
fi
trap 'rm -f "$SENTINEL"' EXIT
touch "$SENTINEL"
```

The sentinel survives an SSH drop because it lives on the Brev box's filesystem; the trap removes it on script exit. A second `brev exec` invocation that tries to retry from the top will hit the sentinel and bail instead of double-running.
