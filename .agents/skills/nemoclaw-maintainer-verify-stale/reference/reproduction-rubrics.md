<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Reproduction Rubrics Reference

Use after the baseline/latest installs are ready. Covers baseline matching, synth-repro retry, latest rerun, architectural drift, performance bugs, and rebuild-cycle bugs.

## Contents

- [Step 8b: Run reproducer on baseline, compare to issue symptom](#step-8b-run-reproducer-on-baseline-compare-to-issue-symptom)
- [Step 8c: Synth-repro and retry on baseline](#step-8c-synth-repro-and-retry-on-baseline)
- [Step 8d: Install latest, run validated reproducer](#step-8d-install-latest-run-validated-reproducer)
- [Step 8d.5: Architectural-Drift Check](#step-8d5-architectural-drift-check)
- [Step 8e: Performance and Resource-Growth Verification](#step-8e-performance-and-resource-growth-verification)
- [Step 8f: Rebuild-Cycle Verification](#step-8f-rebuild-cycle-verification-when-bug_classrebuild-cycle)

---

### Step 8b: Run reproducer on baseline, compare to issue symptom

Run only the bounded `$EVIDENCE_DIR/reproducer.sh` reconstructed and approved in Step 6. Never run `reported-reproducer.txt` or issue text directly. If no safe script exists, select `verify-inconclusive`.

**Interactive subcommand handling.** Many `nemoclaw onboard` / `nemoclaw configure` invocations prompt for input and will hang in a non-interactive shell. Do not mutate an approved reproducer in place or feed blanket `yes` responses. Inspect the exact tag's command help and apply, in order:

1. Add `--non-interactive` only if the exact version documents it and the resulting effects are understood.
2. Preserve `--dangerously-skip-prompts` only when it was part of the reviewed report and the exact version documents its meaning. Never add it automatically or use it to imply third-party-software consent.
3. Pre-feed only exact, version-specific responses after reviewing every prompt and the state change or consent it represents.

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

**Log-scraping (when `BUG_CLASS=log-only`).** Some bugs describe symptoms that show up in internal log files, not the reproducer's stdout/stderr — e.g., #1642 "see lots of error in openclaw log," #2611 "os.networkInterfaces guard errors." After running the reproducer, also pull the relevant logs from inside the sandbox and search them for the issue's symptom phrase:

```bash
# Common NemoClaw / OpenClaw / OpenShell log paths inside the sandbox.
if ! run_bounded brev exec "$INSTANCE_NAME" "sg docker -c 'cat ~/.openclaw/logs/*.log /var/log/nemoclaw/*.log 2>/dev/null'" \
  >"$EVIDENCE_DIR/baseline-logs.log" 2>&1; then
  echo "ERROR: log capture failed; the log-only result is inconclusive"
  exit 1
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/baseline-logs.log" >"$EVIDENCE_DIR/baseline-logs.redacted.log"

# Search the log capture for the issue's symptom phrase too, not just the transcript.
grep -F "<redacted symptom phrase from issue body>" "$EVIDENCE_DIR/baseline-logs.redacted.log"
```

For functional bugs the reproducer's stdout is sufficient; for log-only bugs the transcript may be clean but the log capture has the symptom. Both halves feed into the match rubric below.

**Flake-detection retry.** Even for `functional` bugs, race-prone reproducers (TUI rendering, network policy negotiation, concurrent sandbox state) can produce inconsistent results. Run baseline three times if the first run shows the symptom inconsistently — same script, same env, just three back-to-back invocations. If the three runs disagree, that's signal:

| 3-run baseline result | Verdict |
|---|---|
| All three reproduce the symptom | Strong baseline match → continue to 8d |
| All three are clean (no symptom) | Reproducer doesn't expose the bug on baseline → Step 8c synth-repro |
| Mixed (1 or 2 of 3 show the symptom) | Flake-prone reproducer. Note "flake suspected" in the comment; use `+25` instead of the normal `+50` latest-clean signal because a clean latest run could be the lucky path of an intermittent bug |

Skip flake retry for `performance` and `rebuild-cycle` classes — those have their own multi-run rubrics in Steps 8e and 8f.

**Match rubric.** Compare `baseline-transcript.redacted.log` to the redacted issue's "Actual result" or error description. Keep the raw file local and never print it. Match criteria, in order:

1. **Exit code agrees** with what the issue describes (non-zero if issue describes a failure, zero if issue describes a wrong-output bug). Necessary but not sufficient.
2. **Symptom phrase match:** transcript contains a key error phrase from the issue (e.g., issue says `Permission denied on generate-openclaw-config.py`, transcript says `EACCES: permission denied, open '...generate-openclaw-config.py'` — semantic equivalence counts).
3. **Distinguish bug from infra noise:** generic network / DNS / auth errors don't count as a match unless the issue itself describes them. A bug about config parsing that fails at "could not resolve nvidia.com" is an infra failure, not a reproduction.

**Fallback for issues without an explicit "Actual result" section.** Many bug reports describe a *behavioral* problem rather than a runtime error — e.g., "should default to a stable released version" (#1242), "configuration is not persisted across rebuilds" (#3030). These have no comparable error string. In that case:

1. Use the issue's **full title + description** as the symptom signal.
2. Match if the reproducer's outcome **contradicts the issue's stated expected behavior** (or matches the stated wrong behavior). E.g., issue says "expected: stable release; actual: nightly", reproducer prints `nightly-build-2026.04.x` → that's a match.
3. If neither error string nor expected-behavior contradiction can be identified, route the script to Step 8c (synth-repro) — let the LLM produce a more diagnostic script that emits something testable.

- **Match** → reproducer validated. Proceed to 8d.
- **No match** (silent pass, wrong error, infra noise, or no testable outcome): script has gaps. Proceed to 8c.

### Step 8c: Synth-repro and retry on baseline

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

- **Match:** validated (with −30 baked in). Proceed to 8d.
- **Still no match:** select the `verify-inconclusive` verdict. Prepare a comment with one redacted diagnostic line from each attempt and the message "couldn't establish a working reproducer for this bug on `$REPORTED_VERSION`." Keep the complete transcripts in local evidence only. **Skip 8d** because there is no validated reproducer.

### Step 8d: Install latest, run validated reproducer

```bash
if ! run_bounded brev exec "$INSTANCE_NAME" "$RESET"; then
  echo "ERROR: latest reset failed or exceeded the execution budget"
  exit 1
fi
LATEST_INSTALL_FAILED=0
INSTALL_TIMEOUT=$(remaining_seconds) || exit 1
if run_bounded brev exec "$INSTANCE_NAME" "
  $CREDENTIAL_EXPORT
  timeout ${INSTALL_TIMEOUT}s env \
    NEMOCLAW_INSTALL_REF= \
    NEMOCLAW_INSTALL_TAG=$LATEST \
    NEMOCLAW_NON_INTERACTIVE=1 \
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 \
    NEMOCLAW_AGENT=${NEMOCLAW_AGENT:-openclaw} \
    NEMOCLAW_PROVIDER=${BUG_PROVIDER:-ollama} \
    NEMOCLAW_MODEL=$VERIFY_MODEL \
    NEMOCLAW_SANDBOX_NAME=verify-stale-install \
    bash -o pipefail -c 'curl -fsSL $INSTALL_URL | bash'
" >"$EVIDENCE_DIR/latest-install.log" 2>&1; then
  LATEST_INSTALL_FAILED=0
else
  LATEST_INSTALL_FAILED=1
fi
python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
  "$EVIDENCE_DIR/latest-install.log" >"$EVIDENCE_DIR/latest-install.redacted.log"
tail -40 "$EVIDENCE_DIR/latest-install.redacted.log"

# Same resolved-version check as Step 8a — guard against env-var scoping or default fallthrough
# silently installing the wrong version. The latest install should resolve to $LATEST.
RESOLVED=$(run_bounded brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" 2>&1 | tail -1)
RESOLVED_SEMVER=$(printf '%s\n' "$RESOLVED" | grep -oE 'v?[0-9]+\.[0-9]+\.[0-9]+' | tail -1)
RESOLVED_TAG="v${RESOLVED_SEMVER#v}"
echo "[verify-stale] latest requested: $LATEST; resolved: $RESOLVED"
if [ -z "$RESOLVED_SEMVER" ] || [ "$RESOLVED_TAG" != "$LATEST" ]; then
    echo "ERROR: latest install resolved to '$RESOLVED' instead of $LATEST."
    echo "Treating this as an infra failure; no verdict or GitHub write is allowed."
    LATEST_INSTALL_FAILED=1
fi

# Do not replace OpenShell manually. The exact-tag installer enforces the
# blueprint's min/max OpenShell range and verifies the pinned release assets.
# An OpenShell range failure is an infra failure, not permission to download an
# unverified replacement binary.

[ "${LATEST_INSTALL_FAILED:-0}" = "0" ] || exit 1

# Remove the installer's verification sandbox so the approved reproducer sees
# the same clean starting state it saw after the baseline installer.
if ! run_bounded brev exec "$INSTANCE_NAME" "export PATH=\"\$HOME/.local/bin:\$PATH\"; nemoclaw verify-stale-install destroy --force --cleanup-gateway 2>/dev/null || true"; then
  echo "ERROR: could not remove the latest installer's verification sandbox"
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
echo "[verify-stale] latest reproducer exit: $LATEST_EXIT"
```

If the install of **latest** fails (e.g. installer regression — see #3058 for a current example), this is an infra failure — see Step 11. Do not score the issue or mutate its labels or Project fields.

If install succeeds, `latest-transcript.redacted.log` is the input to Step 9 scoring. Retain the raw file only until the temporary evidence directory is removed at the end of the run.

The automated verification must not open an unbounded interactive shell. After the run has cleaned up—or after separately approved retention—a maintainer can debug manually outside this skill's execution budget:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 8d.5: Architectural-Drift Check

Cross-version verification compares two moving targets: the reproducer assumes `$REPORTED_VERSION`'s tooling surface, and `$LATEST` may have rewritten the surface entirely. If the *tool* the reproducer relies on (CLI subcommand, output table, log file location) was reworked between the two tags, an "empty / clean output on latest" can mean either "bug fixed" OR "we're looking at a deprecated tracking surface." Without this check, the latter silently registers as the former — a class of false positive.

**Detection** — pickaxe the diff between tags for the reproducer's tool name and watch for the CLI itself being touched, not just its consumers:

```bash
# Extract the primary verification command from the reproducer (e.g. "openshell forward list").
# Preserve multi-word tool strings without Bash 4-only `mapfile`; maintainers
# can run this check from macOS's system Bash.
grep -oE '\b(openshell|nemoclaw)[[:space:]]+[a-z-]+' "$EVIDENCE_DIR/reproducer.sh" \
  | sort -u \
  | while IFS= read -r t; do
  echo "=== drift check: $t ==="
  git log "$REPORTED_VERSION".."$LATEST" -S"$t" --oneline -- src/ bin/ nemoclaw/src/ 2>&1 | head -5
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

**When drift is NOT suspected** (the reproducer's tool is unchanged in the version range): the reproducer's expected output is sufficient, no multi-axis verification needed.

---

## Step 8e: Performance and Resource-Growth Verification

Latency and resource-growth reports (#2598 "10s P50", #2600 "hangs ~2 min", #2733 Ollama tool-call leak over time) cannot be answered by the standard exit-code and symptom-phrase rubric. A single clean run does not establish a percentile or growth budget. Use the matching branch below.

**Latency branch (when `BUG_CLASS=performance`):**

1. **Parse the acceptance threshold from the issue body.** Extract numeric latency thresholds such as `10s P50`, `200ms`, `under 5 seconds`, or `~2 min`. Save them as `SLA_P50_MS`, `SLA_P90_MS`, or the matching metric. Do not silently interpret an unqualified latency threshold as p50; use the statistic named by the issue or obtain maintainer approval for the interpretation. If the issue gives no numeric threshold, select `verify-inconclusive` and propose a concise comment that asks for the metric, workload, warm-up, sample count, and threshold. Step 8c cannot invent an acceptance criterion.
2. **Run the reproducer N=10 times on the Brev instance** after each exact-tag install, capturing per-run latency. Follow the issue's warm-up instructions; if it gives none, run one unmeasured warm-up on each release and disclose that choice. Set `PERF_SIDE=baseline` after Step 8a and `PERF_SIDE=latest` after Step 8d:

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

   Keep the reproducer's stderr separate from `/usr/bin/time` output. Mixing diagnostics with numeric samples corrupts `sort` and percentile calculations. Confirm that the exit log contains ten expected exit codes. An unexpected failure makes the performance result inconclusive; do not treat a fast failure as an improvement.

3. **Compute p50 and p90** for both sides, in milliseconds (to match the `_MS`
   units of `SLA_P50_MS` / `SLA_P90_MS`). `/usr/bin/time -f '%e'` emits
   seconds, so multiply by 1000 in the awk:

   ```bash
   # p50 = mean of the 5th and 6th values (standard median for even N), in ms.
   PERF_SAMPLES=$(run_bounded brev exec "$INSTANCE_NAME" "cat ~/.verify-stale-evidence/${PERF_SIDE}-perf.log" \
     | grep -E '^[0-9]+([.][0-9]+)?$' || true)
   [ "$(printf '%s\n' "$PERF_SAMPLES" | sed '/^$/d' | wc -l | tr -d ' ')" = "10" ] || {
     echo "ERROR: expected exactly ten numeric timing samples"
     exit 1
   }
   P50_MS=$(printf '%s\n' "$PERF_SAMPLES" | sort -n \
     | awk 'NR==5||NR==6 {sum+=$1; n++} END {printf "%d", (sum/n)*1000}')
   # p90 = 9th value (nearest-rank / NIST method for N=10), in ms.
   P90_MS=$(printf '%s\n' "$PERF_SAMPLES" | sort -n | awk 'NR==9 {printf "%d", $1*1000}')
   echo "[perf] ${PERF_SIDE} p50=${P50_MS}ms p90=${P90_MS}ms"
   ```

   Save the values as `BASELINE_P50_MS` / `BASELINE_P90_MS` or `LATEST_P50_MS` / `LATEST_P90_MS` according to `PERF_SIDE`.
4. **Match rubric (p50 fires first; p90 is the regression backstop):**
   - Latest's p50 within `$SLA_P50_MS` AND baseline's p50 outside → bug fixed; same Step 9 scoring (subject to baseline-validation gate).
   - Latest's p50 outside `$SLA_P50_MS` → bug still reproduces (Step 9 special case).
   - Latest's p50 within `$SLA_P50_MS` AND baseline's p50 also within → reproducer doesn't actually exercise the bug; route to Step 8c synth-repro.
   - **p90 backstop**: if `$SLA_P90_MS` was parsed from the issue, latest's p90 outside `$SLA_P90_MS` flips a within-SLA-p50 verdict to `still-reproduces` — tail-latency regressions matter for the issues that name them.

**Resource-growth branch (when `BUG_CLASS=resource-growth`).** Do not use elapsed time as a proxy for a memory, VRAM, file-descriptor, or disk-growth report. Require the issue to identify the resource, workload, observation duration or iteration count, sampling interval, and acceptance threshold. Instrument the exact named process, container, or filesystem with a reviewed command and run the same sampling harness on baseline and latest. Before each side, obtain `GROWTH_TIMEOUT=$(remaining_seconds) || exit 1` and wrap the complete remote sampling harness in `timeout "${GROWTH_TIMEOUT}s"`; do not start when the requested observation window cannot fit. The baseline must cross the reported growth threshold before a clean latest result can support `fixed-on-latest`; both crossing it means `still-reproduces`. Missing thresholds, process ambiguity, early process exit, or a third outcome means `verify-inconclusive`. Preserve the numeric sample series as local evidence and publish only the baseline/latest summary statistics after redaction.

**Hardware-substitution caveat.** Performance and resource-growth results are often silicon-dependent. When the issue is `platform: dgx-spark` or `platform: gb10` and the Brev SKU uses different silicon, select `verify-inconclusive` unless the issue's acceptance criterion explicitly applies across the two environments and the maintainer approved that substitution. Even when cross-hardware comparison is valid, the comment must name both environments and the remaining limitation.

---

## Step 8f: Rebuild-Cycle Verification (when `BUG_CLASS=rebuild-cycle`)

Lifecycle bugs only manifest across the operation named by the issue. `restart`, `rebuild`, `recreate`, and `destroy` are different contracts. Do not normalize them all to destroy plus onboard. Run the same approved lifecycle harness on the reported release and the newest exact release tag.

Before each onboard, lifecycle operation, and capture, call `remaining_seconds` and use its result as that remote command's `timeout`. Do not begin a boundary sequence unless all required pre/post observations can fit within the remaining verification budget.

1. **First onboard.** Run the reproducer once to establish initial state. Capture relevant artifacts (config files, env vars, sandbox metadata) — the issue body usually names what should persist:

   ```bash
   if ! run_bounded brev exec "$INSTANCE_NAME" "sg docker -c 'cat <non-credential-bearing-files-mentioned-in-issue> 2>&1'" \
     >"$EVIDENCE_DIR/pre-rebuild.log" 2>&1; then
     echo "ERROR: pre-boundary capture failed"
     exit 1
   fi
   python3 .agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py \
     "$EVIDENCE_DIR/pre-rebuild.log" >"$EVIDENCE_DIR/pre-rebuild.redacted.log"
   ```

2. **Trigger the reported boundary.** Use the exact supported command that the issue names:
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
5. **Verify latest.** After the reset and exact `$LATEST` install, repeat the same setup, lifecycle operation, and captures:
   - Baseline loses or changes the artifact, while latest preserves the expected state → candidate for `fixed-on-latest` scoring.
   - Baseline and latest both lose or change the artifact in the reported way → `still-reproduces`.
   - Latest produces a third outcome or the lifecycle command differs → `verify-inconclusive`.

The harness still uses Step 9's scoring framework, but the evidence is the pre/post state comparison for the exact lifecycle boundary.

---
