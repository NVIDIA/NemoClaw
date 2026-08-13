<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Scoring, Comments, Project Fields, and Logging Reference

Use after a newest-release result exists or after a by-design or inconclusive branch is selected. Covers confidence scoring, redaction, concise comments, authorized Project updates, infrastructure failures, and activity logging.

## Contents

- [Step 9: Score Confidence](#step-9-score-confidence)
- [Step 10: Compose and Post the Comment](#step-10-compose-and-post-the-comment)
- [Step 11: Infrastructure Failure Handling](#step-11-infrastructure-failure-handling)
- [Step 12: Log to Activity](#step-12-log-to-activity)
- [Cadence](#cadence)
- [Out of Scope (v1)](#out-of-scope-v1)
- [Companion Behavior](#companion-behavior)

---

## Step 9: Score Confidence

Start at 0. Apply each rule that fires.

| Signal | Delta |
|---|---|
| The same reviewed reproducer matched the reported symptom on `$REPORTED_VERSION`, then produced the expected exit and no reported symptom on the newest release tag | +50 |
| After that reported-release symptom match, the reported-release retry had mixed results and the newest-release run did not show the symptom | +25 instead of the +50 newest-release signal |
| A reviewed diff between the tags changes the implicated behavior in a way that addresses the symptom | +25 |
| A merged PR explicitly states that it fixes this issue or the reproduced symptom | +25 |
| Reproducer received the −30 confidence penalty after an LLM introduced a command or state change that affects the reproduced behavior | −30 |
| Any partial error, warning, or intermittent behavior in the newest-release run | −50 |

Total is clamped to `[0, 100]`.

### Path extraction (for the +25 behavior-change signal)

The skill needs to know which path to use with `git log "$REPORTED_VERSION".."$LATEST" -- <path>`. Apply in order and stop at the first non-empty path:

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

If none of the above produces a path, skip the signal rather than guessing. A commit that merely touches the directory does not earn points. Inspect the diff and state how the changed behavior addresses the reproduced symptom.

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

Apply +25 only when the PR text or linked issue-closing metadata says it fixes this issue or the reproduced symptom. Require `mergedAt` to be after the issue's `createdAt`, and require the PR commit to be reachable from `$LATEST`. `REPORTED_VERSION` already includes the leading `v`; do not construct `v$REPORTED_VERSION`.

If neither query returns anything, **skip the +25 signal**.

**Baseline-validation gate.** `fixed-on-latest` requires the same reviewed reproducer to expose the reported symptom on `$REPORTED_VERSION`. If the baseline install or build fails, or the baseline result does not match, select `verify-inconclusive`. Commit or PR evidence can explain the result but cannot replace the runtime baseline gate. The static by-design branch remains separate because it requires explicit intent evidence.

**Action when the newest-release run has the expected result and does not show the bug:**

| Score | Verdict | Proposed Project action | Comment |
|---|---|---|---|
| ≥85 | `fixed-on-latest` | `Needs Review` | Evidence-rich; ask the reporter to confirm. |
| 60–84 | `fixed-on-latest` | `Needs Review` | Evidence-rich; ask the reporter to confirm. |
| <60 | `verify-inconclusive` | No field change | Short, honest "couldn't verify" explanation. |

Verdict names are comment and log vocabulary, not GitHub labels. Prepare the comment, Project update, assignment, and durable verdict marker as a dry run with `human_review_required: true`; apply only the accepted write set.

**Special case: the newest-release output matches the reported symptom.**

This result confirms that the bug still reproduces on the newest release tag. Do not apply the +50 weight. Skip the score table.

- Post a 30–80 word comment that states the bug still reproduces on the newest release tag. Do not include transcripts. Keep the reported-release and newest-release transcripts as temporary local evidence; the optional activity log stores only the structured summary from Step 12.
- Make no Project field or label change.
- Include the marker `<!-- nemoclaw-verify-stale v1 verdict=still-reproduces YYYY-MM-DD -->` with today's date so the candidate filter applies the 7-day TTL (Step 3 idempotency).
- A later scheduled or manual run can pick the issue back up after the TTL and catch a newly landed fix.

The skill **never closes issues** in any branch. Project fields, assignments, and public comments require explicit approval of the proposed write set.

---

## Step 10: Compose and Post the Comment

**Redaction pass before inspection or posting.** Run the bundled helper on every evidence excerpt, including issue body excerpts, reported-release and newest-release transcripts, log captures, and synthesized scripts. Inspect and quote only the redacted output. Keep raw evidence in the owner-only `$EVIDENCE_DIR` and let the cleanup trap remove it.

```bash
REDACTOR=.agents/skills/nemoclaw-maintainer-verify-stale/scripts/redact-evidence.py
printf '%s' "$BODY_EXCERPT" | python3 "$REDACTOR" --html \
  >"$EVIDENCE_DIR/body-excerpt.redacted.txt"
python3 "$REDACTOR" "$EVIDENCE_DIR/latest-transcript.log" \
  >"$EVIDENCE_DIR/latest-transcript.redacted.log"
```

The `--html` option converts NV QA's HTML-form bodies to text before redaction, preventing tokens in tags or attributes from bypassing the text patterns. Plain-text transcripts and scripts omit that option.

**Order matters and the patterns below are in execution order.** Longest, most-specific patterns first; generic catchalls last. Otherwise the catchall masks specific matches and you lose track of what was actually redacted (JWT vs session blob vs random base64).

The helper implements the patterns below in this order. Update the helper and its policy test together when the list changes. Patterns live in a fenced block because Markdown tables treat regex alternation `|` as a column delimiter. Escaping it as `\|` would change the regex to a literal pipe.

```regex
1.  eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}
    → JWT tokens

2.  (?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})
    → GitHub PATs / install tokens

3.  (?i)nvapi-[A-Za-z0-9_-]{20,}
    → NVIDIA API keys (NIM / build.nvidia.com)

4.  (?i)\bsk-(?:ant-|proj-|or-v1-)?[A-Za-z0-9_-]{20,}\b
    → OpenAI, Anthropic, and OpenRouter API keys

5.  \bAIza[A-Za-z0-9_-]{20,}\b
    → Google Gemini API keys

6.  AKIA[0-9A-Z]{16}
    → AWS access key IDs

7.  (?i)aws_secret_access_key\s*=\s*\S+
    → AWS secret keys

8.  (?i)^(\s*(?:[><*]\s*)?)(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*(?::|=))[^\n]*
    and a structured-field variant whose quoted value accepts escaped characters
    → HTTP authentication and session headers in line, assignment, JSON, and curl verbose forms

9.  (?i)(\bBearer\s+)\S+
    → Standalone bearer credentials

10. URLs containing `@` before the host, such as `https://user:pw@host/`
    → Basic-auth credentials in URLs

11. (?i)(token|secret|password|api[_-]?key|bearer)[^\n]*[:=][^\n]*
    → Inline credentials in environment, configuration, and log output

12. \b\w+\.(nvidia\.internal|nv-internal\.com|nvidia\.dev)\b
    → Internal hostnames

13. [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}
    → Email addresses

14. \b[A-Za-z0-9+/]{60,}={0,2}\b
    → Long base64 blobs that can contain credentials or session data
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

**Mandatory hardware-substitution caveat.** When the issue carries `platform: dgx-spark` or `platform: gb10` and Step 7 created a Brev instance with different silicon, the rendered comment must include a one-line `Hardware substitution` note. Name the Brev SKU and reported hardware. State that performance, memory-architecture, and driver results require confirmation on the reported hardware.

**Mandatory `Verification mode` header line.** Each template must name what ran. Use `runtime reproduction on Brev <SKU>; reported release and newest release tag both installed and run` for the standard template, `static analysis at the verified release tag; no runtime reproduction` for the by-design template, and `runtime reproduction on Brev <SKU>; reported symptom observed on the newest release tag` for still-reproduces. The reader must not have to infer whether the verdict came from runtime evidence or static analysis.

**Link-pass self-verification (all templates).** Same rule as Step 8.5d's link pass, applied to every template. Resolve at least one rendered Markdown link from each section that has links via `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=<tag>` or `curl -fsI <blob-url>`. If any link fails, fix it or select `verify-inconclusive`.

**Mandatory closing block — reporter @-mention with confirmation language.** Every template below **except `Still-reproduces`** ends with this @-mention of the original reporter:

> @<reporter> — please test v0.0.<Z> or newer and reply with a reproducer if the symptom remains.

Only the reporter can confirm whether the original symptom is gone in their environment. The @-mention converts a verification result into actionable confirmation work for QA. Customize `<Z>` per case (the version that shipped the fix or `$LATEST`), but never omit the line.

**Mandatory unanswered-question prefix and dual @-mention.** When Step 3 sets `UNANSWERED_MAINT_LOGIN` (a maintainer's question is older than 7 days and the reporter never replied), the verdict comment changes shape:

1. **Prepend a lead paragraph** as the very first line of the body, before the `## Stale-issue verification` heading. The lead paragraph is a single line:

   ```text
   [@UNANSWERED_MAINT_LOGIN's comment](UNANSWERED_MAINT_URL) from UNANSWERED_MAINT_DATE is still unanswered. Posting independent verification below to unstick the thread.
   ```

   …with the bracketed variables expanded from the values exported by Step 3. **Applies to all three templates** (fixed, still-reproduces, by-design).

2. **Replace the closing reporter-only @-mention with a dual @-mention** that names BOTH the maintainer (acknowledging the open question) and the reporter (per the standard confirmation pattern):

   > @<UNANSWERED_MAINT_LOGIN> — your question above is still open; the verification below may answer it. @<reporter> — please test v0.0.<Z> or newer and reply with a reproducer if the symptom remains.

   **Applies to `fixed-on-latest` and `by-design` only.** Still-reproduces has no closing reporter mention, as defined in **Per-verdict length defaults**. Its only reference to the unanswered maintainer is the lead paragraph from step 1.

The skill becomes the *unsticking voice* on a thread that has gone quiet — never a clueless interruption when discussion is fresh (Step 3 already filtered the within-7-day case).

**Comment template (fixed — bug not reproduced on the newest release tag):**

````markdown
## Stale-issue verification — automated

**Reported on:** v0.0.31
**Verified on:** v0.0.34 (commit abc1234)
**Verification mode:** runtime reproduction on Brev `<instance-class>` — the same reviewed reproducer exposed the symptom on v0.0.31 and ran on v0.0.34.
**Environment:** Brev <instance-class> (<instance-type>) / Ubuntu 22.04 / <CUDA version if GPU>

### Baseline (reported version)

- Install: requested release tag resolved
- Reproducer: reconstructed from reported steps · synthesized and reviewed (−30 confidence penalty)
- Result: matched `<one redacted symptom line or state comparison>` (exit `<code>`)

### Newest Release

- Install: succeeded
- Result: expected behavior observed; `<one redacted diagnostic line or state comparison>` (exit `<code>`)

### Verdict

**Confidence:** 88 / 100. Verdict: `fixed-on-latest`; proposing Project Status `Needs Review`.

<details><summary>Relevant changes since v0.0.31</summary>

- abc1234 — fix: <reviewed change that directly addresses the reported symptom>
- def5678 — fix: <second reviewed change that directly addresses the reported symptom>

</details>

@<reporter> — please test v0.0.<Z> or newer and reply with a reproducer if the symptom remains.

<!-- nemoclaw-verify-stale v1 verdict=fixed-on-latest YYYY-MM-DD -->
````

**Comment template (inconclusive — reported-release verification stopped):**

````markdown
## Stale-issue verification — inconclusive

**Reported on:** v0.0.31
**Verified on:** n/a; newest release tag not run
**Verification mode:** reported-release verification stopped before the baseline gate completed.

### Reported Release

- Install: requested release tag resolved; install or build failed · succeeded
- Reproducer: n/a · reconstructed or synthesized and reviewed
- Result: `<one redacted failure line or no-match explanation>`

### Newest Release

- Install: n/a; not run because the reported-release gate did not complete
- Result: n/a

### Verdict

**Verdict:** `verify-inconclusive`; no Project field change proposed.

@<reporter> — please reply with the missing environment detail or a revised reproducer named above.

<!-- nemoclaw-verify-stale v1 verdict=verify-inconclusive YYYY-MM-DD -->
````

**Comment template (still reproduces — Step 9 special case).** Keep this template to 30–80 words, as defined in **Per-verdict length defaults**. Do not include transcripts or a closing reporter mention. Only the unanswered-question lead paragraph adds a mention.

````markdown
## Stale-issue verification — still reproducible

**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Verification mode:** runtime reproduction on Brev `<instance-class>` — reported symptom observed on the newest release tag.

The skill ran the reviewed reproducer on v0.0.34 and observed the same symptom. No Project field or label change proposed; eligible for re-verification after the seven-day marker TTL.

<!-- nemoclaw-verify-stale v1 verdict=still-reproduces YYYY-MM-DD -->
````

If Step 8c introduced a command or state change that affects the reproduced behavior, replace `reviewed reproducer` with `synthesized and reviewed reproducer`.

If a partial-fix PR is in flight that targets the same surface, add one sentence naming it between the verification line and the marker: `Partial fix tracked in #NNNN (not yet released).` Keep the total under 80 words.

The trailing HTML comment is the **idempotency marker** Step 3 looks for. Always include today's date in `YYYY-MM-DD` format. Final verdict markers are durable; only `still-reproduces` uses the seven-day TTL.

**Authorization boundary.** Before any write, present a dry run containing:

- the verdict and confidence;
- the redacted public comment, including its durable marker;
- the proposed Project Status change (`Needs Review` only for `fixed-on-latest`; none for inconclusive or still-reproduces);
- the proposed self-assignment, if any;
- `human_review_required: true`.

Wait for explicit approval of that write set. Comment approval does not authorize a Project change, and Project approval does not authorize modified comment text.

**Pre-post state-check.** A long-running verification can race with a maintainer closing the issue independently. Re-check `state == OPEN` immediately before applying an accepted write set. If closed, skip every write and report that the maintainer's close action is now authoritative.

```bash
CURRENT_ISSUE=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json state,updatedAt)
STATE=$(printf '%s' "$CURRENT_ISSUE" | jq -r .state)
if [ "$STATE" != "OPEN" ]; then
  echo "[verify-stale] #$ISSUE_NUMBER closed since verification started — skipping Project, assignment, and comment writes"
  exit 0
fi

CURRENT_UPDATED_AT=$(printf '%s' "$CURRENT_ISSUE" | jq -r .updatedAt)
if [ "$CURRENT_UPDATED_AT" != "$ISSUE_UPDATED_AT" ]; then
  echo "[verify-stale] #$ISSUE_NUMBER changed during verification — refresh comments and Project fields, then present a revised write set for approval"
  exit 0
fi
```

**Apply the accepted write set in canonical order.** Resolve and validate Project 199, Status-field, option, item, and assignee IDs from live GitHub data immediately before writing; do not use hardcoded IDs. For an accepted `fixed-on-latest` plan, set Project Status `Needs Review`, then self-assign only if that assignment was accepted. For inconclusive and still-reproduces verdicts, do not change Project fields or assignment. Post the accepted comment last.

GitHub does not make these calls transactional. If a Project update succeeds and a later assignment or comment fails, report the exact partial state and stop; do not silently retry with changed text or roll back an accepted field change without new approval. Record each Project, assignment, and comment outcome in the activity log or structured task output.

---

## Step 11: Infrastructure Failure Handling

Handle each failure category according to the rules below.

**Install failure on the newest release tag**, reuse-check failure, instance-creation failure, failure to invoke a harness, or failure to retrieve harness evidence: hard infrastructure failure.

After performance evidence retrieval succeeds, fewer than 10 successful exits or numeric samples selects `verify-inconclusive`, as defined in Step 8e.

- Print the error.
- Apply no Project field or label change. Infrastructure failures must not change the verification record.
- Post a short comment **only if explicitly requested by the invoking user**. Default is silent move-on.
- Continue to the next candidate in batch mode.

A later scheduled or manual run retries naturally.

**Resolved release tag mismatch:** hard infrastructure failure.

- Set `RESOLVED_TAG_MISMATCH=1`.
- Do not assign a verdict or score.
- Do not propose or post a GitHub comment.
- Report the requested and resolved release tags in local task output.

**Baseline-install failure** after confirming `$REPORTED_VERSION` (the reported release does not install on the selected image): inconclusive verification.

- Set `BASELINE_INSTALL_FAILED=1` and select `verify-inconclusive`.
- Do not verify the newest release tag solely to produce a fixed verdict. The baseline gate cannot establish that the reviewed script exposed the bug.
- Keep PR and commit findings as local context. Include only a concise, redacted explanation if the maintainer approves an inconclusive comment.

**Baseline-build failure** (Step 8a binary install succeeded, but the in-image `Dockerfile` build failed): inconclusive verification, distinct from binary install failure.

- Set `BASELINE_INSTALL_FAILED=1` and select `verify-inconclusive`.
- Note the specific failing layer or file in local evidence. Include one redacted diagnostic line in an approved comment.
- Do not patch the old Dockerfile. That would change the reported-release environment.

Old releases can fail because installer assets, base-image dependencies, or build layers have changed. That is evidence about reproducibility, not evidence that the reported bug is fixed.

**Instance cleanup on inconclusive results.** Keep the approved cleanup trap active. Do not change `PROVISIONED_NEW` to bypass deletion. Retain an instance created by the run only after separate maintainer approval that names the cost, cleanup owner, and deletion deadline; set `KEEP_INSTANCE=1` only for that accepted plan.

---

## Step 12: Log to Activity

After each issue, append to `$VERIFY_STALE_LOG_DIR/nemoclaw-verify-stale-log.md` only when the maintainer or invoking automation configured `VERIFY_STALE_LOG_DIR`. Otherwise return the same structured summary in the task output and do not create a persistent file. Never assume a personal organizer, GitLab mirror, home-directory layout, or shared volume.

```markdown
### NVIDIA/NemoClaw#<number> — <title>
**Date:** YYYY-MM-DD
**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Environment:** CPU | GPU (<instance type>)
**Brev instance:** reused <name> | created <name> | local (no Brev instance created)
**Baseline install:** succeeded | failed (verify-inconclusive)
**Baseline match:** validated (reconstructed) | validated (synth) | failed (verify-inconclusive) | skipped
**Newest-release install:** succeeded | failed (infrastructure error)
**Newest-release result:** expected result, no symptom | still-reproduces | partial | intermittent | n/a (Step 8d skipped)
**Confidence:** 88 / 100 | n/a (still-reproduces)
**Verdict marker:** fixed-on-latest | verify-inconclusive | by-design | still-reproduces | none (infrastructure failure)
**Project Status:** moved to Needs Review | moved to Won't Fix | unchanged | update failed
**Assignee:** @<GH_IDENTITY> | not assigned (verdict: <X>)
**Brev wall time (approx):** N min

---
```

Create the file if missing, with this header:

```markdown
# NemoClaw — Verify Stale Log

A running record of stale-issue verification runs on NVIDIA/NemoClaw.

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
**Infrastructure failures:** N
**Brev wall time:** N min · approx $X.XX

---
```

Never stage or commit the log to the NemoClaw repo.

---

## Cadence

- **Scheduled automation** — batch mode, ≤15 issues. The automation owner chooses the cadence and log location.
- **Manual** — invoke with a single issue number anytime.

---

## Out of Scope (v1)

- Auto-closing issues. The skill may make only the explicitly approved Project, assignment, and comment writes described above; a human separately decides whether to close.
- macOS verification *via the Brev path*. Brev offers no macOS instances. The Step 6.7 local-first short-circuit *does* run on a maintainer's macOS laptop, so manual single-issue runs against pure-CLI bugs work on macOS. Any batch candidate that needs Brev is verified on Linux and must follow the platform skip rules.
- Issues requiring third-party messaging credentials (Slack, Discord, Telegram, WeChat).
- Service-account bot identity. v1 runs under each maintainer's own GitHub credentials.
- Verdict labels. `fixed-on-latest`, `verify-inconclusive`, and `status: wont-fix` are not canonical labels; durable comment markers and Project fields carry the workflow state.

---

## Companion Behavior

`nemoclaw-maintainer-cut-release-tag` does not alter verify-stale verdict markers or Project Status. Those remain durable until a maintainer explicitly re-runs verification or changes the Project field.
