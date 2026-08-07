<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Brev Instance Creation and Install Reference

Use when the isolated local path does not settle the issue and a Brev run is approved. Covers instance reuse or creation, reset, reported-release and newest-release installs, dependency bootstrap, and `brev exec` command constraints.

## Contents

- [Step 7: Reuse or Create a Brev Instance](#step-7-reuse-or-create-a-brev-instance)
- [Step 8: Validate the Reported Release and Verify the Newest Release Tag](#step-8-validate-the-reported-release-and-verify-the-newest-release-tag)
- [Reset](#reset-run-before-each-install)
- [Step 8a: Install reported version](#step-8a-install-reported-version)
- [Step 8a.5: Bootstrap reproducer dependencies](#step-8a5-bootstrap-reproducer-dependencies)
- [Step 8a.5b: Brev exec environment quirks](#step-8a5b-brev-exec-environment-quirks)

---

## Step 7: Reuse or Create a Brev Instance

Reuse a matching `verify-stale-*` instance only when it has no active verification sentinel or registered NemoClaw sandbox. A credential-bearing run must create a dedicated instance instead of reusing one. Before remote execution or a cost-bearing action, present the exact instance, type, hourly price, 60-minute execution budget, 120-second cleanup grace, third-party-software acceptance, credential plan, and cleanup action. For a credential-bearing run, the plan must approve instance deletion and immediate credential rotation if deletion cannot be confirmed. Wait for explicit maintainer approval.

```bash
# Auth + install URL already verified by Step 6.8 — no need to re-check or auto-login here.

# Determine class from Step 5: "cpu" or "gpu"
INSTANCE_CLASS="cpu"   # or "gpu"

normalize_brev_instances() {
  jq -c '
    if type == "array" then .
    elif type == "object" and has("workspaces") and .workspaces == null then []
    elif type == "object" and (.workspaces | type) == "array" then .workspaces
    else error("unexpected brev ls --json shape") end
    | map(. + {
        verifyStaleName: ((.name // .workspaceName // .instanceName // "") | tostring)
      })'
}

if ! RAW_INSTANCES=$(brev ls --json); then
  echo "ERROR: could not read Brev instance inventory"
  exit 1
fi
if ! INSTANCES=$(printf '%s' "$RAW_INSTANCES" | normalize_brev_instances); then
  echo "ERROR: Brev instance inventory has an unsupported JSON shape"
  exit 1
fi
unset RAW_INSTANCES

# Look for an existing running verify-stale-* instance matching the required class.
# CPU instances have no .gpu field set; GPU instances do.
EXISTING=$(printf '%s' "$INSTANCES" | jq -r --arg class "$INSTANCE_CLASS" '
  .[]?
  | select(.verifyStaleName | startswith("verify-stale-"))
  | select(.status == "RUNNING")
  | select(($class == "gpu" and (.gpu // "" != ""))
        or ($class == "cpu" and (.gpu // "" == "")))
  | .verifyStaleName' | head -1)

# Do not place a provider credential on a reused instance.
[ -z "${PROVIDER_CREDENTIAL_ENV:-}" ] || EXISTING=""

PROVISIONED_NEW=0

if [ -n "$EXISTING" ]; then
  INSTANCE_NAME="$EXISTING"
  echo "Candidate for reuse: $INSTANCE_NAME"
  echo "The approved plan will atomically acquire the instance, then verify that ~/.verify-stale-running is absent and 'nemoclaw list --json' has no sandboxes before reuse."
else
  # Concurrency cap: count instances that are not explicitly stopped.
  ACTIVE=$(printf '%s' "$INSTANCES" | jq '[.[]? | select(.verifyStaleName | startswith("verify-stale-")) | select(.status != "STOPPED")] | length')
  if [ "$ACTIVE" -ge 2 ]; then
    echo "ERROR: 2 verify-stale instances are already active. Wait, reuse, or remove a stale allocation."
    exit 1
  fi

  INSTANCE_NAME="verify-stale-${ISSUE_NUMBER}-$(date +%s)-$$"
  if printf '%s' "$INSTANCES" | jq -e --arg name "$INSTANCE_NAME" 'any(.[]?; .verifyStaleName == $name)' >/dev/null; then
    echo "ERROR: refusing to create or remove a pre-existing instance named $INSTANCE_NAME"
    exit 1
  fi

  if [ "$INSTANCE_CLASS" = "gpu" ]; then
    # brev create auto-selects the cheapest GPU meeting the defaults
    # (>=20GB VRAM, >=500GB disk, compute >=8.0). Override with --type if needed.
    CREATE_ARGS=("$INSTANCE_NAME")
  else
    # CPU case: pick the cheapest stoppable Linux SKU at runtime so the skill doesn't rot when
    # SKUs change. Bias the floor by reproducer-implied memory needs — the cheapest 2 GB SKU
    # cannot load a 4.8 GiB Ollama probe, and onboard fails at provider validation before any
    # sandbox-creation code runs. Surfaced during the #2007 e2e run (wasted ~25 min on a 2 GB
    # instance that couldn't load `nemotron-3-nano:4b`).
    #
    # Memory floor heuristic:
    #   - Reproducer references Ollama or vLLM or names a model tag (e.g. `nemotron-3-nano:4b`,
    #     `llama3:8b`)        -> floor 16 GB (covers ~5 GB model + sandbox + gateway overhead).
    #   - Reproducer touches sandbox onboarding without a local model server   -> floor 8 GB.
    #   - Pure CLI-surface bug (no sandbox, no model)                          -> floor 4 GB.
    # Override the auto-pick by exporting VERIFY_STALE_CPU_TYPE if the team has hard preferences.
    CPU_RAM_FLOOR=${CPU_RAM_FLOOR:-8}
    CPU_ARCH=${INSTANCE_ARCH:-x86_64}
    case "$CPU_ARCH" in x86_64|arm64) ;; *) echo "ERROR: unsupported CPU architecture: $CPU_ARCH"; exit 1 ;; esac
    CPU_TYPE=${VERIFY_STALE_CPU_TYPE:-$(brev search cpu --arch "$CPU_ARCH" --sort price --json \
      | jq -r --argjson floor "$CPU_RAM_FLOOR" \
          '[.[] | select(.stoppable == true and .ram_gb >= $floor)] | .[0].type // empty')}
    [ -n "$CPU_TYPE" ] || { echo "ERROR: no stoppable $CPU_ARCH CPU SKU with >= ${CPU_RAM_FLOOR} GB RAM"; exit 1; }
    CREATE_ARGS=("$INSTANCE_NAME" --type "$CPU_TYPE")
  fi
fi

# STOP. Present the plan and wait for explicit approval here. For a new instance,
# preview the selected type and price with the matching `brev search` result or
# `brev create "${CREATE_ARGS[@]}" --dry-run`. Approval includes creation and
# deletion of this exact instance name. For reused and retained instances, the
# cleanup plan resets NemoClaw state and removes copied credentials, reproducer
# scripts, and verification logs. Approval does not permit retaining a new instance.

# Install cleanup before creation so a partially successful `brev create` cannot
# leave an approved cost running when a later local step fails.
KEEP_INSTANCE=0
VERIFY_STALE_DEADLINE_EPOCH=$(($(date +%s) + 3600))
VERIFY_STALE_RUN_ID="${ISSUE_NUMBER}-$(date +%s)-$$"
REMOTE_STATE_CREATED=0
remaining_seconds() {
  local remaining
  remaining=$((VERIFY_STALE_DEADLINE_EPOCH - $(date +%s)))
  [ "$remaining" -gt 0 ] || { echo "ERROR: 60-minute verification budget expired" >&2; return 1; }
  printf '%s\n' "$remaining"
}
run_with_timeout() {
  local timeout_seconds=$1
  shift
  python3 - "$timeout_seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout_seconds = max(1, int(sys.argv[1]))
process = subprocess.Popen(sys.argv[2:], start_new_session=True)

def terminate() -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

try:
    raise SystemExit(process.wait(timeout=timeout_seconds))
except subprocess.TimeoutExpired:
    terminate()
    print(f"ERROR: command exceeded {timeout_seconds}s wall-clock budget", file=sys.stderr)
    raise SystemExit(124)
except KeyboardInterrupt:
    terminate()
    raise SystemExit(130)
PY
}
run_bounded() {
  local command_budget
  command_budget=$(remaining_seconds) || return 124
  run_with_timeout "$command_budget" "$@"
}
instance_is_absent() {
  local raw current
  raw=$(run_with_timeout 30 brev ls --json) || return 1
  current=$(printf '%s' "$raw" | normalize_brev_instances) || return 1
  printf '%s' "$current" \
    | jq -e --arg name "$INSTANCE_NAME" 'all(.[]?; .verifyStaleName != $name)' >/dev/null
}
cleanup_verification() {
  local cleanup_failed=0
  # The execution budget can be exhausted when cleanup starts. Give control-plane
  # cleanup a separate bounded grace period and report failures.
  if [ "$PROVISIONED_NEW" = "1" ] && [ "$KEEP_INSTANCE" != "1" ]; then
    # Reserve 30 seconds to confirm that the instance is absent.
    run_with_timeout 90 brev delete "$INSTANCE_NAME" >/dev/null 2>&1 || cleanup_failed=1
    instance_is_absent || cleanup_failed=1
  elif [ "$REMOTE_STATE_CREATED" = "1" ]; then
    CLEANUP_COMMAND="
      test \"\$(cat ~/.verify-stale-owner/token 2>/dev/null)\" = \"$VERIFY_STALE_RUN_ID\" || exit 0
      ${RESET:-:}
      rm -rf ~/.verify-stale-evidence
      rm -rf ~/.verify-stale-running
      rm -rf ~/.verify-stale-owner
    "
    run_with_timeout 120 brev exec "$INSTANCE_NAME" "$CLEANUP_COMMAND" >/dev/null 2>&1 \
      || cleanup_failed=1
  else
    # Acquisition can succeed remotely even if SSH drops before acknowledgement.
    # Remove only a lock carrying this run's unique local identifier.
    RELEASE_COMMAND="
      test \"\$(cat ~/.verify-stale-owner/token 2>/dev/null)\" = \"$VERIFY_STALE_RUN_ID\" || exit 0
      rm -rf ~/.verify-stale-owner
    "
    run_with_timeout 120 brev exec "$INSTANCE_NAME" "$RELEASE_COMMAND" >/dev/null 2>&1 \
      || cleanup_failed=1
  fi
  if [ "$cleanup_failed" = "1" ]; then
    echo "ERROR: cleanup was not confirmed for $INSTANCE_NAME; do not reuse this instance" >&2
    if [ "${PROVIDER_CREDENTIAL_COPIED:-0}" = "1" ]; then
      echo "ERROR: rotate $PROVIDER_CREDENTIAL_ENV immediately because provider-key might remain" >&2
    fi
  fi
  cleanup_local_evidence
  [ "$cleanup_failed" = "0" ]
}
trap cleanup_verification EXIT

if [ -z "$EXISTING" ]; then
  PROVISIONED_NEW=1
  if ! run_bounded brev create "${CREATE_ARGS[@]}"; then
    echo "ERROR: instance creation failed or exceeded the approved execution budget"
    exit 1
  fi
fi

# Atomically acquire the instance before inspecting or modifying reusable state.
# Set the token inside the new directory; cleanup removes only a matching token.
ACQUIRE_COMMAND="
  set -eu
  if ! mkdir ~/.verify-stale-owner 2>/dev/null; then
    echo 'ERROR: another verification owns this instance' >&2
    exit 73
  fi
  trap 'rm -rf ~/.verify-stale-owner' EXIT
  umask 077
  printf '%s' '$VERIFY_STALE_RUN_ID' > ~/.verify-stale-owner/token
  trap - EXIT
"
if ! run_bounded brev exec "$INSTANCE_NAME" "$ACQUIRE_COMMAND"; then
  echo "ERROR: could not acquire exclusive ownership of $INSTANCE_NAME"
  exit 1
fi

if [ -n "$EXISTING" ]; then
  # Fail closed when the reusable instance contains state that this run does not own.
  REUSE_CHECK='set -eu
    test ! -e ~/.verify-stale-running
    export PATH="$HOME/.local/bin:$PATH"
    if command -v nemoclaw >/dev/null 2>&1; then
      test "$(nemoclaw list --json | python3 -c '\''import json,sys; print(len(json.load(sys.stdin).get("sandboxes", [])))'\'')" = "0"
    fi'
  if ! run_bounded brev exec "$INSTANCE_NAME" "$REUSE_CHECK"; then
    echo "ERROR: reuse checks failed; no remote verification state will be reset"
    exit 1
  fi
fi

# Keep every remote script and raw log in one owner-only directory so cleanup is
# complete even when a later rubric adds another evidence file.
if ! run_bounded brev exec "$INSTANCE_NAME" 'rm -rf ~/.verify-stale-evidence && mkdir -m 700 ~/.verify-stale-evidence'; then
  echo "ERROR: could not initialize the remote evidence directory"
  exit 1
fi
REMOTE_STATE_CREATED=1

# Cleanup runs on success, error, and SIGINT. Reset verification state and remove
# copied credentials, scripts, logs, and the sentinel from every instance. Delete
# only what this run created; reused instances stay available without run artifacts.
# `brev delete` is non-interactive by default — there is no --yes flag, and passing one errors.
echo ">>> Brev instance: $INSTANCE_NAME (created_by_run=$PROVISIONED_NEW; approved cleanup: reset verification state, remove credentials/scripts/logs, and brev delete $INSTANCE_NAME when created by this run)"
```

Do not set `KEEP_INSTANCE=1` unless the maintainer separately approves the retention cost, names the cleanup owner, and accepts an exact deletion deadline. Before reuse or retention, remove `~/.verify-stale-evidence` and confirm the verification sentinel is absent.

Wall-clock execution budget per verification: **60 minutes** default, measured from the approved create/reuse action. `run_bounded` caps every post-approval local Brev CLI process; phase-specific remote `timeout` calls use the smaller remaining budget. Cleanup gets a separate bounded grace period of up to 120 seconds because deletion still depends on the Brev control plane. The approval plan must disclose that grace and that billing can continue until deletion is acknowledged. Do not start a phase whose required sample plan cannot fit. Bugs that need more than an hour fall out of v1 scope; an expired budget is an infra failure (Step 11), and the cleanup trap still runs.

Check every `run_bounded` result. Status `124` means the local wall-clock wrapper or remote phase timed out; treat it as an infra failure and let the cleanup trap run. Never continue from a failed copy, reset, bootstrap, or transport call using partial state.

The previous design used a 25-minute default and a 60-minute extension for time-sensitive bugs such as `memory leak` and `over time`. The keyword-based extension required a rerun when an install or bootstrap exceeded 25 minutes. One 60-minute execution budget avoids that rerun condition.

---

## Step 8: Validate the Reported Release and Verify the Newest Release Tag

Two-pass design.

- **Reported-release pass (8a–8c):** install the reported release, run the reproducer, and confirm that it exposes the reported symptom.
- **Newest-release pass (8d):** install `$LATEST` as an exact release tag and run the validated reproducer.

Without the reported-release result, a newest-release result without the symptom is inconclusive. The reproducer might never have exposed the reported symptom.

### Reset (run before each install)

NemoClaw starts OpenShell sandboxes, runtime services, and listening processes. `rm -rf ~/.nemoclaw` does not remove those resources. Without the reset below, the newest-release install would inherit reported-release state and invalidate the comparison.

```bash
RESET=$(cat <<'SCRIPT'
export PATH="$HOME/.local/bin:$PATH"
if command -v nemoclaw >/dev/null 2>&1; then
  nemoclaw list --json 2>/dev/null \
    | python3 -c 'import json,sys; [print(item["name"]) for item in json.load(sys.stdin).get("sandboxes", [])]' \
    | while IFS= read -r sandbox; do
        nemoclaw "$sandbox" destroy --force --cleanup-gateway 2>/dev/null || true
      done
fi
# Anchor pkill patterns to "/nemoclaw" / "/openshell" path components so the kill doesn't
# match unrelated processes that happen to mention these strings (including the agent
# harness running this skill if its working dir contains the word).
pkill -9 -f '/nemoclaw([[:space:]]|$)' 2>/dev/null || true
pkill -9 -f '/openshell([[:space:]]|$)' 2>/dev/null || true
docker ps -a --filter "name=openshell-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
docker ps -a --filter "name=nemoclaw-" -q 2>/dev/null | xargs -r docker rm -f 2>/dev/null || true
# Remove CLI, runtime, and OpenShell configuration only after the registered
# sandboxes, gateway processes, and containers above have been retired.
rm -rf ~/.nemoclaw ~/.openclaw ~/.hermes ~/.config/nemoclaw ~/.config/openshell 2>/dev/null
rm -rf ~/.verify-stale-running 2>/dev/null
sudo -n rm -f /usr/local/bin/nemoclaw 2>/dev/null || true
sudo -n rm -rf /usr/local/lib/nemoclaw 2>/dev/null || true
for port in 8080 18789 9119; do fuser -k -n tcp $port 2>/dev/null || true; done
true
SCRIPT
)
```

Idempotent — fails silently when there's nothing to clean. Run via `run_bounded brev exec "$INSTANCE_NAME" "$RESET"` before 8a's install and again before 8d's install.

**Sudo precondition.** All `sudo` invocations use `sudo -n` (non-interactive) so they fail fast instead of hanging on a password prompt. The skill assumes the Brev image's default user has passwordless sudo configured — Brev's stock images do; custom images may not. If `sudo -n` fails, the binary cleanup is best-effort and a stale `/usr/local/bin/nemoclaw` may persist. The user-local install path (`~/.nemoclaw`) is fully reset regardless.

### Step 8a: Install reported version

The installer accepts the target release tag through `NEMOCLAW_INSTALL_TAG`. If both `NEMOCLAW_INSTALL_REF` and `NEMOCLAW_INSTALL_TAG` are unset, the installer uses the maintainer-promoted `lkg` tag. This workflow always sets a `vX.Y.Z` release tag and verifies the installed tag before assigning a verdict. `NEMOCLAW_INSTALL_TAG` is not a `--version` flag.

```bash
if ! run_bounded brev exec "$INSTANCE_NAME" "$RESET"; then
  echo "ERROR: baseline reset failed or exceeded the execution budget"
  exit 1
fi
BASELINE_INSTALL_FAILED=0
RESOLVED_TAG_MISMATCH=0

# Pass the provider env vars through so install.sh's bundled onboarding step
# does not fall back to the default `build` provider. The installer owns any
# provider setup performed during its onboarding step; Step 8a.5 adds only
# dependencies the reviewed reproducer still needs. PROVIDER_CREDENTIAL_ENV is
# allowlisted in Step 5.
CREDENTIAL_EXPORT=""
if [ -n "${PROVIDER_CREDENTIAL_ENV:-}" ]; then
  CREDENTIAL_EXPORT="export $PROVIDER_CREDENTIAL_ENV=\$(cat ~/.verify-stale-evidence/provider-key);"
fi

# Hosted providers require the exact model from the issue or approved plan.
# The default below is valid only for the local Ollama path.
VERIFY_MODEL=${NEMOCLAW_MODEL:-}
if [ "${BUG_PROVIDER:-ollama}" = "ollama" ]; then
  VERIFY_MODEL=${VERIFY_MODEL:-nemotron-3-nano:4b}
fi
[ -n "$VERIFY_MODEL" ] || {
  echo "ERROR: no exact model was supplied for provider ${BUG_PROVIDER:-ollama}; select verify-inconclusive"
  exit 1
}
printf '%s' "$VERIFY_MODEL" | grep -Eq '^[A-Za-z0-9._:/-]+$' || {
  echo "ERROR: model contains characters outside the reviewed allowlist"
  exit 1
}
case "${BUG_PROVIDER:-ollama}" in
  build|gemini|openrouter|openai|anthropic|ollama) ;;
  *) echo "ERROR: provider is not in the reviewed verification allowlist"; exit 1 ;;
esac
case "${NEMOCLAW_AGENT:-openclaw}" in
  openclaw|hermes) ;;
  *) echo "ERROR: agent runtime is not in the reviewed verification allowlist"; exit 1 ;;
esac

INSTALL_TIMEOUT=$(remaining_seconds) || exit 1
if run_bounded brev exec "$INSTANCE_NAME" "
  $CREDENTIAL_EXPORT
  timeout ${INSTALL_TIMEOUT}s env \
    NEMOCLAW_INSTALL_REF= \
    NEMOCLAW_INSTALL_TAG=$REPORTED_VERSION \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_AGENT=${NEMOCLAW_AGENT:-openclaw} \
    NEMOCLAW_PROVIDER=${BUG_PROVIDER:-ollama} \
    NEMOCLAW_MODEL=$VERIFY_MODEL \
    NEMOCLAW_SANDBOX_NAME=verify-stale-install \
    bash -o pipefail -c 'curl -fsSL $INSTALL_URL | bash'
" >"$EVIDENCE_DIR/baseline-install.log" 2>&1; then
  BASELINE_INSTALL_FAILED=0
else
  BASELINE_INSTALL_FAILED=1
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/baseline-install.log" >"$EVIDENCE_DIR/baseline-install.redacted.log"
tail -40 "$EVIDENCE_DIR/baseline-install.redacted.log"

# Always attempt to resolve the installed release tag, including when the installer
# exits after placing the CLI but before onboarding completes.
RESOLVED=$(run_bounded brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" 2>&1 | tail -1)
RESOLVED_SEMVER=$(printf '%s\n' "$RESOLVED" | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | tail -1)
RESOLVED_TAG=""
[ -z "$RESOLVED_SEMVER" ] || RESOLVED_TAG="v${RESOLVED_SEMVER#v}"
echo "[verify-stale] baseline requested: $REPORTED_VERSION; resolved: $RESOLVED"
if [ -z "$RESOLVED_TAG" ] || [ "$RESOLVED_TAG" != "$REPORTED_VERSION" ]; then
  RESOLVED_TAG_MISMATCH=1
  echo "ERROR: resolved release tag '${RESOLVED_TAG:-<unresolved>}' does not match requested release tag $REPORTED_VERSION"
  echo "Do not assign a verdict, score the run, or propose a GitHub comment."
  exit 1
fi

# The bundled onboard creates a sandbox name we do not want carrying through to the reproducer.
if ! run_bounded brev exec "$INSTANCE_NAME" "export PATH=\"\$HOME/.local/bin:\$PATH\"; nemoclaw verify-stale-install destroy --force --cleanup-gateway 2>/dev/null || true"; then
  echo "ERROR: could not remove the baseline installer's verification sandbox"
  exit 1
fi
```

If the baseline install or build fails after the resolved release tag matches `$REPORTED_VERSION`, set `BASELINE_INSTALL_FAILED=1` and select `verify-inconclusive`. Do not verify the newest release tag to infer a fixed verdict. The baseline gate cannot establish that the reviewed reproducer exposed the reported bug. Check this flag before dependency bootstrap or reproducer execution. A missing or different resolved release tag is a hard infrastructure failure, not an inconclusive verdict.

**The reproducer's own `nemoclaw onboard` (Step 8b) must pass `--fresh`.** If the installer's onboarding step left an incomplete session before the verification sandbox was destroyed, the reproducer would report `Previous onboarding session failed. Re-run with --fresh to discard it`. `--fresh` discards that saved session before onboarding starts.

### Step 8a.5: Bootstrap reproducer dependencies

Brev's stock CPU images ship with NemoClaw installable but not the broader ecosystem the reproducer may need — local model servers (Ollama, vLLM), inference providers, third-party CLIs. **Default to maximum faithfulness: install the actual dependency the reporter used rather than substituting a stub.** Substituting trades faithfulness for speed; that trade is rarely worth it on a 60-min budget, and it almost always introduces a confound that makes the verdict less trustworthy.

**When to bootstrap (not substitute):**

- The reproducer references a specific model/server runtime (`NEMOCLAW_PROVIDER=ollama`, `NEMOCLAW_PROVIDER=vllm`, etc.).
- The reproducer references a specific model name with a tag (`nemotron-3-nano:4b`, `llama3:8b`, etc.).
- The reporter's environment in the issue body shows a configured provider (e.g., `OpenShell CLI: 0.0.26` plus an Ollama running on host).

**When substitution cannot establish `fixed-on-latest`:**

- Provider requires a credential the approved run does not supply. Substitution cannot establish a fixed provider-specific bug. Select `verify-inconclusive` and document the mismatch.
- If the reviewed bug path fails before the dependency runs, record that evidence in the comment.

**Canonical bootstraps:**

```bash
# Ollama + a specific model, only when installer onboarding did not already
# provide it. If the issue is Ollama-version-specific, install that exact
# reviewed version rather than using the moving installer URL below.
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s bash -o pipefail -c 'curl -fsSL https://ollama.com/install.sh | sh'" || exit 1
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s bash -c 'sudo systemctl start ollama && sleep 3'" || exit 1
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s ollama pull <model>" || exit 1
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s ollama list" || exit 1   # confirm before continuing
```

```bash
# vLLM + a model (HuggingFace-hosted).
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s python3 -m pip install --quiet 'vllm==<version reported by the issue>'" || exit 1
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s bash -c 'nohup python -m vllm.entrypoints.openai.api_server --model <model> --host 127.0.0.1 --port 8000 >~/.verify-stale-evidence/vllm.log 2>&1 &'" || exit 1
BOOTSTRAP_TIMEOUT=$(remaining_seconds) || exit 1
run_bounded brev exec "$INSTANCE_NAME" "timeout ${BOOTSTRAP_TIMEOUT}s bash -c 'sleep 30 && curl -fsS http://127.0.0.1:8000/v1/models'" || exit 1
```

Bootstrap once before Step 8b's reported-release run and reuse the dependency for Step 8d's newest-release run. Record the exact dependency and model versions. If the dependency itself is implicated, reproduce the reported version. When the issue reports no dependency version, select `verify-inconclusive` or obtain maintainer direction. A dependency version selected at run time is acceptable only when the reviewed bug path is independent of its version, and the plan must state that condition. Do not reset Ollama or vLLM state between release installs because model downloads are expensive and unrelated to the NemoClaw install.

**If bootstrap fails** (network issue pulling the model, service won't start, etc.), this is an infra failure — abort to Step 11. Do not silently substitute; the user opted into faithfulness for a reason.

**Ollama coverage table.** Ollama is the default provider for verification runs because it's free, local, and self-hosted. It covers most bug classes faithfully but not all. Use this table to decide whether Ollama is sufficient or whether Step 5's API-key prompt should fire:

| Bug class | Ollama covers? | Notes |
|---|---|---|
| CLI surface (subcommand parsing, flag handling, oclif dispatch) | ✓ Always | Provider not exercised |
| Sandbox structure (build, file permissions, mounts, layout) | ✓ Always | Provider not exercised |
| Networking / policy (port forwards, NAT, egress rules, channels guards) | ✓ Always | Provider not exercised |
| Generic inference flow (does an agent turn complete, does the proxy route correctly) | ✓ Usually | Ollama can fail in the same shape as NIM/Gemini for most flow bugs |
| Provider-specific behavior (`provider: nvidia` symptom, NIM-only error handling, Gemini-specific quirks) | ✗ No | Different code paths; substitution doesn't exercise the bug |
| Model-specific behavior (`gemini-flash-3-preview` doesn't handle prompt X, `nemotron-3-nano:4b` works fine) | ✗ No | Wrong model = wrong outputs |
| Ollama-shape-specific (#2519 "Ollama-local 401" — local-vs-networked Ollama config) | △ Sometimes | A generic Ollama install may or may not reproduce; may need specific configuration |
| Performance / latency on specific silicon | ✗ No | Hardware substitution caveat (Step 10) and Step 8e perf rubric apply |
| Quota / rate-limit / API-key validation | ✗ No | Ollama doesn't have those failure modes |

When the table says ✗ No or △ Sometimes, Step 5's API-key prompt fires. When it says ✓, proceed with Ollama and skip the prompt.

### Step 8a.5b: Brev exec environment quirks

Two non-obvious gotchas surfaced during the #2007 e2e run that every subsequent `brev exec` call has to handle. Encode them once here so reproducer scripts don't have to relearn each time.

**PATH does not include `~/.local/bin` in non-login shells.** `nemoclaw`'s installer drops a shim at `~/.local/bin/nemoclaw` and updates PATH via `~/.bashrc` / `~/.profile`. `brev exec` spawns non-login, non-interactive shells that don't source those files, so a bare `brev exec "$INSTANCE" "nemoclaw --version"` returns `command not found` on a freshly installed instance. Fix: every reproducer script must explicitly export PATH at the top, OR every `brev exec` call must wrap with `bash -lc '...'`.

```bash
# Reproducer scripts: prepend this line.
export PATH="$HOME/.local/bin:$PATH"

# Or equivalently when calling brev exec ad-hoc:
run_bounded brev exec "$INSTANCE" "bash -lc 'nemoclaw --version'" || exit 1
```

**Docker group requires `sg docker -c '...'` after `usermod -aG`.** Adding the user to the `docker` group (`sudo usermod -aG docker ubuntu`) takes effect for new login sessions, but `brev exec` calls in the same Brev session keep the old gid. The reproducer's `nemoclaw onboard` will fail with `permission denied while connecting to /var/run/docker.sock` unless the call runs in a subshell with the docker group active.

```bash
# Reproducer execution: wrap with sg docker.
run_bounded brev exec "$INSTANCE" "sg docker -c 'bash ~/.verify-stale-evidence/reproducer.sh'" || exit 1
```

Encode both patterns in the reviewed reproducer wrapper. No setup script is bundled with this skill.

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
# At the top of the reproducer wrapper script, use an atomic directory lock:
SENTINEL=~/.verify-stale-running
if ! mkdir "$SENTINEL" 2>/dev/null; then
  echo "ERROR: another verify-stale run is in progress (sentinel: $SENTINEL)."
  echo "       If you're sure no other run is active, rmdir $SENTINEL and re-invoke."
  exit 1
fi
trap 'rmdir "$SENTINEL" 2>/dev/null || true' EXIT
```

The sentinel survives an SSH drop because it lives on the Brev instance filesystem; the trap removes it on script exit. Atomic `mkdir` prevents two simultaneous starts from both passing the check. A second `brev exec` invocation that retries from the top will hit the sentinel and stop instead of running twice.
