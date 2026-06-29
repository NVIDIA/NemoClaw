<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Scoring, Comments, Project Fields, and Logging Reference

Use after a latest result exists or after a by-design/inconclusive branch is selected. Covers confidence scoring, redaction, concise comments, authorized Project updates, infra failures, and activity logging.

## Contents

- [Step 9: Score Confidence](#step-9-score-confidence)
- [Step 10: Compose and Post the Comment](#step-10-compose-and-post-the-comment)
- [Step 11: Infra Failure Handling](#step-11-infra-failure-handling)
- [Step 12: Log to Activity](#step-12-log-to-activity)
- [Cadence](#cadence)
- [Out of Scope (v1)](#out-of-scope-v1)
- [Companion Behavior](#companion-behavior)

---

## Step 9: Score Confidence

Start at 0. Apply each rule that fires.

| Signal | Delta |
|---|---|
| Reproducer ran cleanly on **latest** (8d), exit 0, no bug symptom observed | +50 |
| Commits between reported version and `$LATEST` touch the implicated component (see "Path extraction" below) | +25 |
| A merged PR mentions this issue number or its symptom (see "PR search" below) | +25 |
| Reproducer was LLM-synthesized at any point (Step 8b synth or Step 8c retry) | −30 |
| Any partial error, warning, or flaky behavior in the latest run (8d) | −50 |

Total is clamped to `[0, 100]`.

### Path extraction (for the +25 commits signal)

The skill needs to know *which* path to `git log v<reported>..$LATEST -- <path>` against. Apply in order, stop at the first that yields a non-empty path:

1. **Stack trace / file path mentions in the issue body.** Grep the body for absolute paths under known install roots, then map to repo paths:
   - `/usr/local/lib/nemoclaw/<rel>` → `<rel>` in repo (e.g., `scripts/generate-openclaw-config.py`)
   - `/usr/local/bin/nemoclaw*` → `bin/`
   - `~/.nemoclaw/<rel>` → most often runtime state, drop unless the bug is config-related → `src/lib/config/`
   - In-repo paths (e.g., `bin/lib/policies.js` mentioned literally) → use as-is
2. **Canonical routing-label-to-directory map.** Pick the first match. Drop paths that do not exist at `$LATEST`.
   - `area: cli` → `bin/`, `src/commands/`, `src/lib/cli/`
   - `area: sandbox` → `src/lib/sandbox/`, `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/`
   - `platform: container` or `area: packaging` → `Dockerfile`, `Dockerfile.base`, `scripts/install-openshell.sh`, `scripts/install.sh`
   - `area: install` or `area: onboarding` → `scripts/install.sh`, `src/lib/onboard/`
   - `area: policy` → `nemoclaw-blueprint/policies/`, `nemoclaw/src/blueprint/`
   - `area: messaging` → `src/lib/messaging/`
   - `integration: *` with no body path → skip the +25 signal; no generic integration directory owns every integration.
3. **Title keywords.** "policy" → `nemoclaw-blueprint/policies/`, `nemoclaw/src/blueprint/`. "inference" → `docs/inference/` is docs-only; skip the +25 signal unless source 1 surfaces actual code paths.

If none of the above produces a path, **skip the +25 signal entirely** rather than guessing. Floating the +25 on every issue would inflate scores meaninglessly.

### PR search (for the +25 PR signal)

```bash
# Direct issue-number reference (covers most cases — "fixes #2861" etc.)
DIRECT_REF=$(gh pr list --repo NVIDIA/NemoClaw --state merged \
  --search "$ISSUE_NUMBER" \
  --json number,title,mergedAt,body \
  -q "[.[] | select((.body + \" \" + .title) | test(\"#$ISSUE_NUMBER\\\\b\"))]")

# Symptom-phrase fallback (only if direct reference returns nothing)
if [ -z "$DIRECT_REF" ] || [ "$DIRECT_REF" = "[]" ]; then
  SYMPTOM=$(extract first key error/symptom phrase from issue body, ~3-6 words)
  SYMPTOM_REF=$(gh pr list --repo NVIDIA/NemoClaw --state merged \
    --search "\"$SYMPTOM\"" \
    --json number,title,mergedAt)
fi
```

Apply +25 if either query returns at least one PR with `mergedAt` strictly after the tag date of `$REPORTED_VERSION` (look up via `git log -1 --format=%cI v$REPORTED_VERSION`). PRs merged before the reporter even filed the issue can't have fixed it.

If neither query returns anything, **skip the +25 signal**.

**Baseline-validation gating.** The +50 weight assumes the reproducer was *validated* — i.e., it produced the bug symptom on baseline (Step 8b/8c match). If `BASELINE_INSTALL_FAILED=1` (Step 8a fall-through, baseline pass skipped — including the sandbox-build-rot case from Step 11), the +50 still applies but **cap the total at 84**. Corroboration signals (commits-touched-area, PR-mention) still raise the score within the cap but cannot lift it above 84. Without runtime baseline confirmation we don't have enough on our own to claim ≥85 — the cap forces the verdict into the 60–84 band where the reporter is asked to confirm. The previous draft of this rule had an "unless commits-touched OR PR-mention also fires" escape hatch that let inferred fix evidence bypass the cap entirely; that produced a misleading 100/100 on the #2007 e2e run despite zero baseline confirmation, and was tightened here.

**Action (when latest run was clean — bug not reproduced):**

| Score | Verdict | Proposed Project action | Comment |
|---|---|---|---|
| ≥85 | `fixed-on-latest` | `Needs Review` | Evidence-rich; ask the reporter to confirm. |
| 60–84 | `fixed-on-latest` | `Needs Review` | Evidence-rich; ask the reporter to confirm and state the confidence cap. |
| <60 | `verify-inconclusive` | No field change | Short, honest "couldn't verify" explanation. |

Verdict names are comment and log vocabulary, not GitHub labels. Prepare the exact comment, Project update, assignment, and durable verdict marker as a dry run with `human_review_required: true`; apply only the accepted write set.

**Special case: latest output matches the issue symptom (bug still reproduces on latest).**

This is not a flake — the skill positively confirmed the bug is still live. Don't apply the +50 weight (the bug isn't fixed) and skip the score table entirely.

- Post a 30–80 word "still reproduces on latest" comment without transcripts. Keep the redacted baseline/latest transcripts in the local activity log as evidence.
- Make no Project field or label change.
- Include the marker `<!-- nemoclaw-verify-stale v1 verdict=still-reproduces YYYY-MM-DD -->` with today's date so the candidate filter applies the 7-day TTL (Step 3 idempotency).
- Next weekly run picks the issue back up after the TTL — if the bug gets fixed in the meantime, that run catches it.

The skill **never closes issues** in any branch. Project fields, assignments, and public comments require explicit approval of the proposed write set.

---

## Step 10: Compose and Post the Comment

**Redaction pass before posting.** Run on **every** chunk of text quoted in the comment — issue body excerpts, baseline transcript, latest transcript, synth-repro scripts. Replace each match with `[REDACTED]`. The transcripts especially leak — they include full stdout/stderr from real installs and runs.

**HTML → text pre-pass for issue body excerpts.** NV QA bodies are HTML; tokens nested in `<pre>` tags or HTML attributes (e.g. `<a href="https://user:tok@host/...">`) slip past the regex patterns below if the input still has tags. Convert to plain text first, then redact:

```bash
TEXT=$(printf '%s' "$BODY_EXCERPT" | python3 -c '
import html, re, sys
b = sys.stdin.read()
b = re.sub(r"<br\s*/?>", "\n", b)
b = re.sub(r"</?(p|div|tr|td|th|li|pre)[^>]*>", "\n", b)
b = re.sub(r"<[^>]+>", "", b)
print(html.unescape(b))
')
# Now apply the regex table below to $TEXT.
```

Transcripts and synth-repro scripts are already plain text and skip the pre-pass.

**Order matters and the patterns below are in execution order.** Longest, most-specific patterns first; generic catchalls last. Otherwise the catchall masks specific matches and you lose track of what was actually redacted (JWT vs session blob vs random base64).

Patterns live in a fenced block (not a Markdown table) because patterns 8 and 9 use regex alternation `|` — Markdown tables would treat the literal `|` as a column delimiter, and escaping it as `\|` makes the regex match a literal pipe instead of an alternation, which silently breaks credential redaction.

```regex
1.  eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
    → JWT tokens

2.  gh[pousr]_[A-Za-z0-9]{36,}
    → GitHub PATs / install tokens

3.  (?i)nvapi-[A-Za-z0-9_-]{20,}
    → NVIDIA API keys (NIM / build.nvidia.com)

4.  AKIA[0-9A-Z]{16}
    → AWS access key IDs

5.  (?i)aws_secret_access_key\s*=\s*\S+
    → AWS secret keys

6.  (?i)authorization:\s*\S+
    → HTTP auth headers (often Bearer + JWT)

7.  URLs containing `@` before the host (e.g., https://user:pw@host/...)
    → Basic-auth credentials in URLs

8.  (?i)(token|secret|password|api[_-]?key|bearer)[^\n]*[:=][^\n]*
    → Inline credentials in env/config/log output

9.  \b\w+\.(nvidia\.internal|nv-internal\.com|nvidia\.dev)\b
    → Internal hostnames (extend list per team)

10. [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
    → Email addresses (PII)

11. \b[A-Za-z0-9+/]{60,}={0,2}\b
    → Long base64 blobs (likely keys/sessions; tune length to taste — too short hits legit data)
```

**File paths under the reporter's home directory** (`/Users/<name>/`, `/home/<name>/`) → replace with `~/`. Run last; catches incidental username PII.

**Comment authoring principle.** Every section in a rendered comment must either change a reader's mind about the verdict, or be cut. Word counts follow from that — **300 is a hard ceiling** for the main verdicts (`fixed-on-latest`, `by-design`). Simple cases (clear PR ref, deterministic check) land under 200. The principle generalizes: comments posted by this skill compete for a maintainer's attention against every other in-flight thread, and "AI-slop" prose — architectural sidebars, file:line citations the maintainer can find via the PR ref, bare-output reproductions when the load-bearing evidence is elsewhere, "if this verification is wrong, please reopen…" boilerplate — actively reduces the comment's signal-to-noise ratio.

**For each section in a draft, ask: would the maintainer reach a different conclusion *without* this section? If no, delete.** Lessons accumulated from real runs:

- **#2007 first draft (~750 words):** had a multi-paragraph "Architectural notes for QA reference" section that didn't change the verdict. Cut → 371 words.
- **#2604 first three drafts:** wavered between fixed-on-latest, still-reproduces, and by-design across iterations because each draft padded the verdict with prose that didn't ground it. Final 190-word draft cut a maintainer-note sidebar about platform attribution, a bare-status output reproduction, and a file:line citation of the source — none affected the verdict, all were AI-slop padding. Rule learned: **before drafting any prose, name the verdict in one sentence; if a section doesn't directly support that one sentence, cut it before writing it.**

**Per-verdict length defaults:**

| Verdict | Target | Rationale |
|---|---|---|
| `fixed-on-latest` | **200–300 words** | Header + evidence + verdict + @-mention. Add hardware-substitution caveat or related-failure-mode section only if they shift the maintainer's read. If you're past 300, you're padding. |
| `by-design` | **200–300 words** | Structurally-fixed + vestigial + what's-not-the-same-bug, each one to two sentences max. The PR ref carries the detail; the comment carries the verdict. |
| `verify-inconclusive` | 100–200 words | One paragraph naming what the skill couldn't establish. No transcripts beyond a single quoted line. |
| **Still-reproduces** | **30–80 words** | The reporter already has the symptom; the maintainer can see the issue is open. The skill is just confirming + setting the TTL marker. **No transcripts** (the issue body has them), **no closing reporter @-mention** (the reporter knows their bug is real), **no architectural prose**. One sentence stating "skill ran reproducer on `<latest>`, symptom still present" + one sentence on any partial-fix PR if relevant + marker. That's it. The unanswered-question lead paragraph (rule below) is the one allowed exception when `UNANSWERED_MAINT_LOGIN` is set — it adds one maintainer @-mention as a lead, never a closing pair. |

**Cut, by default:**

- Maintainer-note sidebars about labels / platform attribution unrelated to the bug surface.
- Bare-output reproductions when the load-bearing evidence is in a different command's output.
- File:line citations of source code already findable via the cited PR.
- Closing "if this verification is wrong, please reopen…" boilerplate.
- Redundant verbal framing of what the evidence already shows ("the table above proves…").
- "Verification mode" pleasantries beyond one factual line.

**Mandatory cap caveat.** When the score is capped (Step 9 baseline-validation gating, or any Step 11 degraded-mode path), the rendered Verdict section must include a one-line caveat naming the cap and the reason. Example: `Capped at 84 because Step 9's baseline-validation gate did not run (sandbox-build rot on v0.0.18: Dockerfile symlink layer removed by #2227).` Don't make readers reverse-engineer why the score didn't go higher — name it.

**Mandatory hardware-substitution caveat.** When the issue carries `platform: dgx-spark` or `platform: gb10` and Step 7 provisioned a Brev SKU that is not the same silicon, the rendered comment must include a one-line "Hardware substitution" note. Name both the actual Brev SKU and the reported hardware, and state that performance, memory-architecture, and driver results require confirmation on the real target.

**Mandatory `Verification mode` header line.** All three templates below include a `**Verification mode:**` line in the metadata block, naming what we did and didn't actually run (e.g., "runtime reproduction on Brev <SKU>; baseline + latest both installed and run" for the standard template; "static analysis at the verified-on tag — no runtime reproduction" for the by-design template; "runtime reproduction on Brev <SKU>; bug confirmed live on latest" for still-reproduces). Reader should never have to guess whether the verdict came from real install logs or from static analysis.

**Link-pass self-verification (all templates).** Same rule as Step 8.5d's link pass, applied to every template. Resolve at least one rendered Markdown link from each section that has them (`What's structurally fixed` / `Vestigial references` / `Existing CI coverage` for by-design; `Relevant changes since` / transcript code-anchor citations for the standard template) via `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=<tag>` (returns 200 + base64 if path exists at tag, 404 otherwise) or `curl -fsI <blob-url>`. A 404 on a citation in the rendered comment is worse than no citation — it advertises verification work that didn't actually happen. If any link fails to resolve, fix it or bail to `verify-inconclusive`.

**Mandatory closing block — reporter @-mention with confirmation language.** Every template below **except `Still-reproduces`** ends with an explicit @-mention of the original reporter using this exact shape:

> @\<reporter\> — please confirm the symptom is gone on a recent build (≥ v0.0.\<Z\>) and reopen with a fresh reproducer if you observe otherwise.

The skill cannot independently confirm a closed-as-fixed verdict — only the reporter knows whether their original symptom is gone in their environment. The @-mention is what converts a "skill says it's fixed" claim into actionable confirmation work for QA. Customize `<Z>` per case (the version that shipped the fix or `$LATEST`), but never omit the line.

**Mandatory unanswered-question prefix and dual @-mention.** When Step 3 sets `UNANSWERED_MAINT_LOGIN` (a maintainer's question is older than 7 days and the reporter never replied), the verdict comment changes shape:

1. **Prepend a lead paragraph** as the very first line of the body, before the `## Stale-issue verification` heading. The lead paragraph is a single line:

   ```text
   [@UNANSWERED_MAINT_LOGIN's comment](UNANSWERED_MAINT_URL) from UNANSWERED_MAINT_DATE is still unanswered. Posting independent verification below to unstick the thread.
   ```

   …with the bracketed variables expanded from the values exported by Step 3. **Applies to all three templates** (fixed, still-reproduces, by-design).

2. **Replace the closing reporter-only @-mention with a dual @-mention** that names BOTH the maintainer (acknowledging the open question) and the reporter (per the standard confirmation pattern):

   > @\<UNANSWERED_MAINT_LOGIN\> — flagging that your question above is still open; the verification below may answer it. @\<reporter\> — please confirm the symptom is gone on a recent build (≥ v0.0.\<Z\>) and reopen with a fresh reproducer if you observe otherwise.

   **Applies to `fixed-on-latest` and `by-design` only.** Still-reproduces has no closing reporter @-mention by design (see L174), so there's nothing to replace; its only nod to the unanswered maintainer is the lead paragraph from step 1.

The skill becomes the *unsticking voice* on a thread that has gone quiet — never a clueless interruption when discussion is fresh (Step 3 already filtered the within-7-day case).

**Comment template (fixed / inconclusive — bug not reproduced on latest):**

````markdown
## Stale-issue verification — automated

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Verification mode:** runtime reproduction on Brev `<instance-class>` — baseline (v0.0.31) and latest (v0.0.34) both installed and run; comparison made on the captured transcripts. (Or: "runtime reproduction on Brev `<instance-class>` — baseline-install-skipped (`.openclaw-data` rot, see Step 11), latest-only run; verdict capped at 84.")
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04 / <CUDA version if GPU>

### Baseline (reported version)

- Install: succeeded · skipped (install rotted)
- Reproducer: extracted verbatim · synthesized (−30 penalty)
- Result: bug symptom matched (validated) · could not validate (skipped Step 8c gate)

<details><summary>Baseline transcript</summary>

```text
<full baseline transcript>
```

</details>

### Latest

- Install: succeeded
- Result: not reproducible — clean run, no bug symptom observed

<details><summary>Latest transcript</summary>

```text
<full latest transcript>
```

</details>

### Verdict

**Confidence:** 88 / 100. Verdict: `fixed-on-latest`; proposing Project Status `Needs Review`.

<details><summary>Relevant changes since v0.0.31</summary>

- abc1234 — fix: <commit subject>
- def5678 — refactor: <commit subject>

</details>

@<reporter> — please confirm the symptom is gone on a recent build (≥ v0.0.<Z>) and reopen with a fresh reproducer if you observe otherwise.

<!-- nemoclaw-verify-stale v1 verdict=fixed-on-latest YYYY-MM-DD -->
````

For a score below 60, use the same evidence structure only as far as needed for the shorter inconclusive comment, state `Verdict: verify-inconclusive; no Project field change proposed`, and end with:

```text
<!-- nemoclaw-verify-stale v1 verdict=verify-inconclusive YYYY-MM-DD -->
```

**Comment template (still reproduces — Step 9 special case).** Keep this minimal — per L174 it caps at 30–80 words, drops transcripts (issue body has them), and omits the closing reporter @-mention (the reporter knows their own bug is real). Only the unanswered-question lead paragraph (when fired) adds an @-mention; no closing dual @-mention even then.

````markdown
## Stale-issue verification — still reproducible

**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Verification mode:** runtime reproduction on Brev `<instance-class>` — bug confirmed live on latest.

Skill ran the reported reproducer on v0.0.34 and observed the same symptom. No Project field or label change proposed; will re-verify on the next weekly pass.

<!-- nemoclaw-verify-stale v1 verdict=still-reproduces YYYY-MM-DD -->
````

If a partial-fix PR is in flight that targets the same surface, add one sentence naming it between the verification line and the marker: `Partial fix tracked in #NNNN (not yet released).` Keep the total under 80 words.

The trailing HTML comment is the **idempotency marker** Step 3 looks for. Always include today's date in `YYYY-MM-DD` format. Final verdict markers are durable; only `still-reproduces` uses the seven-day TTL.

**Authorization boundary.** Before any write, present a dry run containing:

- the verdict and confidence;
- the exact redacted public comment, including its durable marker;
- the proposed Project Status change (`Needs Review` only for `fixed-on-latest`; none for inconclusive or still-reproduces);
- the proposed self-assignment, if any;
- `human_review_required: true`.

Wait for explicit approval of that exact write set. Comment approval does not authorize a Project change, and Project approval does not authorize modified comment text.

**Pre-post state-check.** A long-running verification can race with a maintainer closing the issue independently. Re-check `state == OPEN` immediately before applying an accepted write set. If closed, skip every write and report that the maintainer's close action is now authoritative.

```bash
STATE=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json state --jq .state)
if [ "$STATE" != "OPEN" ]; then
  echo "[verify-stale] #$ISSUE_NUMBER closed since verification started — skipping Project, assignment, and comment writes"
  exit 0
fi
```

**Apply the accepted write set in canonical order.** Resolve Project 199, Status-field, option, and item IDs from live GitHub data immediately before writing; do not use hardcoded IDs. For an accepted `fixed-on-latest` plan, set Project Status `Needs Review`, then self-assign only if that assignment was accepted. Treat the Project update and accepted assignment as one fail-fast write set: if either write fails, stop before posting the comment. For inconclusive and still-reproduces verdicts, do not change Project fields or assignment. Post the exact accepted comment last.

If Project resolution, update, or accepted assignment fails, stop without posting the comment so the accepted write set is not partially represented. Record the Project update, assignment, and comment outcome in the activity log.

---

## Step 11: Infra Failure Handling

Two different failure types, two different responses.

**Latest-install failure** (Step 8d) or reuse-check / provisioning / harness errors: hard infra failure.

- Print the error.
- Apply no Project field or label change — infra failures must not pollute the verification record.
- Post a short comment **only if explicitly requested by the invoking user**. Default is silent move-on.
- Continue to the next candidate in batch mode.

The next weekly run retries naturally.

**Baseline-install failure** (Step 8a, reported version won't install on a modern image): not a hard failure — degraded mode.

- Set `BASELINE_INSTALL_FAILED=1`, skip 8b/8c, jump to 8d.
- Step 9 applies the score cap (max 84) — corroboration signals raise the score within the cap but cannot lift past it.
- Note "baseline-install-skipped" in the final comment so a reviewer knows the verification ran without the script-validation gate.

**Baseline-build failure** (Step 8a binary install succeeded, but the in-image `Dockerfile` build during sandbox creation failed on a layer that was structurally removed in a later release): also degraded mode, distinct from binary install rot. Surfaced during the #2007 e2e run on v0.0.18 (`/sandbox/.openclaw-data/workspace/media` symlink layer, removed entirely by #2227).

- Set `BASELINE_INSTALL_FAILED=1` (same flag — Step 9's cap-at-84 rule keys off it regardless of which phase rotted).
- Skip 8b/8c, jump to 8d.
- Note "baseline-build-skipped" in the final comment with the specific failing layer/file so a reviewer can see *why* the v0.0.X image no longer builds (the why is usually a follow-on PR that removed the rotted layer).
- Do not retry the build with a patched Dockerfile — that breaks faithfulness. We're claiming "couldn't independently re-trigger the original symptom on baseline," not "we made the old version work somehow."

Both baseline-rot variants share the same downstream effect: Step 9 cap, Step 10 caveat, @-mention reporter to confirm. Distinguishing them in the comment helps a reviewer understand the failure mode without re-running.

This degradation is expected — old releases rot at multiple phases (binary installer URL drift, base-image dependencies vanish, in-image Dockerfile layers get removed by structural refactors). We still want to extract whatever signal we can from the latest run plus PR/commit evidence, just at a more conservative confidence ceiling.

**Empirical reality after two e2e runs:** baseline-build-rot is the **dominant** failure mode for any reported version more than ~5–7 patches behind, not an edge case. Both #2007 (v0.0.18, 17 patches behind) and #2592 (v0.0.28, 7 patches behind) hit it. The cap-at-84 with reporter @-mention is the **modal** verdict shape for stale-issue verification, not the exception. Reframe expectations accordingly:

- For issues reported >5 patches behind `$LATEST`, plan for the cap-at-84 path. Pre-flight (PR-search, pickaxe) carries more weight than baseline runtime evidence.
- For issues reported within 1–4 patches of `$LATEST`, baseline is more likely to install cleanly and the full +50 path is reachable.
- The skill's design assumes baseline + latest both run cleanly; in practice latest-only with cap-at-84 is the workhorse path. The score-cap is doing real work, not just a fallback.

**Keep-box-on-inconclusive.** When `verify-inconclusive` lands (Step 8c gave up, or Step 9 score < 60), **skip the cleanup trap** for this run if the box was provisioned by this run — set `PROVISIONED_NEW=0` before the trap fires so the EXIT handler is a no-op. Print the `brev shell "$INSTANCE_NAME"` command and an explicit `brev delete "$INSTANCE_NAME"` reminder in the run output so the maintainer can triage and clean up manually. Reused boxes stay regardless. Ship-failed verifications are the exact case where having an inspectable artifact pays for itself; an unbounded sleep-and-delete in the background isn't reliable across session ends, so we leave deletion explicit.

---

## Step 12: Log to Activity

After each issue (verified, inconclusive, by-design, or infra-failed), append to `${VERIFY_STALE_LOG_DIR:-$HOME/development/daily-rhythm/activity}/nemoclaw-verify-stale-log.md`. The default path matches the personal-organizer convention; export `VERIFY_STALE_LOG_DIR` to point elsewhere (CI, shared volume, etc.). Create the directory if missing — do not assume it exists.

```markdown
### NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Environment:** CPU | GPU (<instance type>)
**Box:** reused <name> | provisioned <name> | local (no Brev — Step 6.7 short-circuit)
**Baseline install:** succeeded | failed (degraded mode)
**Baseline match:** validated (verbatim) | validated (synth) | failed (verify-inconclusive) | skipped
**Latest install:** succeeded | failed (infra error)
**Latest result:** not-reproduced (clean) | still-reproduces | partial / flake | n/a (skipped 8d)
**Confidence:** 88 / 100 | n/a (still-reproduces)
**Verdict marker:** fixed-on-latest | verify-inconclusive | by-design | still-reproduces | none (infra)
**Project Status:** moved to Needs Review | moved to Won't Fix | unchanged | update failed
**Assignee:** @<GH_IDENTITY> | not assigned (verdict: <X>)
**Brev wall time (approx):** N min

---
```

Create the file if missing, with this header:

```markdown
# NemoClaw — Verify Stale Log

A running record of stale-issue verification runs on NVIDIA/NemoClaw.
Persisted via daily-rhythm to GitLab.

---
```

At end of a batch session, prepend a session summary:

```markdown
## YYYY-MM-DD — Verify Session
**Issues considered:** N
**Verified `fixed-on-latest`:** N
**Approved `Won't Fix` Project updates (by-design path):** N
**Recorded `verify-inconclusive` verdicts:** N
**Local-first short-circuits (no Brev cost):** N
**Skipped (Windows / macOS / integration / no version):** N
**Infra failures:** N
**Brev wall time:** N min · approx $X.XX

---
```

Never stage or commit the log to the NemoClaw repo.

---

## Cadence

- **Weekly cron** — Monday morning, batch mode, ≤15 issues (the Step 1 cap, sliced after Step 3/4 filters).
- **Manual** — invoke with a single issue number anytime.

---

## Out of Scope (v1)

- Auto-closing issues. The skill may make only the explicitly approved Project, assignment, and comment writes described above; a human separately decides whether to close.
- macOS verification *via the Brev path*. Brev offers no macOS instances. The Step 6.7 local-first short-circuit *does* run on a maintainer's macOS laptop — so manual single-issue runs against pure-CLI bugs work on macOS. The weekly batch cron is Linux-only because that path always uses Brev.
- Issues requiring third-party integration credentials (Slack, Discord, Telegram, Hermes, OpenClaw, WeChat).
- Service-account bot identity. v1 runs under each maintainer's own GitHub credentials.
- Verdict labels. `fixed-on-latest`, `verify-inconclusive`, and `status: wont-fix` are not canonical labels; durable comment markers and Project fields carry the workflow state.

---

## Companion Behavior

`nemoclaw-maintainer-cut-release-tag` does not alter verify-stale verdict markers or Project Status. Those remain durable until a maintainer explicitly re-runs verification or changes the Project field.
