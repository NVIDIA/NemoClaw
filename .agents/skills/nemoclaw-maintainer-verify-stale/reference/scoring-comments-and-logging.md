<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Scoring, Comments, Labels, and Logging Reference

Use after a latest result exists or after a by-design/inconclusive branch is selected. Covers confidence scoring, redaction, concise comments, labels, project movement, infra failures, and activity logging.

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
2. **Component-label-to-directory map.** Pick the first match. Paths verified against the current repo layout — drop any path that doesn't exist on the tag at `$LATEST` rather than passing it to `git log`.
   - `NemoClaw CLI` → `bin/`, `src/lib/`, `nemoclaw/src/commands/`
   - `Sandbox` → `nemoclaw/src/blueprint/`, `nemoclaw-blueprint/`
   - `OpenShell` → cross-repo (lives at `github.com/NVIDIA/OpenShell`, not in this repo). Skip the +25 signal for OpenShell-only issues; cross-repo `git log` is out of v1 scope.
   - `Docker` → `Dockerfile`, `Dockerfile.base`, `scripts/install-openshell.sh`, `scripts/install.sh`
   - `Getting Started` → `docs/`, `scripts/install.sh`
   - `Integration: <X>` — no `src/lib/integrations/` exists in this repo. Skip the +25 signal for integration-component issues unless source 1 (file paths in body) yielded a path.
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

| Score | Label | Comment |
|---|---|---|
| ≥85 | `fixed-on-latest` | Evidence-rich, no @-mention. |
| 60–84 | `fixed-on-latest` | Evidence-rich, **@-mention the original reporter** to confirm. |
| <60 | `verify-inconclusive` | Short, honest "couldn't verify" explanation. |

**Special case: latest output matches the issue symptom (bug still reproduces on latest).**

This is not a flake — the skill positively confirmed the bug is still live. Don't apply the +50 weight (the bug isn't fixed) and skip the score table entirely.

- Post a "still reproduces on latest" comment with both transcripts.
- Apply **no label**.
- Include the marker `<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->` with today's date so the candidate filter applies the 7-day TTL (Step 3 idempotency).
- Next weekly run picks the issue back up after the TTL — if the bug gets fixed in the meantime, that run catches it.

The skill **never closes issues** in any branch. A maintainer pulls that trigger after reviewing the label and comment.

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

**Comment authoring principle.** Every section in a rendered comment must either change a reader's mind about the verdict, or be cut. Word counts follow from that — **300 is a hard ceiling** for the main verdicts (fixed-on-latest, wontfix). Simple cases (clear PR ref, deterministic check) land under 200. The principle generalizes: comments posted by this skill compete for a maintainer's attention against every other in-flight thread, and "AI-slop" prose — architectural sidebars, file:line citations the maintainer can find via the PR ref, bare-output reproductions when the load-bearing evidence is elsewhere, "if this verification is wrong, please reopen…" boilerplate — actively reduces the comment's signal-to-noise ratio.

**For each section in a draft, ask: would the maintainer reach a different conclusion *without* this section? If no, delete.** Lessons accumulated from real runs:

- **#2007 first draft (~750 words):** had a multi-paragraph "Architectural notes for QA reference" section that didn't change the verdict. Cut → 371 words.
- **#2604 first three drafts:** wavered between fixed-on-latest, still-reproduces, and by-design across iterations because each draft padded the verdict with prose that didn't ground it. Final 190-word draft cut a maintainer-note sidebar about platform attribution, a bare-status output reproduction, and a file:line citation of the source — none affected the verdict, all were AI-slop padding. Rule learned: **before drafting any prose, name the verdict in one sentence; if a section doesn't directly support that one sentence, cut it before writing it.**

**Per-verdict length defaults:**

| Verdict | Target | Rationale |
|---|---|---|
| `fixed-on-latest` | **200–300 words** | Header + evidence + verdict + @-mention. Add hardware-substitution caveat or related-failure-mode section only if they shift the maintainer's read. If you're past 300, you're padding. |
| `wontfix` (by-design) | **200–300 words** | Structurally-fixed + vestigial + what's-not-the-same-bug, each one to two sentences max. The PR ref carries the detail; the comment carries the verdict. |
| `verify-inconclusive` | 100–200 words | One paragraph naming what the skill couldn't establish. No transcripts beyond a single quoted line. |
| **Still-reproduces (no label)** | **30–80 words** | The reporter already has the symptom; the maintainer can see the issue is open. The skill is just confirming + setting the TTL marker. **No transcripts** (the issue body has them), **no closing reporter @-mention** (the reporter knows their bug is real), **no architectural prose**. One sentence stating "skill ran reproducer on `<latest>`, symptom still present" + one sentence on any partial-fix PR if relevant + marker. That's it. The unanswered-question lead paragraph (rule below) is the one allowed exception when `UNANSWERED_MAINT_LOGIN` is set — it adds one maintainer @-mention as a lead, never a closing pair. |

**Cut, by default:**

- Maintainer-note sidebars about labels / platform attribution unrelated to the bug surface.
- Bare-output reproductions when the load-bearing evidence is in a different command's output.
- File:line citations of source code already findable via the cited PR.
- Closing "if this verification is wrong, please reopen…" boilerplate.
- Redundant verbal framing of what the evidence already shows ("the table above proves…").
- "Verification mode" pleasantries beyond one factual line.

**Mandatory cap caveat.** When the score is capped (Step 9 baseline-validation gating, or any Step 11 degraded-mode path), the rendered Verdict section must include a one-line caveat naming the cap and the reason. Example: `Capped at 84 because Step 9's baseline-validation gate did not run (sandbox-build rot on v0.0.18: Dockerfile symlink layer removed by #2227).` Don't make readers reverse-engineer why the score didn't go higher — name it.

**Mandatory hardware-substitution caveat.** When the issue carries `Platform: DGX Spark` or `Platform: GB10` and Step 7 provisioned a Brev SKU that is not the same silicon (Brev's stoppable GPU catalog is x86 + discrete H100/A100/L40S/T4 — not Grace Hopper / GB10 unified-memory ARM64), the rendered comment must include a one-line "Hardware substitution" note. Example: `Hardware substitution: verified on Brev n1-standard-4:nvidia-tesla-t4 (x86_64 + T4) as a substitute for the reporter's DGX Spark (ARM64 + GB10). For silicon-shape bugs (perf, memory architecture, drivers) this is not a faithful repro — please confirm on actual DGX Spark.` This goes in the metadata block right after `Verification mode:` so it's visible at the top, not buried in the analysis.

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

**Confidence:** 88 / 100. Labelling `fixed-on-latest`.

<details><summary>Relevant changes since v0.0.31</summary>

- abc1234 — fix: <commit subject>
- def5678 — refactor: <commit subject>

</details>

@<reporter> — please confirm the symptom is gone on a recent build (≥ v0.0.<Z>) and reopen with a fresh reproducer if you observe otherwise.

<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->
````

**Comment template (still reproduces — Step 9 special case).** Keep this minimal — per L174 it caps at 30–80 words, drops transcripts (issue body has them), and omits the closing reporter @-mention (the reporter knows their own bug is real). Only the unanswered-question lead paragraph (when fired) adds an @-mention; no closing dual @-mention even then.

````markdown
## Stale-issue verification — still reproducible

**Reported on:** v0.0.31
**Verified on:** v0.0.34
**Verification mode:** runtime reproduction on Brev `<instance-class>` — bug confirmed live on latest.

Skill ran the reported reproducer on v0.0.34 and observed the same symptom. No label applied; will re-verify on the next weekly pass.

<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->
````

If a partial-fix PR is in flight that targets the same surface, add one sentence naming it between the verification line and the marker: `Partial fix tracked in #NNNN (not yet released).` Keep the total under 80 words.

The trailing HTML comment is the **idempotency marker** Step 3 looks for. Always include today's date in `YYYY-MM-DD` format so the candidate filter can apply the 7-day TTL.

**Pre-post state-check.** A long-running verification can race with the maintainer closing the issue independently — happened on #2513 and #2519 (mid-batch closes by @jyaunches with their own verification). Re-check `state == OPEN` right before posting. If closed, apply the label tag-only (skipping the comment, since the maintainer's own close-comment is now the authoritative record) and skip the Project 199 move.

```bash
STATE=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json state --jq .state)
if [ "$STATE" != "OPEN" ]; then
  echo "[verify-stale] #$ISSUE_NUMBER closed since verification started — applying label tag-only, skipping comment + tracker move"
  gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "$LABEL"
  exit 0
fi
```

**Post the comment and apply the label:**

```bash
gh issue comment "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --body-file comment.md
gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "fixed-on-latest"
# or for <60:
# gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-label "verify-inconclusive"
```

**Move the issue to "Needs Review" on the NemoClaw Development Tracker AND self-assign (only on `fixed-on-latest`).** The tracker is GitHub Project [NVIDIA/199](https://github.com/orgs/NVIDIA/projects/199) ("NemoClaw Development Tracker"). When the skill's verdict is `fixed-on-latest`, the issue moves to **Needs Review** AND the issue is assigned to the maintainer who ran the skill (`$GH_IDENTITY` from Step 6.5) — assignment puts the issue in their personal review queue so they don't lose track of what they've staked their name on. After the reporter confirms and the maintainer closes, existing Project automation (or a manual move) advances it to Done. **No move and no assign on `wontfix` / `verify-inconclusive` / no-label-still-reproduces** — those have separate close paths.

This step requires the `project` scope on the maintainer's gh CLI (`gh auth refresh -h github.com -s project` in a real terminal once; OAuth device-code flow). If the scope is missing, the lookup query returns an auth error — fall through with a one-line warning rather than failing the whole run.

```bash
# Project 199 constants (re-run gh project field-list 199 --owner NVIDIA --format json
# if the project gets renamed/restructured and these IDs drift):
PROJECT_ID="PVT_kwDOABpemM4BSCP5"
STATUS_FIELD_ID="PVTSSF_lADOABpemM4BSCP5zg_r9p8"
NEEDS_REVIEW_OPTION_ID="5c5922a9"

# Only fire on fixed-on-latest. Skip silently otherwise.
if [ "$VERDICT" = "fixed-on-latest" ]; then
  # Find the issue's existing project item, if any.
  ITEM_ID=$(gh api graphql -f query='
    query($num: Int!) {
      repository(owner: "NVIDIA", name: "NemoClaw") {
        issue(number: $num) {
          projectItems(first: 10) {
            nodes { id project { number } }
          }
        }
      }
    }' -F num="$ISSUE_NUMBER" \
    --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number == 199) | .id' \
    2>/dev/null | head -1)

  # If the issue isn't on the project yet, add it. (NV QA bots usually add new
  # issues automatically, but cover the gap.)
  if [ -z "$ITEM_ID" ]; then
    ITEM_ID=$(gh project item-add 199 --owner NVIDIA \
      --url "https://github.com/NVIDIA/NemoClaw/issues/$ISSUE_NUMBER" \
      --format json --jq .id 2>/dev/null)
  fi

  if [ -n "$ITEM_ID" ]; then
    gh project item-edit \
      --id "$ITEM_ID" \
      --project-id "$PROJECT_ID" \
      --field-id "$STATUS_FIELD_ID" \
      --single-select-option-id "$NEEDS_REVIEW_OPTION_ID" \
      >/dev/null && echo "[verify-stale] moved #$ISSUE_NUMBER to 'Needs Review' on Project 199"
  else
    echo "[verify-stale] WARN could not resolve project item for #$ISSUE_NUMBER on Project 199 — label applied but tracker not moved"
  fi

  # Self-assign the issue to the maintainer who ran the skill — puts it in their
  # personal review queue alongside the Needs Review state.
  gh issue edit "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --add-assignee "$GH_IDENTITY" \
    >/dev/null && echo "[verify-stale] assigned #$ISSUE_NUMBER to @$GH_IDENTITY"
fi
```

The Step 12 activity log line should record the project move (or the warn-and-skip case) so a maintainer scanning the log can spot tracker drift. Add a `Tracker:` row to the per-issue entry: `Tracker: moved to Needs Review` | `not moved (verdict: <X>)` | `not moved (project lookup failed)`.

---

## Step 11: Infra Failure Handling

Two different failure types, two different responses.

**Latest-install failure** (Step 8d) or reuse-check / provisioning / harness errors: hard infra failure.

- Print the error.
- Apply **no label** — infra failures must not pollute the verification record.
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
**Label applied:** fixed-on-latest | verify-inconclusive | status: wont-fix | none (still-reproduces) | none (infra)
**Tracker:** moved to Needs Review on Project 199 | not moved (verdict: <X>) | not moved (project lookup failed)
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
**Marked `status: wont-fix` (by-design path):** N
**Marked `verify-inconclusive`:** N
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

- Auto-closing issues. Always tag-only; a human pulls the trigger.
- macOS verification *via the Brev path*. Brev offers no macOS instances. The Step 6.7 local-first short-circuit *does* run on a maintainer's macOS laptop — so manual single-issue runs against pure-CLI bugs work on macOS. The weekly batch cron is Linux-only because that path always uses Brev.
- Issues requiring third-party integration credentials (Slack, Discord, Telegram, Hermes, OpenClaw, WeChat).
- Service-account bot identity. v1 runs under each maintainer's own GitHub credentials.
- Versioned labels. A single `fixed-on-latest` label is swept on each release cut.

---

## Companion Behavior

`nemoclaw-maintainer-cut-release-tag` sweeps `fixed-on-latest` and `verify-inconclusive` from all open issues at release time. Without that sweep, "latest" drifts and verifications go stale silently. The by-design path uses the existing repo `status: wont-fix` label; that label is **not** swept (it's also applied for non-skill reasons such as scope or priority decisions, and clearing it would erase human triage work).
