<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Reproduction Rubrics Reference

Use after the baseline/latest installs are ready. Covers baseline matching, synth-repro retry, latest rerun, architectural drift, performance bugs, and rebuild-cycle bugs.

## Contents

- [Step 8b: Run reproducer on baseline, compare to issue symptom](#step-8b-run-reproducer-on-baseline-compare-to-issue-symptom)
- [Step 8c: Synth-repro and retry on baseline](#step-8c-synth-repro-and-retry-on-baseline)
- [Step 8d: Install latest, run validated reproducer](#step-8d-install-latest-run-validated-reproducer)
- [Step 8d.5: Architectural-Drift Check](#step-8d5-architectural-drift-check)
- [Step 8e: Performance-Bug Verification](#step-8e-performance-bug-verification-when-bug_classperformance)
- [Step 8f: Rebuild-Cycle Verification](#step-8f-rebuild-cycle-verification-when-bug_classrebuild-cycle)

---

### Step 8b: Run reproducer on baseline, compare to issue symptom

If `./reproducer.sh` exists (verbatim from Step 6), run it. Otherwise synth on demand from the issue body (apply −30 penalty now, locked in for the rest of the run).

**Interactive subcommand handling.** Many `nemoclaw onboard` / `nemoclaw configure` invocations prompt for input and will hang in a non-interactive shell. Auto-detect such subcommands in the script and apply, in order:

1. Add `--non-interactive` if the version supports it.
2. Add `--dangerously-skip-prompts` (issue #2168 confirmed this exists for at least some Jetson paths).
3. Pre-feed answers via stdin: `printf 'yes\n\n\n' | nemoclaw onboard ...`

If none work, route the script to Step 8c (synth-repro) so the LLM can rewrite it using non-interactive equivalents.

```bash
# `brev exec` spawns a non-login shell, so ~/.local/bin (where the nemoclaw binary lives
# after install) is not on PATH unless we export it. The reproducer script itself must
# use `sg docker -c '...'` blocks for any Docker-touching command — Step 8a.5b covers
# that requirement; double-wrapping with sg docker on the outer call breaks nested-quote
# escaping in some bash versions.
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
brev exec "$INSTANCE_NAME" 'export PATH="$HOME/.local/bin:$PATH" && bash ~/reproducer.sh' 2>&1 | tee ./baseline-transcript.log
```

**Log-scraping (when `BUG_CLASS=log-only`).** Some bugs describe symptoms that show up in internal log files, not the reproducer's stdout/stderr — e.g., #1642 "see lots of error in openclaw log," #2611 "os.networkInterfaces guard errors." After running the reproducer, also pull the relevant logs from inside the sandbox and search them for the issue's symptom phrase:

```bash
# Common NemoClaw / OpenClaw / OpenShell log paths inside the sandbox.
brev exec "$INSTANCE_NAME" "sg docker -c 'cat ~/.openclaw/logs/*.log /var/log/nemoclaw/*.log 2>/dev/null'" \
  | tee ./baseline-logs.log

# Search the log capture for the issue's symptom phrase too, not just the transcript.
grep -F "<symptom phrase from issue body>" ./baseline-logs.log
```

For functional bugs the reproducer's stdout is sufficient; for log-only bugs the transcript may be clean but the log capture has the symptom. Both halves feed into the match rubric below.

**Flake-detection retry.** Even for `functional` bugs, race-prone reproducers (TUI rendering, network policy negotiation, concurrent sandbox state) can produce inconsistent results. Run baseline three times if the first run shows the symptom inconsistently — same script, same env, just three back-to-back invocations. If the three runs disagree, that's signal:

| 3-run baseline result | Verdict |
|---|---|
| All three reproduce the symptom | Strong baseline match → continue to 8d |
| All three are clean (no symptom) | Reproducer doesn't expose the bug on baseline → Step 8c synth-repro |
| Mixed (1 or 2 of 3 show the symptom) | Flake-prone reproducer. Note "flake suspected" in the comment; apply −25 to Step 9 score; downgrade `+50 latest clean` to `+25` because a clean latest run could just be the lucky path of an intermittent bug |

Skip flake retry for `performance` and `rebuild-cycle` classes — those have their own multi-run rubrics in Steps 8e and 8f.

**Match rubric.** LLM compares `baseline-transcript.log` to the issue's "Actual result" / error description. Match criteria, in order:

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

LLM rewrites `./reproducer.sh` using the full issue context (description, environment, symptoms) **plus the baseline transcript** so it can react to what actually happened. Apply **−30 confidence penalty** (or keep it if 8b already applied it for the missing-verbatim case).

```bash
brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
# Same PATH safeguard as Step 8b — non-login shells don't pick up ~/.local/bin
# automatically, and an empty PATH here misreads as `nemoclaw: command not found`
# which would route to `verify-inconclusive` for the wrong reason.
brev exec "$INSTANCE_NAME" 'export PATH="$HOME/.local/bin:$PATH" && bash ~/reproducer.sh' 2>&1 | tee ./baseline-transcript-2.log
```

- **Match:** validated (with −30 baked in). Proceed to 8d.
- **Still no match:** mark `verify-inconclusive`. Post a comment that includes both reproducer attempts and both baseline transcripts with the message "couldn't establish a working reproducer for this bug on `$REPORTED_VERSION`." **Skip 8d** — there's nothing to verify on latest.

### Step 8d: Install latest, run validated reproducer

```bash
brev exec "$INSTANCE_NAME" "$RESET"
brev exec "$INSTANCE_NAME" "
  if [ -f ~/.nvidia-api-key ]; then export NVIDIA_API_KEY=\$(cat ~/.nvidia-api-key); fi
  curl -fsSL $INSTALL_URL | bash
"

# Same resolved-version check as Step 8a — guard against env-var scoping or default fallthrough
# silently installing the wrong version. The latest install should resolve to $LATEST.
RESOLVED=$(brev exec "$INSTANCE_NAME" "bash -lc 'nemoclaw --version'" 2>&1 | tail -1)
echo "[verify-stale] latest requested: $LATEST; resolved: $RESOLVED"
case "$RESOLVED" in
  *"$LATEST"*) ;;  # match — proceed
  *) echo "WARN: latest install resolved to '$RESOLVED' (expected match for $LATEST). Proceeding but flag in comment." ;;
esac

# OpenShell version pin — surfaced from #1642's e2e run. Latest's blueprint.yaml may set
# `max_openshell_version` below what the OpenShell installer would otherwise grab. The
# baseline phase (Step 8a) installed whichever OpenShell was current at reported-version,
# which can be newer than latest's cap (e.g., reported v0.0.6 → installed openshell 0.0.37,
# latest v0.0.38 caps at 0.0.36, onboard preflight refuses to run). Re-pin from latest's
# repo so onboard preflight passes; if the new pin is OLDER than the installed binary,
# install-openshell.sh refuses the downgrade — fall back to direct GitHub download.
brev exec "$INSTANCE_NAME" '
  set -e
  cd ~/NemoClaw
  git fetch --depth 1 origin tag "'"$LATEST"'" 2>&1 | tail -2
  git checkout -- . 2>/dev/null || true
  git checkout "'"$LATEST"'" 2>&1 | tail -2

  MAX_OS=$(grep -E "^max_openshell_version:" nemoclaw-blueprint/blueprint.yaml 2>/dev/null | awk "{print \$2}" | tr -d "\"" | tr -d "v")
  CUR_OS=$(openshell --version 2>&1 | grep -oE "[0-9]+\.[0-9]+\.[0-9]+" | head -1 || echo 0.0.0)
  echo "[verify-stale] openshell pin: blueprint max=$MAX_OS, currently installed=$CUR_OS"

  if [ -n "$MAX_OS" ] && [ "$(printf "%s\n%s\n" "$CUR_OS" "$MAX_OS" | sort -V | tail -1)" != "$MAX_OS" ]; then
    echo "[verify-stale] currently installed openshell ($CUR_OS) is newer than blueprint cap ($MAX_OS) — force-downgrading"
    sudo rm -f /usr/local/bin/openshell
    cd /tmp
    curl -fsSL "https://github.com/NVIDIA/OpenShell/releases/download/v$MAX_OS/openshell-x86_64-unknown-linux-musl.tar.gz" -o openshell-pin.tar.gz
    tar -xzf openshell-pin.tar.gz
    sudo install -m 755 ./openshell /usr/local/bin/openshell
    openshell --version
  else
    sudo bash scripts/install-openshell.sh 2>&1 | tail -3
  fi
'

brev copy ./reproducer.sh "$INSTANCE_NAME":~/reproducer.sh
# Same PATH safeguard as the baseline call — non-login shells don't pick up ~/.local/bin
# automatically. The reproducer's internal `sg docker -c '...'` blocks cover Docker access.
brev exec "$INSTANCE_NAME" 'export PATH="$HOME/.local/bin:$PATH" && bash ~/reproducer.sh' 2>&1 | tee ./latest-transcript.log
```

If the install of **latest** fails (e.g. installer regression — see #3058 for a current example), this is an infra failure — see Step 11. Do not score or label the issue.

If install succeeds, `latest-transcript.log` is the input to Step 9 scoring.

For interactive debugging when something looks off:

```bash
brev shell "$INSTANCE_NAME"
```

---

## Step 8d.5: Architectural-Drift Check

Cross-version verification compares two moving targets: the reproducer assumes `$REPORTED_VERSION`'s tooling surface, and `$LATEST` may have rewritten the surface entirely. If the *tool* the reproducer relies on (CLI subcommand, output table, log file location) was reworked between the two tags, an "empty / clean output on latest" can mean either "bug fixed" OR "we're looking at a deprecated tracking surface." Without this check, the latter silently registers as the former — a class of false positive.

**Detection** — pickaxe the diff between tags for the reproducer's tool name and watch for the CLI itself being touched, not just its consumers:

```bash
# Extract the primary verification command from the reproducer (e.g. "openshell forward list").
# Use mapfile + a quoted-array iteration so multi-word tool strings ("openshell forward")
# stay intact — bare `for t in $TOOL` word-splits them on whitespace and would pickaxe
# `openshell` and `forward` separately, weakening the drift signal.
mapfile -t TOOLS < <(grep -oE '\b(openshell|nemoclaw)[[:space:]]+[a-z-]+' reproducer.sh | sort -u)

# Pickaxe each tool name across the version range.
for t in "${TOOLS[@]}"; do
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
- Quote the multi-axis evidence in the Step 10 comment as a table; this is exactly what makes "fixed" defensible when the original tooling no longer reflects the underlying behavior.
- If any axis still shows the buggy state, the bug is NOT fixed even if the reproducer's surface is clean. Escalate to "still reproduces" (Step 9 special case).

**When drift is NOT suspected** (the reproducer's tool is unchanged in the version range): the reproducer's expected output is sufficient, no multi-axis verification needed.

---

## Step 8e: Performance-Bug Verification (when `BUG_CLASS=performance`)

Performance bugs (#2598 "10s P50", #2600 "hangs ~2 min", #2733 Ollama tool-call leak over time) can't be answered by the standard exit-code + symptom-phrase rubric — one clean reproducer run doesn't tell you the p50 budget is met; one slow run doesn't tell you the bug still reproduces. Replace Step 8b's match with a measurement-and-distribution rubric:

1. **Parse the SLA from the issue body.** Extract numeric latency thresholds: `10s P50`, `200ms`, `under 5 seconds`, `~2 min`. Save as `SLA_P50_MS`, `SLA_P90_MS`, etc. If no numeric SLA is in the body, route to Step 8c synth-repro to ask the reporter (via comment) for one — without a target, the verdict is undefined.
2. **Run the reproducer N=10 times** on each side (baseline + latest), capturing per-run latency:

   ```bash
   for i in $(seq 1 10); do
     /usr/bin/time -f '%e' bash ~/reproducer.sh >/dev/null 2>>./latest-perf.log
   done
   ```

3. **Compute p50 and p90** for both sides, in milliseconds (to match the `_MS`
   units of `SLA_P50_MS` / `SLA_P90_MS`). `/usr/bin/time -f '%e'` emits
   seconds, so multiply by 1000 in the awk:

   ```bash
   # p50 = mean of the 5th and 6th values (standard median for even N), in ms.
   P50_MS=$(sort -n ./latest-perf.log \
     | awk 'NR==5||NR==6 {sum+=$1; n++} END {printf "%d", (sum/n)*1000}')
   # p90 = 9th value (nearest-rank / NIST method for N=10), in ms.
   P90_MS=$(sort -n ./latest-perf.log | awk 'NR==9 {printf "%d", $1*1000}')
   echo "[perf] latest p50=${P50_MS}ms p90=${P90_MS}ms"
   ```

   Apply the same two lines to `./baseline-perf.log` for the baseline side
   (export as `BASELINE_P50_MS` / `BASELINE_P90_MS`).
4. **Match rubric (p50 fires first; p90 is the regression backstop):**
   - Latest's p50 within `$SLA_P50_MS` AND baseline's p50 outside → bug fixed; same Step 9 scoring (subject to baseline-validation gate).
   - Latest's p50 outside `$SLA_P50_MS` → bug still reproduces (Step 9 special case).
   - Latest's p50 within `$SLA_P50_MS` AND baseline's p50 also within → reproducer doesn't actually exercise the bug; route to Step 8c synth-repro.
   - **p90 backstop**: if `$SLA_P90_MS` was parsed from the issue, latest's p90 outside `$SLA_P90_MS` flips a within-SLA-p50 verdict to `still-reproduces` — tail-latency regressions matter for the issues that name them.

**Hardware-substitution caveat.** Performance numbers are silicon-dependent. When the issue is `Platform: DGX Spark` or `Platform: GB10` and we're measuring on a Brev x86 GPU SKU, the comment must say so explicitly: a Brev p50 of 1.5s on a `H100` does not prove the DGX Spark p50 is fixed. Cap the score at 60 unless the bug is clearly silicon-independent (e.g. an algorithmic regression in user-space JS that would manifest the same on any silicon).

---

## Step 8f: Rebuild-Cycle Verification (when `BUG_CLASS=rebuild-cycle`)

Rebuild-cycle bugs (#2701 "Pod recreate wipes `/tmp/nemoclaw-proxy-env.sh`," issues describing "configuration is not persisted across rebuilds") only manifest when sandbox state crosses a destroy/recreate boundary. A single onboard run can't trigger the symptom. Replace Step 8b's match with a run-rebuild-rerun harness:

1. **First onboard.** Run the reproducer once to establish initial state. Capture relevant artifacts (config files, env vars, sandbox metadata) — the issue body usually names what should persist:

   ```bash
   brev exec "$INSTANCE_NAME" "sg docker -c 'cat <files-mentioned-in-issue> 2>&1'" | tee ./pre-rebuild.log
   ```

2. **Trigger the rebuild.** Use `nemoclaw destroy --all --force` followed by `nemoclaw onboard` with the same env vars. Do NOT comprehensive-reset between (the point is to test the destroy/recreate, not start from scratch).

3. **Re-capture the same artifacts** post-rebuild:

   ```bash
   brev exec "$INSTANCE_NAME" "sg docker -c 'cat <same-files> 2>&1'" | tee ./post-rebuild.log
   ```

4. **Diff and match.** The bug is "X gets wiped / changes / regresses across rebuild." Compare pre-rebuild vs post-rebuild captures to the issue's expected behavior:
   - Pre and post agree (artifact preserved) AND issue says it should be preserved → bug fixed
   - Pre and post differ (artifact wiped) AND issue says it gets wiped → bug still reproduces
   - Pre and post agree AND issue says it gets wiped → reproducer doesn't exercise the bug; Step 8c synth-repro

The harness still uses Step 9's scoring framework — `+50 latest clean (artifact preserved)`, etc. — but the "what gets compared" axis is the diff, not the symptom phrase.

---
