<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Reproduction Rubrics Reference

Use after installing the reported release and the newest release tag. Covers reported-release matching, synthesized-reproducer retry, newest-release verification, architecture changes, performance bugs, and rebuild-cycle bugs.

## Contents

- [Step 8b: Run the Reproducer on the Reported Release](#step-8b-run-the-reproducer-on-the-reported-release)
- [Step 8c: Revise and Retry on the Reported Release](#step-8c-revise-and-retry-on-the-reported-release)
- [Step 8d: Install the Newest Release Tag and Run the Validated Reproducer](#step-8d-install-the-newest-release-tag-and-run-the-validated-reproducer)
- [Step 8d.5: Architecture-Change Check](#step-8d5-architecture-change-check)
- [Step 8e: Performance and Resource-Growth Verification](#step-8e-performance-and-resource-growth-verification)
- [Step 8f: Rebuild-Cycle Verification](#step-8f-rebuild-cycle-verification-when-bug_classrebuild-cycle)

---

### Step 8b: Run the Reproducer on the Reported Release

Run only the bounded `$EVIDENCE_DIR/reproducer.sh` reconstructed and approved in Step 6. Never run `reported-reproducer.txt` or issue text directly. If the script does not meet Step 6's command, path, network, privilege, timeout, cleanup, and approval requirements, select `verify-inconclusive`.

**Interactive subcommand handling.** Many `nemoclaw onboard` and `nemoclaw configure` invocations prompt for input and will hang in a non-interactive shell. Do not mutate an approved reproducer in place or feed blanket `yes` responses. Inspect the requested release tag's command help and apply these rules in order:

1. Add `--non-interactive` only if the requested release tag documents it and the resulting effects are understood.
2. Preserve `--dangerously-skip-prompts` only when it was part of the reviewed report and the requested release tag documents its meaning. Never add it automatically or use it to imply third-party-software consent.
3. Pre-feed only the documented responses for the requested release tag after reviewing every prompt and the state change or consent it represents.

Every adaptation creates a revised script. Show the complete revision, exact stdin responses, and effects, then obtain explicit approval before execution. If no reviewed non-interactive path exists, route the script to Step 8c or select `verify-inconclusive`.

```bash
# `brev exec` spawns a non-login shell, so ~/.local/bin (where the nemoclaw binary lives
# after install) is not on PATH unless we export it. The reproducer script itself must
# use `sg docker -c '...'` blocks for any Docker-touching command — Step 8a.5b covers
# that requirement; double-wrapping with sg docker on the outer call breaks nested-quote
# escaping in some bash versions.
run_bounded brev copy "$EVIDENCE_DIR/reproducer.sh" "$INSTANCE_NAME":~/.verify-stale-evidence/reproducer.sh || exit 1
REPRO_TIMEOUT=$(remaining_seconds) || exit 1
[ "$REPRO_TIMEOUT" -le 1200 ] || REPRO_TIMEOUT=1200
if run_bounded brev exec "$INSTANCE_NAME" "export PATH=\"\$HOME/.local/bin:\$PATH\" && timeout ${REPRO_TIMEOUT}s bash ~/.verify-stale-evidence/reproducer.sh" >"$EVIDENCE_DIR/baseline-transcript.log" 2>&1; then
  BASELINE_EXIT=0
else
  BASELINE_EXIT=$?
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/baseline-transcript.log" >"$EVIDENCE_DIR/baseline-transcript.redacted.log"
sed -n '1,200p' "$EVIDENCE_DIR/baseline-transcript.redacted.log"
echo "[verify-stale] baseline reproducer exit: $BASELINE_EXIT"
```

Do not pipe `brev exec` through `tee` when the exit code is evidence. Without `pipefail`, the pipeline reports `tee`'s status and can turn a failed reproducer into exit 0.

**Log capture (when `BUG_CLASS=log-only`).** Some bugs describe symptoms in internal log files instead of the reproducer's standard output. For example, #1642 reports errors in the OpenClaw log, and #2611 reports `os.networkInterfaces` guard errors. After running the reproducer, copy the relevant logs from inside the sandbox and search them for the reported symptom:

```bash
# Common NemoClaw / OpenClaw / OpenShell log paths inside the sandbox.
if ! run_bounded brev exec "$INSTANCE_NAME" "sg docker -c 'cat ~/.openclaw/logs/*.log /var/log/nemoclaw/*.log 2>/dev/null'" \
  >"$EVIDENCE_DIR/baseline-logs.log" 2>&1; then
  echo "ERROR: log capture failed; the log-only result is inconclusive"
  exit 1
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/baseline-logs.log" >"$EVIDENCE_DIR/baseline-logs.redacted.log"

# Save the reviewed redacted phrase as data, not as part of a shell command.
SYMPTOM_PHRASE=$(<"$EVIDENCE_DIR/symptom-phrase.redacted.txt")
[ -n "$SYMPTOM_PHRASE" ] || { echo "ERROR: symptom phrase is empty"; exit 1; }
grep -F -- "$SYMPTOM_PHRASE" "$EVIDENCE_DIR/baseline-logs.redacted.log"
```

For functional bugs, the reproducer's standard output is sufficient. For log-only bugs, the transcript might not show the symptom while the log capture does. Use both results in the match rubric below.

**Intermittent-result retry.** For `functional` bugs, race-prone reproducers can produce inconsistent results. Run the reported-release reproducer three times when the first results disagree. Use the same script and environment for each run:

| Three-run reported-release result | Verdict |
|---|---|
| All three reproduce the symptom | All three reported-release runs match → continue to 8d |
| None of the three show the symptom | Reproducer does not expose the bug on the reported release → Step 8c revision |
| One or two runs show the symptom | Intermittent reproducer. State that result in the comment; use `+25` instead of the normal `+50` newest-release signal because one result without the symptom does not establish a fix |

Skip this retry for `performance` and `rebuild-cycle` classes because Steps 8e and 8f define their sample plans.

**Match rubric.** Compare `baseline-transcript.redacted.log` to the redacted issue's "Actual result" or error description. Keep the raw file local and never print it. Match criteria, in order:

1. **Exit code agrees** with what the issue describes (non-zero if issue describes a failure, zero if issue describes a wrong-output bug). Necessary but not sufficient.
2. **Symptom phrase match:** transcript contains a key error phrase from the issue (e.g., issue says `Permission denied on generate-openclaw-config.py`, transcript says `EACCES: permission denied, open '...generate-openclaw-config.py'` — semantic equivalence counts).
3. **Distinguish the bug from infrastructure errors:** generic network, DNS, or authentication errors do not count as a match unless the issue describes them. A configuration-parsing bug that stops at `could not resolve nvidia.com` has an infrastructure error, not a reproduction.

**Fallback for issues without an explicit "Actual result" section.** Many bug reports describe a *behavioral* problem rather than a runtime error — e.g., "should default to a stable released version" (#1242), "configuration is not persisted across rebuilds" (#3030). These have no comparable error string. In that case:

1. Use the issue's **full title + description** as the symptom signal.
2. Match if the reproducer's outcome **contradicts the issue's stated expected behavior** (or matches the stated wrong behavior). E.g., issue says "expected: stable release; actual: nightly", reproducer prints `nightly-build-2026.04.x` → that's a match.
3. If neither error string nor expected-behavior contradiction can be identified, route the script to Step 8c (synth-repro) — let the LLM produce a more diagnostic script that emits something testable.

- **Match** → reproducer validated. Proceed to 8d.
- **No match** (no symptom, different error, infrastructure error, or no testable outcome): script has gaps. Proceed to 8c.

### Step 8c: Revise and Retry on the Reported Release

LLM rewrites `$EVIDENCE_DIR/reproducer.sh` using the issue context plus the redacted baseline transcript. Apply the **−30 confidence penalty**. Repeat Step 6's untrusted-input review, show the complete revision and effects, and obtain approval before copying or executing it.

```bash
run_bounded brev copy "$EVIDENCE_DIR/reproducer.sh" "$INSTANCE_NAME":~/.verify-stale-evidence/reproducer.sh || exit 1
REPRO_TIMEOUT=$(remaining_seconds) || exit 1
[ "$REPRO_TIMEOUT" -le 1200 ] || REPRO_TIMEOUT=1200
if run_bounded brev exec "$INSTANCE_NAME" "export PATH=\"\$HOME/.local/bin:\$PATH\" && timeout ${REPRO_TIMEOUT}s bash ~/.verify-stale-evidence/reproducer.sh" >"$EVIDENCE_DIR/baseline-transcript-2.log" 2>&1; then
  BASELINE_EXIT_2=0
else
  BASELINE_EXIT_2=$?
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/baseline-transcript-2.log" >"$EVIDENCE_DIR/baseline-transcript-2.redacted.log"
sed -n '1,200p' "$EVIDENCE_DIR/baseline-transcript-2.redacted.log"
echo "[verify-stale] revised baseline reproducer exit: $BASELINE_EXIT_2"
```

- **Match:** validated with the −30 confidence penalty. Proceed to 8d.
- **Still no match:** select the `verify-inconclusive` verdict. Prepare a comment with one redacted diagnostic line from each attempt and the message "couldn't establish a working reproducer for this bug on `$REPORTED_VERSION`." Keep the complete transcripts in local evidence only. **Skip 8d** because there is no validated reproducer.

### Step 8d: Install the Newest Release Tag and Run the Validated Reproducer

```bash
if ! run_bounded brev exec "$INSTANCE_NAME" "$RESET"; then
  echo "ERROR: newest-release reset failed or exceeded the execution budget"
  exit 1
fi
prepare_release_installer "$LATEST" latest || exit 1
LATEST_INSTALL_FAILED=0
INSTALL_TIMEOUT=$(remaining_seconds) || exit 1
if run_bounded brev exec "$INSTANCE_NAME" "
  $CREDENTIAL_EXPORT
  timeout ${INSTALL_TIMEOUT}s env \
    NEMOCLAW_INSTALL_REF=$LATEST \
    NEMOCLAW_INSTALL_TAG=$LATEST \
    NEMOCLAW_REPO_ROOT=\$HOME/.verify-stale-evidence/latest-release/source \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_AGENT=${NEMOCLAW_AGENT:-openclaw} \
    NEMOCLAW_PROVIDER=${BUG_PROVIDER:-ollama} \
    NEMOCLAW_MODEL=$VERIFY_MODEL \
    NEMOCLAW_SANDBOX_NAME=verify-stale-install \
    bash -c 'cd "\$NEMOCLAW_REPO_ROOT" && exec bash ./install.sh'
" >"$EVIDENCE_DIR/latest-install.log" 2>&1; then
  LATEST_INSTALL_FAILED=0
else
  LATEST_INSTALL_FAILED=1
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/latest-install.log" >"$EVIDENCE_DIR/latest-install.redacted.log"
tail -40 "$EVIDENCE_DIR/latest-install.redacted.log"

# Apply the same resolved-release-tag check as Step 8a. Check the bounded command
# status before parsing output so a transport failure cannot verify an install.
LATEST_VERSION_LOG="$EVIDENCE_DIR/latest-version.log"
if run_bounded brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" \
  >"$LATEST_VERSION_LOG" 2>&1; then
  RESOLVED=$(tail -1 "$LATEST_VERSION_LOG")
  RESOLVED_SEMVER=$(printf '%s\n' "$RESOLVED" | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | tail -1)
  RESOLVED_TAG="v${RESOLVED_SEMVER#v}"
  echo "[verify-stale] newest release requested: $LATEST; resolved: $RESOLVED"
  if [ -z "$RESOLVED_SEMVER" ] || [ "$RESOLVED_TAG" != "$LATEST" ]; then
    echo "ERROR: resolved release tag '$RESOLVED_TAG' does not match requested release tag $LATEST."
    LATEST_INSTALL_FAILED=1
  fi
else
  echo "ERROR: could not resolve the installed release tag"
  LATEST_INSTALL_FAILED=1
fi
[ "$LATEST_INSTALL_FAILED" = "0" ] \
  || echo "Treating this as an infrastructure failure; no verdict or GitHub write is allowed."

# Do not replace OpenShell manually. The installer for the requested release tag enforces the
# blueprint's min/max OpenShell range and verifies the pinned release assets.
# An OpenShell range failure is an infrastructure failure, not permission to download an
# unverified replacement binary.

[ "${LATEST_INSTALL_FAILED:-0}" = "0" ] || exit 1

# Remove the installer's verification sandbox so the approved reproducer sees
# the same state with no registered verification sandbox used after the reported-release install.
if ! remove_install_sandbox; then
  echo "ERROR: could not remove or verify absence of the newest-release installer's sandbox"
  exit 1
fi

run_bounded brev copy "$EVIDENCE_DIR/reproducer.sh" "$INSTANCE_NAME":~/.verify-stale-evidence/reproducer.sh || exit 1
REPRO_TIMEOUT=$(remaining_seconds) || exit 1
[ "$REPRO_TIMEOUT" -le 1200 ] || REPRO_TIMEOUT=1200
if run_bounded brev exec "$INSTANCE_NAME" "export PATH=\"\$HOME/.local/bin:\$PATH\" && timeout ${REPRO_TIMEOUT}s bash ~/.verify-stale-evidence/reproducer.sh" >"$EVIDENCE_DIR/latest-transcript.log" 2>&1; then
  LATEST_EXIT=0
else
  LATEST_EXIT=$?
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/latest-transcript.log" >"$EVIDENCE_DIR/latest-transcript.redacted.log"
sed -n '1,200p' "$EVIDENCE_DIR/latest-transcript.redacted.log"
echo "[verify-stale] newest-release reproducer exit: $LATEST_EXIT"
```

If the install of the newest release tag fails, this is an infrastructure failure. Refer to Step 11. Do not score the issue or mutate its labels or Project fields.

If install succeeds, `latest-transcript.redacted.log` is the input to Step 9 scoring. Retain the raw file only until the temporary evidence directory is removed at the end of the run.

The automated verification must not open an unbounded interactive shell. After the run has cleaned up—or after separately approved retention—a maintainer can debug manually outside this skill's execution budget:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 8d.5: Architecture-Change Check

Cross-version verification compares two tool surfaces. The reproducer assumes the reported release's commands and output, while `$LATEST` can change them. If the reproducer's command, output table, or log location changed between release tags, output without the reported symptom can mean either that the bug is fixed or that the reproducer observes an obsolete surface. Check the architecture change before assigning a verdict.

**Detection** — pickaxe the diff between tags for the reproducer's tool name and watch for the CLI itself being touched, not just its consumers:

```bash
# Extract the primary verification command from the reproducer (e.g. "openshell forward list").
# Preserve multi-word tool strings without Bash 4-only `mapfile`; maintainers
# can run this check from macOS's system Bash.
grep -oE '(^|[^[:alnum:]_])(openshell|nemoclaw|openclaw)[[:space:]]+[a-z-]+' "$EVIDENCE_DIR/reproducer.sh" \
  | sed -E 's/^[^[:alnum:]_]+//' \
  | sort -u \
  | while IFS= read -r t; do
  echo "=== drift check: $t ==="
  git log "$REPORTED_VERSION".."$LATEST" -S"$t" --oneline -- \
    src/ bin/ nemoclaw/src/ scripts/nemoclaw-start.sh \
    nemoclaw-blueprint/openclaw-plugins/ 2>&1 | head -5
done
```

If a tool is touched, drift is suspected.

**Multi-axis verification** — when drift is suspected, do not rely on the reproducer's expected output alone. Pick OS-level surfaces that would show the buggy state regardless of which CLI tracks it. For port-forwarding bugs (the #2007 case), the canonical five-axis pattern:

| # | Surface | Command |
|---|---|---|
| 1 | Reproducer's stated check | as written in the issue body |
| 2 | Host TCP listeners | `sudo ss -tlnp` |
| 3 | iptables NAT redirects | `sudo iptables -t nat -L -n` |
| 4 | Docker port mappings | `docker ps --format '{{.Names}} {{.Ports}}'` |
| 5 | Active SSH tunnels | `ps -ef \| grep 'ssh.*-L'` |

Adapt the axes to the bug class. For filesystem bugs: `find`, `lsattr`, `stat`. For network policy bugs: `iptables -L`, container netns, gateway logs. The principle is the same — pick at least three independent surfaces that would each independently show the buggy state if it were present.

**Action when drift is suspected:**

- Run the multi-axis pattern after Step 8d's reproducer.
- The verdict requires **every relevant axis to be clean** — not just the reproducer's surface — before claiming `fixed-on-latest`.
- Quote the multi-axis evidence in the Step 10 comment as a table; this makes "fixed" defensible when the original tooling no longer reflects the underlying behavior.
- If any axis still shows the buggy state, the bug is NOT fixed even if the reproducer's surface is clean. Escalate to "still reproduces" (Step 9 special case).

**When no architecture change is suspected:** the reproducer's expected output is sufficient. No multi-axis verification is needed.

---

## Step 8e: Performance and Resource-Growth Verification

Latency and resource-growth reports (#2598, #2600, and #2733) cannot use the standard exit-code and symptom-phrase rubric. One run without the symptom does not establish a percentile or growth budget. Use the applicable branch below.

**Latency branch (when `BUG_CLASS=performance`):**

1. **Parse the acceptance threshold from the issue body.** Extract numeric latency thresholds such as `10s P50`, `200ms`, `under 5 seconds`, or `~2 min`. Save them as `SLA_P50_MS`, `SLA_P90_MS`, or the matching metric. Do not silently interpret an unqualified latency threshold as p50; use the statistic named by the issue or obtain maintainer approval for the interpretation. If the issue gives no numeric threshold, select `verify-inconclusive` and propose a concise comment that asks for the metric, workload, warm-up, sample count, and threshold. Step 8c cannot invent an acceptance criterion.
2. **Run the reproducer 10 times on the Brev instance** after installing each release tag, and capture each run's latency. Follow the issue's warm-up instructions. If the issue gives none, run one unmeasured warm-up on each release and disclose that choice. Set `PERF_SIDE=baseline` after Step 8a and `PERF_SIDE=latest` after Step 8d:

   ```bash
   case "$PERF_SIDE" in baseline|latest) ;; *) echo "invalid PERF_SIDE"; exit 1 ;; esac
   PERF_TIMEOUT=$(remaining_seconds) || exit 1
   if ! run_bounded brev exec "$INSTANCE_NAME" "
     export PATH=\"\$HOME/.local/bin:\$PATH\"
     PERF_DEADLINE=\$((\$(date +%s) + ${PERF_TIMEOUT}))
     sample_timeout() {
       sample_remaining=\$((PERF_DEADLINE - \$(date +%s)))
       [ \"\$sample_remaining\" -gt 0 ] || return 1
       [ \"\$sample_remaining\" -le 1200 ] || sample_remaining=1200
       printf '%s\\n' \"\$sample_remaining\"
     }
     : > ~/.verify-stale-evidence/${PERF_SIDE}-perf.log
     : > ~/.verify-stale-evidence/${PERF_SIDE}-perf-stderr.log
     : > ~/.verify-stale-evidence/${PERF_SIDE}-perf-exits.log
     WARMUP_TIMEOUT=\$(sample_timeout) || exit 124
     timeout \"\${WARMUP_TIMEOUT}s\" bash ~/.verify-stale-evidence/reproducer.sh >/dev/null 2>>~/.verify-stale-evidence/${PERF_SIDE}-perf-stderr.log || {
       WARMUP_EXIT=\$?
       [ \"\$WARMUP_EXIT\" -ne 124 ] || exit 124
     }
     for i in \$(seq 1 10); do
       SAMPLE_TIMEOUT=\$(sample_timeout) || exit 124
       /usr/bin/time -f '%e' -o ~/.verify-stale-evidence/${PERF_SIDE}-perf.log -a \
         timeout \"\${SAMPLE_TIMEOUT}s\" bash ~/.verify-stale-evidence/reproducer.sh >/dev/null 2>>~/.verify-stale-evidence/${PERF_SIDE}-perf-stderr.log
       printf '%s\n' \$? >> ~/.verify-stale-evidence/${PERF_SIDE}-perf-exits.log
     done
   "; then
     echo "ERROR: performance harness failed or exceeded the execution budget"
     exit 1
   fi
   ```

   Keep the reproducer's standard error separate from `/usr/bin/time` output. Mixing diagnostics with numeric samples corrupts percentile calculations. Before calculating a percentile, require exactly 10 successful sample exits. Otherwise select `verify-inconclusive`; do not score recorded durations.

3. **Compute p50 and p90** for both sides, in milliseconds (to match the `_MS`
   units of `SLA_P50_MS` / `SLA_P90_MS`). `/usr/bin/time -f '%e'` emits
   seconds, so multiply by 1000 in the awk:

   ```bash
   PERF_INCONCLUSIVE_REASON=""
   if ! PERF_EXITS=$(run_bounded brev exec "$INSTANCE_NAME" "cat ~/.verify-stale-evidence/${PERF_SIDE}-perf-exits.log"); then
     echo "ERROR: could not retrieve performance sample exit statuses"
     exit 1
   fi
   PERF_EXIT_COUNT=$(printf '%s\n' "$PERF_EXITS" | sed '/^$/d' | wc -l | tr -d ' ')
   if [ "$PERF_EXIT_COUNT" != "10" ] || printf '%s\n' "$PERF_EXITS" | grep -Ev '^0$' >/dev/null; then
     PERF_INCONCLUSIVE_REASON="performance samples did not produce exactly 10 successful exits"
   fi

   PERF_SAMPLES=""
   if [ -z "$PERF_INCONCLUSIVE_REASON" ]; then
     if ! PERF_LOG=$(run_bounded brev exec "$INSTANCE_NAME" "cat ~/.verify-stale-evidence/${PERF_SIDE}-perf.log"); then
       echo "ERROR: could not retrieve performance samples"
       exit 1
     fi
     PERF_SAMPLES=$(printf '%s\n' "$PERF_LOG" \
       | grep -E '^[0-9]+([.][0-9]+)?$' || true)
     if [ "$(printf '%s\n' "$PERF_SAMPLES" | sed '/^$/d' | wc -l | tr -d ' ')" != "10" ]; then
       PERF_INCONCLUSIVE_REASON="performance harness did not produce exactly 10 numeric samples"
     fi
   fi

   if [ -n "$PERF_INCONCLUSIVE_REASON" ]; then
     VERDICT=verify-inconclusive
     echo "VERDICT=$VERDICT: $PERF_INCONCLUSIVE_REASON"
   else
     # p50 = mean of the 5th and 6th values for 10 samples, in ms.
     P50_MS=$(printf '%s\n' "$PERF_SAMPLES" | sort -n \
       | awk 'NR==5||NR==6 {sum+=$1; n++} END {printf "%d", (sum/n)*1000}')
     # p90 = 9th value for 10 samples, in ms.
     P90_MS=$(printf '%s\n' "$PERF_SAMPLES" | sort -n | awk 'NR==9 {printf "%d", $1*1000}')
     echo "[perf] ${PERF_SIDE} p50=${P50_MS}ms p90=${P90_MS}ms"
   fi
   ```

   Save percentile values only when `PERF_INCONCLUSIVE_REASON` is empty. When it is non-empty, skip percentile scoring and continue to the approved `verify-inconclusive` comment path.
4. **Match rubric (p50 fires first; p90 is the regression backstop):**
   - Newest-release p50 is within `$SLA_P50_MS`, and reported-release p50 is outside → candidate for fixed scoring.
   - Newest-release p50 is outside `$SLA_P50_MS` → `still-reproduces`.
   - Both p50 values are within `$SLA_P50_MS` → the reproducer does not expose the reported performance bug; revise it through Step 8c.
   - If the issue defines `$SLA_P90_MS`, a newest-release p90 outside that threshold selects `still-reproduces`.

**Resource-growth branch (when `BUG_CLASS=resource-growth`).** Do not use elapsed time as a proxy for memory, VRAM, file-descriptor, or disk growth. Require the issue to identify the resource, workload, observation duration or iteration count, sampling interval, and acceptance threshold. Run the same reviewed sampling command on the reported release and newest release tag. Before each sample plan, obtain `GROWTH_TIMEOUT=$(remaining_seconds) || exit 1` and wrap the remote command in `timeout "${GROWTH_TIMEOUT}s"`. Do not start when the observation window cannot fit. The reported-release result must cross the threshold before a newest-release result below the threshold can support `fixed-on-latest`. If both cross it, select `still-reproduces`. Select `verify-inconclusive` for missing thresholds, process ambiguity, early process exit, or a third outcome. Preserve the numeric samples as local evidence and publish only redacted summary statistics.

**Hardware-substitution caveat.** Performance and resource-growth results are often silicon-dependent. When the issue is `platform: dgx-spark` or `platform: gb10` and the Brev SKU uses different silicon, select `verify-inconclusive` unless the issue's acceptance criterion explicitly applies across the two environments and the maintainer approved that substitution. Even when cross-hardware comparison is valid, the comment must name both environments and the remaining limitation.

---

## Step 8f: Rebuild-Cycle Verification (when `BUG_CLASS=rebuild-cycle`)

Lifecycle bugs only manifest across the operation named by the issue. `restart`, `rebuild`, `recreate`, and `destroy` are different contracts. Do not normalize them all to destroy plus onboard. Run the same approved lifecycle harness on the reported release and the newest release tag.

Before each onboard, lifecycle operation, and capture, call `remaining_seconds` and use its result as that remote command's `timeout`. Do not begin a boundary sequence unless all required pre/post observations can fit within the remaining verification budget.

1. **First onboard.** Run the reproducer once to establish initial state. Capture the relevant artifacts, such as configuration files, environment variables, and sandbox metadata. The issue body usually names the state that should persist:

   ```bash
   if ! run_bounded brev exec "$INSTANCE_NAME" "sg docker -c 'cat <non-credential-bearing-files-mentioned-in-issue> 2>&1'" \
     >"$EVIDENCE_DIR/pre-rebuild.log" 2>&1; then
     echo "ERROR: pre-boundary capture failed"
     exit 1
   fi
   python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
     "$EVIDENCE_DIR/pre-rebuild.log" >"$EVIDENCE_DIR/pre-rebuild.redacted.log"
   ```

2. **Trigger the reported boundary.** Use the supported command that the issue names:
   - Restart: `nemoclaw <name> stop`, then `nemoclaw <name> start`, unless the issue names a service-level restart.
   - Rebuild: `nemoclaw <name> rebuild --yes`.
   - Recreate through onboarding: use the issue's reviewed `nemoclaw onboard --fresh --name <name> --recreate-sandbox` flow.
   - Destroy and onboard: use `nemoclaw <name> destroy --force`, then the reviewed onboarding command, only when the issue explicitly names that deletion boundary.

   Do not run the reset between the pre- and post-captures. The reset belongs between release installs, not inside the lifecycle observation.

3. **Re-capture the same artifacts** post-rebuild:

   ```bash
   if ! run_bounded brev exec "$INSTANCE_NAME" "sg docker -c 'cat <same-non-credential-bearing-files> 2>&1'" \
     >"$EVIDENCE_DIR/post-rebuild.log" 2>&1; then
     echo "ERROR: post-boundary capture failed"
     exit 1
   fi
   python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
     "$EVIDENCE_DIR/post-rebuild.log" >"$EVIDENCE_DIR/post-rebuild.redacted.log"
   ```

4. **Validate the baseline.** On `$REPORTED_VERSION`, the pre/post result must expose the reported symptom. If it does not, revise the bounded reproducer once through Step 8c. If the revised baseline still does not match, select `verify-inconclusive`.
5. **Verify the newest release tag.** After the reset and `$LATEST` install, repeat the same setup, lifecycle operation, and captures:
   - Reported release loses or changes the artifact, while the newest release preserves the expected state → candidate for `fixed-on-latest` scoring.
   - Both releases lose or change the artifact in the reported way → `still-reproduces`.
   - The newest release produces a third outcome or uses a different lifecycle command → `verify-inconclusive`.

The harness still uses Step 9's scoring framework, but the evidence is the pre/post state comparison for the lifecycle boundary.

---
