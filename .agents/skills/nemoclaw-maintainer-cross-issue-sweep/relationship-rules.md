# Relationship Classification Rules

The four classes the LLM assigns to each candidate issue, with worked examples.

## Contents

- ADJACENT_FIX
- CONTRADICTING
- SAME_ISSUE_DIFF
- UNRELATED

## ADJACENT_FIX

The PR's changes resolve this issue OR open a clear follow-on path on the same code the PR just touched.

### Example A — incidental closure (direct evidence)

PR description: "fix EACCES when shields-down user writes config"
PR diff: adds `chmod g+w` to `.openclaw` directory at startup
Candidate issue #2810: "Telegram preset writes fail intermittently after sandbox rebuild"
Issue body cites: "EPERM on `.openclaw/credentials/telegram.json`"

**Classification:** ADJACENT_FIX, high confidence
**Evidence cited (direct):** PR diff `Dockerfile.base:97` (chmod g+w on .openclaw); issue body line 14 ("EPERM on .openclaw/credentials/telegram.json"). Same root cause, same fix.

### Example B — follow-on hardening on PR-introduced code

PR #2696 introduced `scripts/rcf_patch.py` with regex-based property matching.
Candidate issue #2875: "Harden rcf_patch.py against property-order drift" — issue says PR #2696 is "a real improvement... one follow-on hardening gap: the regex still assumes `snapshot` before `nextConfig`."

**Classification:** ADJACENT_FIX, high confidence (boosted by reverse-link)
**Evidence cited (follow-on):** PR introduced `scripts/rcf_patch.py`; issue requests hardening the same file's regex against a specific drift case. The PR's code is the subject of the issue's hardening request, not a separate concern.

## CONTRADICTING

The PR's approach makes this issue's desired behavior impossible, OR the PR's scope is incomplete and the issue reports the leftover gap.

### Example A — direct contradiction

PR description: "remove silent EACCES swallow from Patch 4b"
PR diff: deletes try/catch around `mutateConfigFile`
Candidate issue #4187: "Allow opt-in error suppression for sandbox config writes during shutdown"

**Classification:** CONTRADICTING, medium confidence
**Evidence cited (direct):** PR diff removes `try { ... } catch { /* swallow */ }` at `Dockerfile:142`; issue body line 8 explicitly requests "opt-in suppression for shutdown-time write failures." PR strictly rejects what issue requests.

### Example B — partial-fix gap (evidence by omission)

PR #2700 changed 5 env-var validations from `return 1` to `return 0` in `scripts/nemoclaw-start.sh`.
Candidate issue #2762: "PR #2700 changed validations... However... NEMOCLAW_CONTEXT_WINDOW and NEMOCLAW_MAX_TOKENS with invalid values still cause the container to exit with code 1."

**Classification:** CONTRADICTING, high confidence (boosted by reverse-link)
**Evidence cited (by-omission):** Bug class — env-var validation hard-exits under `set -euo pipefail`. PR fixed instances `NEMOCLAW_MODEL_OVERRIDE`, `NEMOCLAW_INFERENCE_API_OVERRIDE`, `NEMOCLAW_REASONING`, `NEMOCLAW_CORS_ORIGIN`, plus one more. Instances PR did NOT touch: `NEMOCLAW_CONTEXT_WINDOW`, `NEMOCLAW_MAX_TOKENS`. Issue reports same hard-exit class on those exact untouched instances. The PR's incomplete scope is the contradiction with the issue's expectation of a class-level fix.

## SAME_ISSUE_DIFF

The candidate issue describes the same root bug as the PR's primary linked issue. Suppress to avoid double-counting.

**Example:**

PR's primary issue: #2681 ("Enable Dreaming permission error")
Candidate issue #2895: "Toggle in OpenClaw UI fails with EACCES"

Both describe the same EACCES failure on the same toggle. The candidate is a duplicate of the primary issue. **Classification:** SAME_ISSUE_DIFF (suppressed from output).

## UNRELATED

No meaningful relationship. The candidate showed up in search because of token overlap but doesn't align with the PR's actual changes.

**Example:**

PR description: "extract sandbox-gateway-state helpers"
Candidate issue #4523: "Sandbox gateway timeout on first connect"

Search matched on "gateway." But the PR is a pure refactor (no behavior change), and the issue is about timing. **Classification:** UNRELATED.

## Decision rule

If the LLM cannot cite a specific PR diff line **and** a specific issue symptom that map to each other, the answer must be UNRELATED. This prevents hallucinated matches.
