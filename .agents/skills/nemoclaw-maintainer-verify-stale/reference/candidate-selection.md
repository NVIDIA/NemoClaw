<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — Candidate Selection Reference

Use after loading `SKILL.md` to choose an issue and establish its reported NemoClaw version.

## Contents

- [Step 1: Determine Mode](#step-1-determine-mode)
- [Step 2: Detect the Latest NemoClaw Version](#step-2-detect-the-latest-nemoclaw-version)
- [Step 3: Filter Candidates](#step-3-filter-candidates)
- [Step 4: Parse Reported Version](#step-4-parse-reported-version)

---

## Step 1: Determine Mode

**Single-issue mode** — user provides an issue number:

```bash
gh issue view <number> --repo NVIDIA/NemoClaw \
  --json number,title,body,labels,url,author,createdAt,comments
```

**Batch mode** — user says "batch", "weekly", or provides no number. Cap at **15 issues** for *processing* per run, enforced as a slice after Step 3/4 filters narrow the pool. The cap exists because batch is sequential (Step 7 reuse-or-provision keeps it on 1–2 Brev boxes total) and the wallclock budget is ~2–3 hours per 15-issue run; running larger forces the maintainer to either drop the per-plan approval gate or spread the batch across multiple sessions.

The discovery query needs to see the entire open-bug pool — the per-run processing cap is downstream. Use `--limit 1000` so the skill doesn't silently drop issues beyond the page (the candidate triage run found 129 open bugs; an earlier `--limit 100` would have missed 29 of them).

```bash
gh issue list --repo NVIDIA/NemoClaw --state open --limit 1000 \
  --label bug \
  --json number,title,body,labels,url,author,createdAt,comments
```

In batch mode, work through items one at a time. Present each verification plan and wait for approval before any Brev provisioning.

---

## Step 2: Detect the Latest NemoClaw Version

Try GitHub releases first; fall back to the highest semver tag from the GitHub API if no release is published. NemoClaw currently tags but does not publish releases, so the fallback is the load-bearing path today. Use `gh api` rather than `git ls-remote` so the skill works regardless of SSH key setup, and reuses the auth `gh` already has.

```bash
LATEST=$(gh release view --repo NVIDIA/NemoClaw --json tagName -q .tagName 2>/dev/null)

if [ -z "$LATEST" ]; then
  LATEST=$(gh api repos/NVIDIA/NemoClaw/tags --paginate --jq '.[].name' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V | tail -1)
fi

echo "Latest tag: $LATEST"
```

This is the version the skill will verify against. Record it — every comment must cite it.

---

## Step 3: Filter Candidates

Apply these rules in order. Drop any issue that fails a rule.

**Issue-type allowlist:** must have `bug` label.
**Issue-type skip:** drop if any label exactly matches `documentation`, `status: wont-fix`, `status: needs-info`, `security`, OR is `enhancement` / starts with the prefix `enhancement:` (the repo carries several prefixed variants — `enhancement: feature`, `enhancement: MCP`, `enhancement: testing`, `enhancement: ui`, `enhancement: provider`, `enhancement: platform`, `enhancement: policy`, `enhancement: inference`, `enhancement: integration`, `enhancement: performance`, `enhancement: skill` — and exact-match misses them all; surfaced from #1752; enumerate via `gh label list -L 200 --search enhancement` if you need the live set). Use the canonical repo label names — bare `wontfix` / `needs-info` are NOT the repo's labels (verified via `gh label list`); the actual labels carry a `status:` prefix and a hyphen.

**Platform skip (Brev-reproducible only in v1):** drop if any of `Platform: Windows/WSL`, `Platform: MacOS`, `Platform: macOS`, `Platform: Jetson AGX Thor/Orin`. Brev has no equivalent hardware for Jetson (embedded/edge ARM with integrated GPU is not in the Brev SKU catalog), so any Brev verification of a Jetson-only bug would produce a misleading "fixed-on-x86" verdict. Keep `Platform: Ubuntu`, `Platform: DGX Spark`, `Platform: GB10`, `Platform: All`, or no platform label. `Platform: DGX Spark` and `Platform: GB10` stay in scope but Step 10 requires a "Hardware substitution" caveat in the comment naming the Brev SKU we used as a substitute (Brev x86 GPU SKUs are not faithful to GB10 / Grace Hopper silicon for performance-shape or memory-architecture-shape bugs).

**TUI / interactive-UI skip:** drop if the issue title contains `TUI`, `dashboard UI`, `chat UI`, `keystroke`, or `key press`, OR if the body describes interactive UI behavior (key sequences, mouse interactions, browser-side UI state) without a non-interactive reproducer (no `NEMOCLAW_NON_INTERACTIVE=1` or equivalent env var pattern). `brev exec` does not allocate a real TTY by default, so TUI reproducers hang or silently fail at the first prompt; v1 documents this as out-of-scope rather than emitting a wrong verdict. v1.1 may add a `script(1)` / `expect` / `tmux send-keys` harness to lift this skip.

**Integration skip (deferred to v2):** drop if any of `Integration: Slack`, `Integration: Discord`, `Integration: Telegram`, `Integration: Hermes`, `Integration: OpenClaw`, `Integration: WeChat`. These need third-party credentials a fresh Brev box cannot provide.

**Component allowlist (must have at least one):** `NemoClaw CLI`, `Sandbox`, `OpenShell`, `Docker`, `Getting Started`, or any `Platform:` label that survived the platform skip.

**Idempotency:** drop if **either** of these is true:

- The issue carries a `fixed-on-latest` or `verify-inconclusive` label. (Cleared by the release sweep in `nemoclaw-maintainer-cut-release-tag` so the issue re-opens on each release.) The by-design path uses the existing repo `status: wont-fix` label, which is already covered by the issue-type skip rule above — no separate idempotency clause needed for that path.
- A comment matching `<!-- nemoclaw-verify-stale v\d+ YYYY-MM-DD -->` was posted **within the last 7 days**. The regex matches any marker version (`v1`, `v2`, …) so future skill versions can re-verify older-marked issues by tightening the regex (e.g. require a specific marker version). The marker carries a date so the candidate filter can apply a TTL — useful for the still-reproduces case (Step 9), where no label is applied and we want next week's run to re-verify rather than skip forever.

Implementation — match the marker against each comment's `createdAt`. Use `gh issue view --json comments` (single-issue mode already fetches this; batch mode's `gh issue list` also returns the comment array per issue):

```bash
# Cutoff for the 7-day TTL. macOS and Linux date(1) syntax differ; try both.
SEVEN_DAYS_AGO=$(date -u -v-7d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)

# Returns the timestamp of the most recent marker comment within the TTL, or empty.
RECENT_MARKER=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq --arg cutoff "$SEVEN_DAYS_AGO" '
    .comments[]
    | select(.body | test("<!-- nemoclaw-verify-stale v\\d+ \\d{4}-\\d{2}-\\d{2} -->"))
    | select(.createdAt > $cutoff)
    | .createdAt' \
  | head -1)

if [ -n "$RECENT_MARKER" ]; then
  echo "Skip: marker posted $RECENT_MARKER (within 7-day TTL)"
  # In single-issue mode: exit 0 with a friendly message.
  # In batch mode: continue to the next candidate.
fi
```

Run this check for every candidate that survived the label-based filters above; drop those whose `RECENT_MARKER` is non-empty.

**Unanswered-maintainer-question handling.** Find the most recent maintainer (`MEMBER`, `OWNER`, `COLLABORATOR`) comment that **looks like a question** (`?`, polite imperative like "please confirm/share/clarify", or starter like "could you / can you / do you") AND that the reporter has not replied to since. Pure triage acknowledgments (`"✨ Thanks for reporting…"`) are skipped. The age of the qualifying comment determines skip-or-proceed:

- **Within 7 days:** **skip the issue** — the discussion is active, the skill running on top would conflict with the maintainer's framing or confuse the reporter. Surfaced during pre-flight on #2757; running verify-stale on top of a fresh "let me clarify what you observed" question from @cjagwani would have stomped on that conversation.
- **Older than 7 days:** **proceed with verification, but use the unanswered-question comment variant.** After 7 days the maintainer's question has either been forgotten or the reporter has dropped the ball; an independent skill verdict becomes the *unsticking voice* rather than a clueless interruption. The comment leads with a markdown link to the maintainer's unanswered comment (use the unanswered-question shape from the comment templates) and @-mentions BOTH the maintainer and the reporter, not just the reporter. Reuse `$SEVEN_DAYS_AGO` from the marker-TTL check above.

```bash
REPORTER=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json author --jq .author.login)

# Most recent unanswered maintainer comment that looks like a question — filters out triage acknowledgments (#1642 surfaced this).
# Question-detection patterns are chained as separate test() calls so each
# heuristic is independently readable and a future addition (e.g. "what about",
# "why does") is a one-line append rather than a regex-alternation patch.
UNANSWERED_MAINT=$(gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq --arg reporter "$REPORTER" --arg cutoff "$SEVEN_DAYS_AGO" '
    (.comments
     | map(select((.authorAssociation == "MEMBER" or .authorAssociation == "OWNER" or .authorAssociation == "COLLABORATOR")
         and (.body | test("\\?")                                                                       # literal "?"
                   or test("(?i)\\bplease (confirm|share|provide|clarify|tell|verify|check|let me know|let us know)")  # polite imperative
                   or test("(?i)\\b(could|can|would) you\\b")                                            # modal interrogative
                   or test("(?i)\\bdo you (have|know|see|use)\\b"))))                                    # "do you ..."
     | sort_by(.createdAt) | last) as $maint
    | if $maint == null then null
      else
        ((.comments
          | map(select(.author.login == $reporter and .createdAt > $maint.createdAt))
          | length) as $replies
         | if $replies > 0 then null
           else {
             createdAt: $maint.createdAt,
             url: $maint.url,
             login: $maint.author.login,
             recent: ($maint.createdAt > $cutoff)
           }
           end)
      end')

if [ -n "$UNANSWERED_MAINT" ] && [ "$UNANSWERED_MAINT" != "null" ]; then
  MAINT_RECENT=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .recent)
  MAINT_DATE=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .createdAt)
  MAINT_LOGIN=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .login)
  MAINT_URL=$(printf '%s' "$UNANSWERED_MAINT" | jq -r .url)

  if [ "$MAINT_RECENT" = "true" ]; then
    echo "Skip: active maintainer discussion (unanswered comment from @$MAINT_LOGIN at $MAINT_DATE, within 7 days)"
    # Single-issue mode: exit 0 with the message; batch mode: continue to next candidate.
  else
    echo "[verify-stale] proceeding with unanswered-question variant — @$MAINT_LOGIN's comment from $MAINT_DATE is older than 7 days"
    # Step 10's comment template will lead with the unanswered-question prefix and @-mention
    # both the maintainer and the reporter. Export these for the templater:
    export UNANSWERED_MAINT_LOGIN="$MAINT_LOGIN"
    export UNANSWERED_MAINT_URL="$MAINT_URL"
    export UNANSWERED_MAINT_DATE="$MAINT_DATE"
  fi
fi
```

When the unanswered-question variant fires (`UNANSWERED_MAINT_LOGIN` set), Step 10's comment template prepends a lead paragraph (exact shape lives with the templates in Step 10), and the closing @-mention block names BOTH the maintainer (acknowledging their question) and the reporter (asking for confirmation per the standard pattern), instead of just the reporter.

**Candidate rule:** keep the issue if **either**:

- The reported version (parsed from body or labels — see Step 4) is **at least 2 versions behind** `$LATEST` in the rightmost-incrementing component, **or**
- The issue is **older than 7 days** AND a specific version is parseable from its body or labels.

For NemoClaw's current `0.0.x` line, "rightmost-incrementing component" is the patch number — a v0.0.31 report against a v0.0.34 latest is 3 versions behind. Once NemoClaw moves to `0.1.x` or higher, the rule applies to the next-rightmost component instead. Pick whichever component is actively iterating.

---

## Step 4: Parse Reported Version

The regex is intentionally **release-line agnostic**. Today NemoClaw ships `v0.0.x`, but the same parser must keep working when it moves to `v0.1.x`, `v1.x.x`, or anything else. Don't hardcode the major/minor digits.

Sources, in order of trust:

1. **Labels.** Any label that exactly matches `^v\d+\.\d+\.\d+$` AND appears in the repo's tag list. Labels matching the regex but absent from tags (e.g. `v0.0.35` as a *release-target* milestone before that version ships) are roadmap markers, not "reported on" — drop them.
2. **Body.** Use a **proximity-anchored** regex: `(?i)nemoclaw[^a-z\n]{0,80}v?(\d+\.\d+\.\d+)`. This matches a version that follows `nemoclaw` within 80 non-letter, non-newline characters, capturing just the semver. The anchoring is load-bearing — without it the parser also picks up `openshell 0.0.4`, Node.js `v22.16.0`, IP addresses (`0.0.0.0:11434`, `127.0.0.1`), and other near-NemoClaw products that happen to share the `v0.0.x` line. (This was confirmed in the dry-run: a non-anchored parser produced 12 false-positive candidates whose smallest tag-valid version was actually OpenShell's, not NemoClaw's.)
3. **Comments by the original reporter** — same anchored regex as the body.

Collect every match from sources 2 and 3 (a single body may mention multiple versions — `0.0.6 and v0.0.10`). Then validate.

**Validate against the tag list.** A parsed version must exist as a real git tag, otherwise drop it. This single check kills four classes of error in one pass:

- Reporter typos that cite a non-existent version (`v0.1.0` when only `v0.0.x` is released — observed 3× in the live backlog).
- Calver mistakes (`2026.3.11` — observed 1×).
- Future roadmap labels that slipped past source 1.
- Versions parsed from prose that happen to look semver-ish but aren't releases.

**Normalize to tag form before validating.** The body/comment regex captures only the digit portion (`(\d+\.\d+\.\d+)`) — the leading `v?` sits outside the capture group on purpose. Tags carry the `v`, labels carry the `v`, and `REPORTED_VERSION` (set on L196 below) must carry the `v`. Without an explicit prepend, `grep -Fxq "0.0.32"` against a tag list whose entries are `v0.0.32` would drop every body-sourced candidate.

```bash
gh api repos/NVIDIA/NemoClaw/tags --paginate --jq '.[].name' > /tmp/nemoclaw-tags.txt

# For each candidate version V — normalize to full tag form, then validate.
# Label-sourced candidates already have the `v` (idempotent); body/comment-sourced
# candidates do not.
[[ "$V" =~ ^v ]] || V="v$V"
grep -Fxq "$V" /tmp/nemoclaw-tags.txt || drop_version "$V"
```

After validation, **pick the smallest surviving version** as the reported version (most conservative — it maximizes versions-behind). This handles "this bug was first reported on v0.0.6 and still happens on v0.0.10" cleanly: we verify against latest, and if the bug is gone, both reports are addressed.

If no version survives, drop the issue from the candidate set — we cannot establish "previous version".

**Variable format for downstream steps.** Set `REPORTED_VERSION` to the **full tag string** (e.g., `REPORTED_VERSION="v0.0.32"`), not just the patch number. Step 8a's installer expects the full tag via the `NEMOCLAW_INSTALL_TAG` env var.

**Batch cap enforcement.** In batch mode, after Step 3 label filters and the Step 4 version+candidate-rule filters narrow the pool, sort surviving candidates by `(-versions_behind, -age_days)` so the most stale come first, then **slice to the top 15**:

```bash
# Each candidate has at minimum: number, reported, behind, age_days
SLICED=$(printf '%s' "$CANDIDATES_JSON" | jq '
  sort_by([-(.behind // 0), -(.age_days // 0)])
  | .[0:15]')
SLICED_COUNT=$(printf '%s' "$SLICED" | jq 'length')
TOTAL=$(printf '%s' "$CANDIDATES_JSON" | jq 'length')
echo "Batch run: processing $SLICED_COUNT of $TOTAL eligible candidates (cap: 15)."
[ "$TOTAL" -gt 15 ] && echo "  Spillover: $((TOTAL - 15)) candidates deferred to next run; the marker-comment TTL (Step 3) keeps them eligible."
```

The slice is the only enforcement of the cap — without it, "Cap at 15" is policy that nothing actually applies. Single-issue mode bypasses the cap entirely (the user explicitly named one issue).

**NVBugs cross-reference.** Many NV QA bugs include an NVBugs ticket footer like `[NVB#6100043]`. Extract it at the same time as the version so Step 8.5's comment template (and any other comment template that wants to mention it) can include the cross-reference:

```bash
NVBUGS_REF=$(printf '%s' "$BODY" | grep -oE '\[NVB#[0-9]+\]' | head -1)
```

Templates ignore this when empty. When present, the comment must note that closing the GitHub issue does not propagate to NVBugs and QA needs to update the ticket separately.

### Implementer note: regex-pipeline pitfalls

Three real failure modes surfaced during the v1 dry-run. Test each before trusting your implementation:

1. **Empty-match handling.** A naive pipeline like `[scan(regex)] | first | .[0] | tonumber // fallback` silently dropped 9 real candidates (e.g. #2861 with `NemoClaw 0.0.32`, #2604 with `NemoClaw: 0.0.28`). When `scan` returns no matches, `[]` flows in, `first` returns null, `null | .[0]` errors, and `//` does not propagate cleanly through the error. Bind each pass to a named variable, coalesce at the end:

   ```text
   primary  := first nemoclaw-anchored match in body  (or null)
   result   := primary ?? null
   ```

   Then explicitly test against a body with **no** version mention.

2. **Capture-group consistency.** A regex without a capture group (e.g. `\bv\d+\.\d+\.\d+\b`) makes `scan` emit raw strings; with a capture group (e.g. `\b(v\d+\.\d+\.\d+)\b`), `scan` emits arrays. Mixing the two within one pipeline (`first | .[0]?`) works for one and silently fails for the other. Use capture groups consistently across all branches.

3. **Variable scoping in `select(...)`.** A line like `select($tags | index(.))` rebinds `.` to `$tags` inside the parens, so `.` no longer refers to the surrounding label being checked. Bind first: `. as $lbl | select($tags | any(. == $lbl))`. Symptom in this dry-run: the future-release label `v0.0.35` passed validation that should have rejected it.

---
