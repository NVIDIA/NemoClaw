# Tier 2 — Code Quality Checks

Four 1%-clever LLM judgments. Score: pass = 1, yellow = 0.5, fail = 0; weight 1.0× per check.

## Contents

- 2.1 Description-vs-diff drift
- 2.2 Migration completion
- 2.3 Public surface preservation
- 2.4 Workaround-vs-root-cause

## 2.1 Description-vs-diff drift

Every touched file must be named or implied by the PR description's "Changes" section. Files outside the stated scope are "while I'm here" tweaks — common in long stacks where authors are heads-down and unrelated cleanups drift in.

**How to evaluate:** From `gh pr view <pr> --json files,body`, build a set of touched files. Cross-reference against files named in the description. Files not named or implied by the description = yellow flag.

**Implied counts as covered:** If the description says "extracts onboard parsing into a new module," touching both `onboard.ts` and a new `onboard-parser.ts` is implied. But touching `unrelated-helper.ts` is not.

## 2.2 Migration completion

If the PR adds a new path (oclif version, v2 helper, replacement function, new format), the old path must be either:

- Deleted in this PR, OR
- Linked to a follow-up PR/issue in the body

Both surviving with no follow-up link = incomplete migration → yellow.

**How to evaluate:** Look for diff additions that name a "v2" / "new" / "oclif" version of an existing symbol. Then grep the post-PR codebase for the old symbol's usages. If callers still use the old path AND the body has no follow-up link, flag.

**Why this catches real bugs:** Half-migrations create maintenance debt. The new path drifts ahead, the old path bit-rots, callers get confused about which to use.

## 2.3 Public surface preservation

For any content **change** (not pure move) in:

- Flag definitions (`--name`, `Flags.<x>(`, oclif flag schemas)
- Help/usage strings (`Usage:`, `description:`, `summary:`)
- Error messages (`throw new Error(`, `console.error`)
- Exit codes (`process.exit(`)

…the PR body must have a Notes section explaining the change, AND the corresponding docs files (per `repo-policy.md`'s `docs_dir`) must be updated.

**Distinguishing moves from changes:** Pure moves (added in one file, removed in another with same string content) are fine — no Notes or docs update needed. The check is for **content changes**: adding a new flag, renaming an existing one, rewriting an error message.

**Yellow if:** Content changes are present but no Notes section.
**Fail if:** Content changes change user-facing behavior AND no Notes AND no docs update.

**Why this catches real bugs:** Authors often make small UX changes (error message wording, help format) without realizing they're public-surface changes. End users notice. Forcing a Notes section forces awareness.

## 2.4 Workaround-vs-root-cause

Grep the diff for symptom-suppression patterns:

- `try { ... } catch { /* empty or swallow */ }` blocks
- `catch (err) { return; }` with no rethrow or logging
- `if (err.code === '<errno>') return` (errno-specific silent ignores like EACCES, ENOENT, EEXIST)
- Defensive returns in error paths that hide failures from callers

If any are added in the diff, the PR body must (a) link to a follow-up issue for the root-cause fix, OR (b) explain why the suppression is the correct behavior (e.g., "expected during shutdown, callers handle absence elsewhere"). Without (a) or (b) → yellow.

**Why this catches real bugs:** Symptom-suppression hides bugs without fixing them. The same code can fail in production for a different reason and now no one sees it. Forcing a justification or follow-up makes the cost-of-suppression visible.

**Score key:** Tier 2 has 4 checks total. Max contribution per PR = 4 × 1.0 = 4.0 points. Combined with Tier 1's max of 12.0 (6 checks × 2.0), the overall max weighted score is **16.0**.
