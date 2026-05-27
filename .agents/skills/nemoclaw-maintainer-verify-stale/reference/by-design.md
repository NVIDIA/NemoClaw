<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — By-Design Detection Reference

Use whenever the reproducer points at removed, intentionally changed, or deprecated behavior. This branch can short-circuit Brev cost and label `status: wont-fix`, but every claim needs verifiable evidence.

## Contents

- [Step 8.5: Detect "Behavior Changed by Design"](#step-85-detect-behavior-changed-by-design)
- [Signal detection](#step-85a-run-signal-detection)
- [Related failure modes](#step-85b-pre-check-related-failure-modes)
- [Existing test coverage](#step-85c-check-existing-test-coverage)
- [Self-verification pass](#step-85d-self-verification-pass-before-posting)
- [By-design comment template](#by-design-comment-template)

---

## Step 8.5: Detect "Behavior Changed by Design"

Before scoring, check whether the symptom is intentional. Some bugs are filed against behavior that was **deliberately changed or removed** in a merged PR — running the standard rubric on these produces misleading verdicts. The symptom "still reproduces" but the right answer is "won't fix, see PR #X." Issue #2791 is the prototype: `config set` was removed in PR #2227, the reporter tested a version that already had it gone, and a standard rubric run would have buried that context under a low-confidence `verify-inconclusive` label.

This step is split into substeps so the rigor is mechanical, not optional. Every claim in the final comment must be backed by a verifiable evidence block — a comment URL with quoted phrase, a commit SHA with diff range, or a grep command with its actual output. Hand-wavy claims fail Step 8.5d's self-verification pass and force a bail to `verify-inconclusive`.

### Step 8.5a: Run signal detection

Any single signal is sufficient to trigger the by-design branch.

**Signal 1 — Maintainer attribution in comments.** Any comment by an author with `authorAssociation` of `MEMBER`, `OWNER`, or `COLLABORATOR` matches `removed in #\d+`, `removed in [Pp][Rr] ?#\d+`, `by design`, `wontfix`, `won't fix`, `not a bug`, or `intentional`.

```bash
gh issue view "$ISSUE_NUMBER" --repo NVIDIA/NemoClaw --json comments \
  --jq '.comments[]
        | select(.authorAssociation == "MEMBER" or .authorAssociation == "OWNER" or .authorAssociation == "COLLABORATOR")
        | select(.body | test("removed in #\\d+|by design|wontfix|won.t fix|not a bug|intentional"; "i"))
        | {url, author: .author.login, body}'
```

Capture for evidence: comment URL + author login + the exact quoted phrase.

**Signal 2 — Removal commit in range.** A commit between the reported version and `$LATEST` deletes the symbol implicated by the reproducer (CLI subcommand, function, flag). The commit subject does NOT need to mention "remove" / "delete" — many removals ride into a `refactor(...)` or `feat(...)` commit (e.g. PR #2227 removed `--dangerously-skip-permissions` under a `refactor(sandbox): ...` subject). Use git's pickaxe to find the responsible commit by content:

```bash
# Pickaxe: list every commit whose diff changes the count of <symbol> occurrences.
# Reverse order so the earliest removal commit lands first in the list.
git log "$REPORTED_VERSION".."$LATEST" -S'<symbol>' --reverse --oneline -- src/ bin/ nemoclaw/src/

# Subject-keyword narrowing is only a SUPPLEMENTARY lookup — useful when the
# pickaxe returns many commits and you want to focus on the obviously-removal one.
git log "$REPORTED_VERSION".."$LATEST" --grep='remove\|delete\|drop\|deprecate' -i --oneline

# For each candidate, confirm the diff actually deletes the symbol (not just renames or moves it).
git log -p <candidate-sha> -- src/ bin/ nemoclaw/src/ | grep -nE '^-.*\b<symbol>\b'
```

Capture for evidence: commit SHA + each `file:line` block of deletions touching the symbol. Note the commit's actual subject — don't assume it says "remove."

**Signal 3 — Symbol absent in both reported version and latest.** The implicated symbol (e.g. `config set`) is not present in either tag's source tree — meaning the responsible change landed before the version the reporter tested. This is the #2791 case.

```bash
git grep -n "<symbol>" "$REPORTED_VERSION" -- src/ bin/ nemoclaw/   # expect: zero matches (or shim-only — see sub-case)
git grep -n "<symbol>" "$LATEST"            -- src/ bin/ nemoclaw/   # expect: zero matches (or shim-only)
```

Capture for evidence: both grep commands and their (empty) outputs.

**Sub-case for signals 2 and 3 — vestigial deprecation shims.** It's common for a removed symbol to survive in latest *only* as a deprecation message (e.g., a CLI subcommand that prints `"--<flag> was removed; use <X> instead"` and exits non-zero). When a grep returns matches in latest, inspect each `file:line`. If every match is a deprecation stub with no functional effect on the bug-as-filed, signal 2 or 3 still fires; record the shim locations and behavior as a separate evidence block. Do not silently treat shims as functional code, and do not silently treat them as absence.

### Step 8.5b: Pre-check related failure modes

A by-design verdict says "the bug *as filed* can't reproduce." It does NOT say "every bug shaped like this is fixed." Before drafting the comment, search latest's source for code paths that could still produce the issue's described **symptom** (not the literal removed flag/symbol — the symptom).

```bash
# Use the issue's symptom keywords, not the removed symbol.
git grep -nE "<symptom-keyword-1>|<symptom-keyword-2>" "$LATEST" -- src/ nemoclaw/src/
```

For #2168 the literal flag is `--dangerously-skip-permissions`, but the symptom is "sandbox created but not registered in CLI." Grepping for `register.*[Ss]andbox`, the readiness-gate / cleanup-failure path in `src/lib/onboard.ts` surfaces as a related-but-different way to produce an orphan sandbox.

If a related failure mode is found, the by-design comment MUST include a "What's not literally the same bug" section that names it with `file:line`. Don't suppress the call-out by claiming "the symptom is impossible" when the symptom can be reached via a different path.

### Step 8.5c: Check existing test coverage

Search the repo for tests that exercise the NEW intended workflow (the one that replaced the removed symbol). Citing them strengthens the comment from "trust me, it was removed" to "the new workflow is exercised by these tests."

```bash
git grep -lnE "<new-workflow-keyword>" -- test/ nemoclaw/src/ 2>/dev/null | head -5
```

Cite at most three concrete test paths. If none exist, omit the section — do not invent paths.

### Step 8.5d: Self-verification pass before posting

Two passes, both required.

**Evidence pass.** Re-run every grep / git / `gh` command cited in the evidence blocks. If any cited `file:line`, commit SHA, or quoted output doesn't reproduce on a fresh invocation, **stop and revise** — or bail to `verify-inconclusive` if the discrepancy can't be resolved.

**Link pass.** Resolve at least one rendered markdown link from each section that has them — `What's structurally fixed`, `Vestigial references`, `Existing CI coverage`. Use `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=<tag>` (returns 200 + base64 content if the path exists at the tag, 404 otherwise) or `curl -fsI <blob-url>` (returns 200 if the blob renders). A broken link is worse than no link — it suggests verification work that didn't actually happen.

The cost of an incorrect "I checked and X is gone" claim in a public comment, or a 404 on a citation, is higher than spending a minute re-checking. This step exists because LLMs can confidently overstate and confidently invent paths; mechanical re-verification catches both.

### Step 8.5e: If any signal fires

- **Skip the Step 9 score table** entirely. The "exit 0 + expected output" axis doesn't apply when the expected output is no longer the contract.
- **Skip Brev provisioning** if the signal fires before Step 7 — a remote run would just confirm what static analysis already proved. (Signals 2 and 3 can run as soon as the reported version is parsed in Step 4.)
- **Apply label `status: wont-fix`** (the existing repo label — quote it on the CLI: `gh issue edit <num> --add-label "status: wont-fix"`). It's already in the Step 3 issue-type skip list, so a labelled issue is automatically excluded from future runs without needing a separate idempotency clause.
- **Use the by-design comment template below** instead of the standard Step 10 template.
- **@-mention the reporter** so they can object if the framing is wrong.
- **Never auto-close.** A maintainer pulls the trigger, same as the other label paths.

### By-design comment template

Mandatory sections in this order. Omit only the sections explicitly noted as omittable.

**Tag-anchoring + linking rule.** Every `file:line` citation, commit SHA, and test-path reference in the rendered comment MUST be a clickable markdown link to the verified-on tag (e.g., `v0.0.35`), not the maintainer's working `HEAD`. Lines drift between tags and main; tag-anchored links keep the citations reproducible by anyone reading the comment months later. Bare paths force the reader to navigate manually — that's a usability bug, not a stylistic preference.

Use these exact link formats:

- File only: `[src/lib/onboard.ts](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/onboard.ts)`
- File:line: `[src/lib/onboard.ts:4965](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/onboard.ts#L4965)`
- File:line-range: `[src/lib/commands/sandbox/connect.ts:25-31](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/src/lib/commands/sandbox/connect.ts#L25-L31)`
- Commit SHA: `[5956a61](https://github.com/NVIDIA/NemoClaw/commit/5956a612e18047b9ab85b3a7e89f6b5dedb29190)` — short SHA as the link text, full SHA in the URL
- Test file: `[test/e2e/test-double-onboard.sh](https://github.com/NVIDIA/NemoClaw/blob/v0.0.35/test/e2e/test-double-onboard.sh)`
- PR/issue references: bare `#NNNN` works — GitHub auto-links these in comments on the same repo, no manual URL needed.

When grepping for evidence, use `git grep -n "<symbol>" "$LATEST" -- ...` so the line numbers match the tagged blob. Then construct each link from `<file path> + verified-on tag + line number`.

The Step 8.5d self-verification pass MUST resolve at least one rendered link (e.g., `gh api repos/NVIDIA/NemoClaw/contents/<path>?ref=v0.0.35` or a `curl -fsI` to the blob URL) and confirm it returns the expected file. A broken link defeats the purpose of including the citation. If any link fails to resolve, fix it or bail to `verify-inconclusive`.

````markdown
## Stale-issue verification — behavior is by-design

**Reported on:** v0.0.<X>
**Verified on:** v0.0.<Y> (PR #<NNNN> first shipped in v0.0.<Z>)
**Verification mode:** static analysis at the verified-on tag — no runtime reproduction. Step 8.5 by-design short-circuits Brev provisioning because the responsible code change is already proven by the diff between `$REPORTED_VERSION` and `$LATEST`.
**Outcome:** symptom reproduces against the reproducer as filed, but the implicated behavior was intentionally changed.

### What's structurally fixed

- `<file:line>` — `<one-sentence summary of the change at that location>`
- `<file:line>` — `<…>`

The new workflow is `<one-sentence: how to do what the user was trying to do>`.

### Vestigial references

- `<file:line>` — `<deprecation behavior: e.g. "prints '--<flag> was removed; use <X> instead' and exits 1; no functional effect">`

(Omit this section entirely when the symbol is fully gone with no surviving stubs.)

### What's not literally the same bug

`<one-sentence acknowledgement of the related failure mode found in Step 8.5b, with file:line>` — OR — `None. The symptom requires the removed symbol; no related code path produces it on latest.`

### Existing CI coverage

- `<test/path/file>` — `<one-sentence: what this test demonstrates about the new workflow>`

(Omit when no direct test exists. Do not invent paths.)

### Recommendation

@<reporter> — please confirm the by-design framing is correct (the implicated `<symbol>` was intentionally removed, the original reproducer can no longer execute) and close as "won't fix / by design" if you agree. If a related symptom (e.g. `<related failure mode from above>`) is hitting you on ≥ v0.0.<Z>, please file a fresh issue with a v0.0.<Z>+ reproducer.

`<NVBugs cross-ref line — see below>`

<!-- nemoclaw-verify-stale v1 YYYY-MM-DD -->
````

**NVBugs cross-ref line.** If `NVBUGS_REF` was set in Step 4, append:

> NVBugs<NVBUGS_REF without brackets> will need a separate update; closing this GitHub issue won't propagate.

Otherwise omit the sentence.

**If no signal fires:** continue to Step 9 normally.

---
