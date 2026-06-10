<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Environment and Reproducer Reference

Use after a candidate passes selection. Classify the environment, prompt for provider credentials when required, extract the reproducer, verify preconditions, and try the local-first path.

## Contents

- [Step 5: Classify the Verification Environment](#step-5-classify-the-verification-environment)
- [Step 6: Extract the Reproducer](#step-6-extract-the-reproducer)
- [Step 6.5: Verify Preconditions](#step-65-verify-preconditions)
- [Step 6.7: Try Local Reproduction First](#step-67-try-local-reproduction-first)

---

## Step 5: Classify the Verification Environment

**CPU vs GPU:** GPU if any of these signals are present, else CPU.

- Labels: `Platform: GB10`, `Platform: DGX Spark`.
- Body keywords (whole-word, case-insensitive): `nvidia-smi`, `cuda`, `H100`, `A100`, `L40S`, `L4`, `T4`, `GB10`, `DGX`, `vllm`, `tensorrt`. Match as whole words — `inference` and `model serving` are too noisy (e.g. `models.providers.inference.baseUrl` is a config path on CPU bugs, not a GPU need) and intentionally excluded.

CPU default keeps cost low. Only escalate to GPU when the reproducer needs one.

**Bug class classification.** In addition to CPU/GPU, classify the bug's verification shape so Step 8 routes to the right rubric. Classes are mutually exclusive — pick the first that matches:

| Class | Detection heuristic | Routes to |
|---|---|---|
| `performance` | Body or title mentions latency thresholds (`P50`, `P90`, `ms`, `seconds`, `slow`, `hangs`, `timeout` with a numeric value), or mentions `memory leak` / `over time` / `eventually` | Step 8e (multi-run distribution rubric) |
| `rebuild-cycle` | Body mentions `rebuild`, `recreate`, `restart`, `pod recreate`, `across rebuilds`, `after restart`, `survives a destroy` | Step 8f (run-rebuild-rerun harness) |
| `log-only` | Body's symptom is logs-not-stdout: `see lots of error in <X> log`, `os.networkInterfaces guard errors`, anything pointing at a specific log file rather than the reproducer's stdout/stderr | Step 8b's match rubric extended with log-scraping |
| `functional` (default) | Everything else — exit code + stdout/stderr matching | Step 8b standard rubric |

Most bugs are `functional`. The other three classes need verification harnesses that the standard rubric can't produce honestly — e.g., one clean run of a perf reproducer doesn't tell you the p50 budget was met; one onboard run doesn't tell you a config survives a rebuild. Set `BUG_CLASS=<class>` so downstream steps can branch.

**Provider classification.** Some bugs are tied to a specific inference provider (NVIDIA NIM, Gemini, Anthropic, OpenAI) and won't reproduce faithfully under Ollama substitution. Classify which provider the issue references so downstream steps either prompt for the right API key or accept the substitution penalty:

| Detection signal | Provider |
|---|---|
| `Provider: NVIDIA` label, body mentions `NVIDIA NIM`, `build.nvidia.com`, `nvapi-...`, `NVIDIA_API_KEY`, or `NEMOCLAW_PROVIDER=build` | `nim` |
| `Provider: Gemini` label, body mentions `Gemini`, `gemini-flash`, `gemini-pro`, `GEMINI_API_KEY` | `gemini` |
| `Provider: Anthropic` / `Provider: AWS` (Bedrock) labels or matching keywords | `anthropic`/`bedrock` |
| `Provider: Ollama`, body mentions `ollama` or `NEMOCLAW_PROVIDER=ollama`, or no provider mentioned at all | `ollama` (default) |

Set `BUG_PROVIDER=<provider>`.

**Required-API-key prompt.** When `BUG_PROVIDER` is anything other than `ollama` AND the bug's reproducer actually exercises inference (not pure CLI surface or sandbox build), the skill MUST stop here and prompt the maintainer interactively before any Brev cost is incurred:

```text
The reporter's reproducer uses the <provider> provider, which requires a real API key
to verify faithfully. Three options:

  1. Provide an API key via file (NEVER on the command line — keys in argv are
     visible in `ps -ef` to anyone with shell access on either machine, and
     inline `printf '...' '<key>'` leaves the key in shell history). Read the
     key with a no-echo, no-history prompt, then write it to a 600-perm file
     on your laptop:

       umask 077
       IFS= read -rs -p 'NVIDIA_API_KEY (input hidden): ' NVIDIA_API_KEY
       printf '%s' "$NVIDIA_API_KEY" > ~/.nvidia-api-key
       unset NVIDIA_API_KEY
       chmod 600 ~/.nvidia-api-key
       echo  # restore newline after the hidden read

     The skill copies the file to the Brev box via `brev copy` (encrypted SSH),
     reads it inside the box with `NVIDIA_API_KEY=$(cat ~/.nvidia-api-key)`,
     and never puts the value on a command line. Box deletion removes the file
     from the box; you should `rm ~/.nvidia-api-key` on your laptop after the
     run.

  2. Substitute Ollama and accept the -30 confidence penalty (per Step 8a.5). The
     verdict will be capped because we're not exercising the real provider's code
     path.

  3. Skip this issue. Mark `verify-inconclusive` with the reason "requires <provider>
     API key — not provided in this run."

Choose 1, 2, or 3:
```

This prompt blocks before Step 7 provisions a box. Don't burn cost on a verification path the maintainer hasn't agreed to.

**API-key propagation pattern (for option 1).** Argv exposure is a two-layer problem and the file-based pattern must extend to both layers.

**Layer 1 — local → Brev (surfaced #2604).** Passing the key as `NVIDIA_API_KEY=<value> brev exec ...` puts the literal value in the brev exec process's argv on the maintainer's laptop *and* on the Brev box (since brev exec serializes argv to the remote shell). Visible in `ps -ef` on both ends for the duration of the run. Use file-based copy:

```bash
# After Step 6.5 preconditions, copy the local key file to the Brev box.
[ -f ~/.nvidia-api-key ] && brev copy ~/.nvidia-api-key "$INSTANCE_NAME":~/.nvidia-api-key
brev exec "$INSTANCE_NAME" "chmod 600 ~/.nvidia-api-key 2>/dev/null || true"
```

**Layer 2 — on-box subshell (surfaced #2611).** Inside scripts running on the Brev box, the outer shell reads the key from `~/.nvidia-api-key` cleanly, but a *naive* inner subshell call leaks it back into argv:

```bash
# WRONG — the double-quoted outer heredoc interpolates $NVIDIA_API_KEY at
# script-eval time, so the literal nvapi- value lands in `sg docker -c "..."`'s
# argv and shows up in `ps -ef` on the box for the whole onboard window.
NVIDIA_API_KEY=$(cat ~/.nvidia-api-key)
sg docker -c "
  export NVIDIA_API_KEY='$NVIDIA_API_KEY'   # ← argv leak
  nemoclaw onboard ...
"

# RIGHT — escape the $ so the outer shell does not interpolate, and let the
# inner subshell read the file itself. Argv contains the command string
# `cat ~/.nvidia-api-key`, not the value.
sg docker -c "
  export NVIDIA_API_KEY=\$(cat ~/.nvidia-api-key)
  nemoclaw onboard ...
"
```

The same rule applies to any `bash -c "..."`, `bash -lc "..."`, `su -c "..."`, `ssh host "..."`, or other invocation that takes a command string as a single argv element: **never interpolate the key into the string at the outer shell's eval time**. Read the file inside the inner shell so the value lives in env-vars, never in argv.

Cleanup: when the trap fires `brev delete`, the box (and the key file on it) goes away. On the maintainer's laptop, the file persists until they `rm ~/.nvidia-api-key` — Step 12's session log should remind them. **If the key was previously propagated via cmdline (pre-fix at either layer), treat it as exposed and rotate.**

**Pure-CLI / pure-sandbox-build bugs are exempt** — those don't actually exercise inference, so the provider doesn't matter even if the issue body mentions one. Heuristic: if Step 6.7's local-first predicate would have fired (no sandbox state, no model server interaction), skip the prompt.

---

## Step 6: Extract the Reproducer

Extract whatever's available from the issue body. The decision about *whether the reproducer is good enough* lives in Step 8 (validate-on-baseline), not here.

NV QA files most bugs through an HTML form, so issue bodies are typically a mix of `<pre>...</pre>` blocks and tables — not markdown fenced code blocks. Extraction must handle both shapes.

1. **Verbatim:** the first markdown fence (```` ``` ```` or ```` ~~~ ````) **or** HTML `<pre>` block containing a `nemoclaw` invocation. Strip surrounding tags and unescape HTML entities before saving to `./reproducer.sh`. No confidence penalty (yet).
2. **No verbatim block found:** leave `./reproducer.sh` absent. Step 8b will synthesize from the issue body on demand and apply the **−30 synth penalty** at that point.

A robust extractor handles both shapes with the body fetched as JSON. The "anchor word" — what marks a block as a reproducer — must include `nemoclaw`, `openclaw`, AND `openshell`. Issue #2592 surfaced this gap: its reproducer was `openclaw channels add telegram` run inside the sandbox; a `nemoclaw`-only regex would have missed the verbatim block and forced the run through Step 8c synth-repro with a -30 penalty:

```bash
BODY=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json body -q .body)

REPRODUCER=$(printf '%s' "$BODY" | python3 -c '
import re, sys, html
b = sys.stdin.read()
# Anchor word: any of nemoclaw / openclaw / openshell. Issue bodies use whichever
# tool the reporter ran (host-side nemoclaw vs in-sandbox openclaw vs openshell CLI).
ANCHOR = r"(?:nemoclaw|openclaw|openshell)"
m = re.search(rf"```(?:bash|sh)?\n(.*?{ANCHOR}.*?)\n```", b, re.S)
if not m: m = re.search(rf"~~~(?:bash|sh)?\n(.*?{ANCHOR}.*?)\n~~~", b, re.S)
if not m: m = re.search(rf"<pre[^>]*>(.*?{ANCHOR}.*?)</pre>", b, re.S)
if m:
    text = re.sub(r"<[^>]+>", "", m.group(1))
    print(html.unescape(text).strip())
')

[ -n "$REPRODUCER" ] && printf '%s\n' "$REPRODUCER" > ./reproducer.sh
```

The "give up immediately" path is gone. Synthesis happens at validation time so it has the baseline transcript to react to, not just the issue body in isolation. The give-up decision now lands in Step 8c when synth fails to produce a script that actually exposes the bug.

---

## Step 6.5: Verify Preconditions

Confirm CLI dependencies are available, `brev` is authenticated, and the install URL resolves before paying any cost. Credentials live in `~/.brev/credentials.json` and are reused across shells under the same OS user, so once authenticated the auth check is a no-op until the token expires.

```bash
# CLI deps — fail fast if anything later in the skill needs them but they're missing.
for cmd in gh brev jq python3 curl; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: missing required dependency: $cmd"; exit 1; }
done

# gh identity — every comment posted by Step 10 lands under whatever account `gh` is currently
# authenticated as. Surface that explicitly so the maintainer notices before a public comment
# lands under the wrong handle (this matters when `gh` is multi-token, after a recent re-auth,
# or when running under a service-account hostname).
GH_IDENTITY=$(gh api user --jq .login 2>/dev/null)
if [ -z "$GH_IDENTITY" ]; then
  echo "ERROR: gh CLI is not authenticated. Run: gh auth login   # then re-run this skill"
  exit 1
fi
echo "gh identity: @$GH_IDENTITY — comments posted by this run will appear under this handle"

# gh 'project' scope — Step 10 moves fixed-on-latest issues to "Needs Review" on Project 199. Warn if missing.
gh auth status 2>&1 | grep -q "'project'" || echo "[verify-stale] WARN gh missing 'project' scope — Step 10 tracker move will skip. Fix: run 'gh auth refresh -h github.com -s project' in a real terminal."

# Brev auth — short-circuit only after the auth check, not before.
# When auth fails, give the user a directive recipe (the browser-flow path is
# what works from non-TTY harnesses like Claude Code, not the headless options).
brev ls --json >/dev/null 2>&1 || {
  cat <<'MSG'

ERROR: Brev not authenticated. ~/.brev/credentials.json is missing or the token expired.

What to do (works from any harness, including non-TTY agent contexts):

  1. Open a separate Terminal on your laptop.
  2. Run:   brev login
     A browser opens; complete the auth flow; the CLI exits on success.
  3. Come back here and re-run this skill. Credentials persist to
     ~/.brev/credentials.json and every subsequent `brev` call picks them up.

Headless / no-browser alternatives (when option 1 isn't available):
  - brev login --skip-browser            # prints a URL, paste into any browser
  - brev login --token "$BREV_API_TOKEN" # non-interactive; same env var used
                                         # by test/e2e/brev-e2e.test.ts

MSG
  exit 1
}

# Repo labels exist — Step 8.5 / Step 10 can't apply a label that doesn't exist. Check
# canonical label names against the live repo so a mismatch fails fast (issue #2168 hit this:
# spec called the label `wontfix`, but the actual repo label is `status: wont-fix`).
EXPECTED_LABELS=("fixed-on-latest" "verify-inconclusive" "status: wont-fix")
LIVE_LABELS=$(gh label list --repo NVIDIA/NemoClaw --limit 200 --json name --jq '.[].name')
for label in "${EXPECTED_LABELS[@]}"; do
  printf '%s\n' "$LIVE_LABELS" | grep -Fxq "$label" || {
    echo "ERROR: expected label not on repo: '$label'"
    echo "       create it with: gh label create '$label' --repo NVIDIA/NemoClaw"
    exit 1
  }
done

# Install URL reachable — fails fast instead of mid-Brev-run if the host is down or the URL changed.
# The default is the public Akamai-hosted entry (301-redirects to the actual installer). The
# `nemoclaw.nvidia.com` host that earlier drafts pointed to is NVIDIA-internal and does not
# resolve from Brev; surfaced during the #2007 e2e run.
INSTALL_URL=${NEMOCLAW_INSTALL_URL:-https://www.nvidia.com/nemoclaw.sh}
curl -fsI "$INSTALL_URL" >/dev/null 2>&1 || {
  echo "ERROR: install URL not reachable: $INSTALL_URL"
  echo "  - Check https://www.nvidia.com/nemoclaw.sh is up (the default Akamai-hosted entry)."
  echo "  - Override with NEMOCLAW_INSTALL_URL=<alternate-url> if your team mirrors the installer."
  echo "  - Then re-run this skill."
  exit 1
}
```

---

## Step 6.7: Try Local Reproduction First

For pure-CLI reproducers (no sandbox state, no GPU, no integration tokens), try locally before paying for a Brev box. The evidence is identical — `nemoclaw <args>` on a maintainer laptop produces the same exit code and stdout as on a fresh Brev VM, modulo platform differences — and the run is free.

**Predicate** — local-first applies if **all** of these hold:

- Reproducer is a sequence of `nemoclaw <args>` invocations only. No `docker`, `kubectl`, `curl`, `npm`, networking setup, or filesystem fixtures.
- Issue has no `Sandbox`-only or `Docker` label and no GPU signal from Step 5.
- `which nemoclaw` resolves on the maintainer's machine and `nemoclaw --version` reports a build at or past `$LATEST` (a build between `$LATEST` and `$LATEST+main` is fine — these only differ by unmerged WIP).
- Maintainer is on Linux or macOS. Windows local repros are out of scope (per Step 3 platform skip rules).

**If the predicate fires:**

```bash
LOCAL_VERSION=$(nemoclaw --version 2>&1)
LOCAL_TRANSCRIPT=$(mktemp)
{ time bash reproducer.sh; } >"$LOCAL_TRANSCRIPT" 2>&1
LOCAL_EXIT=$?
echo "Local: $LOCAL_VERSION, exit $LOCAL_EXIT"
```

Compare local result to the issue's "Actual Result" section using the same match rubric Step 8b applies on baseline. The two ways the predicate can fire route to different verdicts — do not collapse them:

- **Local matches the reported-bug symptom** (same exit code + same diagnostic output as the issue's "Actual Result") → route to `still-reproduces`. Use the local transcript as the verified-on-latest evidence. Step 10's comment must say `Environment: local install (<version>) — Brev provisioning skipped, bug confirmed live on latest from CLI surface alone`.
- **Local matches the expected-fixed behavior** (the symptom is gone — exit code and output are what the issue says *should* happen after the fix) → route to `fixed-on-latest`. Use the local transcript as the verified-on-latest evidence. Step 10's comment must say `Environment: local install (<version>) — Brev provisioning skipped, outcome deterministic from CLI surface alone`.
- **Local result differs from both** (neither the reported symptom nor the expected-fixed behavior) → continue to Step 7 and run on Brev. The local environment may be a confound (different OS, dirty config, partial build); remote confirms.
- **Local repro errors out for environmental reasons** (`nemoclaw: command not found`, npm link broken) → continue to Step 7. Treat as inconclusive locally, not a verification failure.

**If the predicate does not fire:** proceed to Step 7 normally. Most sandbox-touching bugs need Brev.

---
