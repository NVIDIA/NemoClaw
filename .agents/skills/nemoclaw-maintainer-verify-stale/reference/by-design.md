<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# verify-stale — By-Design Detection Reference

Use whenever the reproducer points at removed, intentionally changed, or deprecated behavior. This branch can short-circuit Brev cost and recommend Project Status `Won't Fix`, but every claim needs verifiable evidence and the state change requires explicit maintainer approval.

## Contents

- [Step 8.5: Detect "Behavior Changed by Design"](#step-85-detect-behavior-changed-by-design)
- [Signal detection](#step-85a-run-signal-detection)
- [Related failure modes](#step-85b-pre-check-related-failure-modes)
- [Existing test coverage](#step-85c-check-existing-test-coverage)
- [Self-verification pass](#step-85d-self-verification-pass-before-posting)
- [By-design comment template](#by-design-comment-template)

---

## Step 8.5: Detect "Behavior Changed by Design"

Before scoring, check whether an accepted issue, accepted design decision, merged PR, or maintainer comment explicitly establishes that the behavior changed intentionally. Code deletion or symbol absence alone does not establish intent; either can be an accidental regression, rename, or move.

Use these substeps for every by-design investigation. Support each final-comment claim with a comment URL and quoted phrase, a commit SHA and diff range, or a `grep` command and its output. If Step 8.5d cannot reproduce the evidence, select `verify-inconclusive`.

### Step 8.5a: Run signal detection

Signals 2 and 3 trigger investigation only. A `by-design` verdict requires explicit intent evidence from Signal 1 or from an accepted issue, accepted design decision, or merged PR whose text states the intended replacement or removal. Without that evidence, continue runtime verification or select `verify-inconclusive`.

**Signal 1 — Maintainer attribution in comments.** Any comment by an author with `authorAssociation` of `MEMBER`, `OWNER`, or `COLLABORATOR` matches `removed in #\d+`, `removed in [Pp][Rr] ?#\d+`, `by design`, `wontfix`, `won't fix`, `not a bug`, or `intentional`.

```bash
printf '%s' "$COMMENTS" \
  | jq '.[]
        | select(.author_association == "MEMBER" or .author_association == "OWNER" or .author_association == "COLLABORATOR")
        | select(.body | test("removed in (pr )?#\\d+|by design|wontfix|won.?t fix|not a bug|intentional"; "i"))
        | {url: .html_url, author: .user.login,
           evidence: (.body | match("removed in (pr )?#\\d+|by design|wontfix|won.?t fix|not a bug|intentional"; "i").string)}'
```

Use the complete paginated `$COMMENTS` value from candidate selection. `gh issue view --json comments` can truncate older comments and miss the decision that controls the verdict.

Capture for evidence: comment URL + author login + the quoted phrase.

**Signal 2 — Removal commit in range.** A commit between the reported release and `$LATEST` deletes the symbol implicated by the reproducer. Use Git pickaxe search to locate the change, then inspect the linked PR or accepted decision for explicit intent:

Save the reviewed symbol in `$EVIDENCE_DIR/symbol.txt` without interpolating it into a shell command. Then pass it to Git and `grep` as a quoted fixed string:

```bash
SYMBOL=$(<"$EVIDENCE_DIR/symbol.txt")
[ -n "$SYMBOL" ] || { echo "ERROR: reviewed symbol is empty"; exit 1; }

# List commits whose diff changes the count of the reviewed symbol.
git log "$REPORTED_VERSION".."$LATEST" -S"$SYMBOL" \
  --reverse --oneline -- src/ bin/ nemoclaw/src/

# Optional subject narrowing after the pickaxe search.
git log "$REPORTED_VERSION".."$LATEST" \
  --grep='remove\|delete\|drop\|deprecate' -i --oneline

# Confirm that a selected candidate diff deletes the reviewed symbol.
git show --format=fuller --patch <candidate-sha> -- src/ bin/ nemoclaw/src/ \
  | grep -E '^-[^-]' \
  | grep -nF -- "$SYMBOL"
```

Capture for evidence: commit SHA, the deletion, the linked PR or decision, and the text that establishes intent. A deletion with no intent record is not sufficient for `by-design`.

**Signal 3 — Symbol absent in both release tags.** The implicated symbol is not present in either tag's source tree. This can mean the issue used an obsolete command, but it can also mean the search term is wrong or the implementation moved.

Save the reviewed symbol in `$EVIDENCE_DIR/symbol.txt` without interpolating it into a shell command. Then pass it to Git as a quoted argument:

```bash
SYMBOL=$(<"$EVIDENCE_DIR/symbol.txt")
[ -n "$SYMBOL" ] || { echo "ERROR: reviewed symbol is empty"; exit 1; }
git grep -n -e "$SYMBOL" "$REPORTED_VERSION" -- src/ bin/ nemoclaw/
git grep -n -e "$SYMBOL" "$LATEST" -- src/ bin/ nemoclaw/
```

Capture for evidence: both grep commands and their outputs. Locate the accepted decision or merged PR that defines the replacement before selecting `by-design`.

**Sub-case for signals 2 and 3 — vestigial deprecation shims.** A removed symbol can remain in `$LATEST` only as a deprecation message, such as a command that reports `--<flag> was removed; use <X> instead` and exits non-zero. Inspect every match. If every match is a deprecation stub with no functional effect on the reported bug, signal 2 or 3 still applies. Record the shim locations and behavior as a separate evidence block. Do not treat a shim as functional code or as absence.

### Step 8.5b: Pre-check related failure modes

A by-design verdict says that the reported reproducer cannot execute under the intended contract. It does not establish that every similar symptom is fixed. Before drafting the comment, search the `$LATEST` source for other paths that can produce the reported symptom.

Save each reviewed redacted symptom keyword as data, then pass both values to Git as quoted arguments:

```bash
SYMPTOM_ONE=$(<"$EVIDENCE_DIR/symptom-keyword-1.redacted.txt")
SYMPTOM_TWO=$(<"$EVIDENCE_DIR/symptom-keyword-2.redacted.txt")
[ -n "$SYMPTOM_ONE" ] || { echo "ERROR: first symptom keyword is empty"; exit 1; }
[ -n "$SYMPTOM_TWO" ] || { echo "ERROR: second symptom keyword is empty"; exit 1; }

git grep -n \
  -e "$SYMPTOM_ONE" \
  -e "$SYMPTOM_TWO" \
  "$LATEST" -- src/ nemoclaw/src/
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

### Step 8.5e: If explicit intent evidence exists

- **Skip the Step 9 score table** entirely. The "exit 0 + expected output" axis doesn't apply when the expected output is no longer the contract.
- **Skip Brev instance creation** only if explicit intent evidence is established before Step 7. A remote run would only reconfirm behavior whose intended replacement or removal is already documented. Signals 2 and 3 can start the investigation after parsing the reported version, but cannot skip Brev by themselves.
- **Prepare a dry run** containing Project Status `Won't Fix`, the public comment, the durable `by-design` marker, and `human_review_required: true`.
- **Request explicit maintainer approval** for that write set. Do not substitute a status label or write before approval.
- **On approval, update Project Status first, then post the accepted comment.** If approval is withheld, report the evidence without mutating GitHub.
- **Use the by-design comment template below** instead of the standard Step 10 template.
- **@-mention the reporter** so they can object if the framing is wrong.
- **Never auto-close.** A maintainer separately decides whether to close after reviewing the evidence and reporter response.

### By-design comment template

Mandatory sections in this order. Omit only the sections explicitly noted as omittable.

**Tag-anchoring + linking rule.** Every `file:line` citation, commit SHA, and test-path reference in the rendered comment MUST be a clickable markdown link to the verified-on tag (e.g., `v0.0.35`), not the maintainer's working `HEAD`. Lines drift between tags and main; tag-anchored links keep the citations reproducible by anyone reading the comment months later. Bare paths force the reader to navigate manually — that's a usability bug, not a stylistic preference.

Use these link formats:

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
**Verification mode:** static analysis at the verified release tag; no runtime reproduction. Step 8.5 skips Brev instance creation because explicit intent evidence establishes the intended removal or replacement.
**Outcome:** the reproducer invokes behavior that an accepted decision or merged change intentionally removed or replaced.

### What's structurally fixed

- `<file:line>` — `<one-sentence summary of the change at that location>`
- `<file:line>` — `<…>`

The new workflow is `<one-sentence: how to do what the user was trying to do>`.

### Vestigial references

- `<file:line>` — `<deprecation behavior: e.g. "prints '--<flag> was removed; use <X> instead' and exits 1; no functional effect">`

(Omit this section entirely when the symbol is fully gone with no surviving stubs.)

### What's not literally the same bug

`<one-sentence acknowledgement of the related failure mode found in Step 8.5b, with file:line>` — OR — `None. The symptom requires the removed symbol; no related code path produces it on the newest release tag.`

### Existing CI coverage

- `<test/path/file>` — `<one-sentence: what this test demonstrates about the new workflow>`

(Omit when no direct test exists. Do not invent paths.)

### Recommendation

@<reporter> — please confirm the by-design framing is correct (the implicated `<symbol>` was intentionally removed and the original reproducer can no longer execute). A maintainer will decide closure separately. If a related symptom (e.g. `<related failure mode from above>`) is hitting you on ≥ v0.0.<Z>, please file a fresh issue with a v0.0.<Z>+ reproducer.

`<NVBugs cross-ref line — see below>`

<!-- nemoclaw-verify-stale v1 verdict=by-design YYYY-MM-DD -->
````

**NVBugs cross-ref line.** If `NVBUGS_REF` was set in Step 4, append:

> NVBugs<NVBUGS_REF without brackets> will need a separate update; closing this GitHub issue won't propagate.

Otherwise omit the sentence.

**If no signal fires:** continue to Step 9 normally.

---
