---
name: nemoclaw-pr-review
description: Pre-merge code review for NemoClaw PRs. Use when users say "review my changes", "PR review", "check before merge", or "ready for PR". Analyzes git diffs against NemoClaw architecture, security model, in-flight PR landscape, and codebase drift patterns.
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw PR Review

Perform a thorough code review for the NVIDIA/NemoClaw repository. Reviews are technically precise, architecturally aware, security-conscious, and always consider the broader PR landscape.

## When to Use

- Before opening a PR against NVIDIA/NemoClaw
- When asked to review changes on a NemoClaw branch
- When asked for a "PR review"

## Review Process

### Step 1: Gather Context

```bash
# What changed
git diff origin/main --stat
git diff origin/main

# Recent main history (to detect drift)
git log --oneline origin/main -30

# Commit messages on this branch
git log --oneline origin/main..HEAD
```

### Step 2: Check for Codebase Drift

**Critical first step.** Before reviewing the code itself, verify the PR is patching code that still exists and hasn't moved.

```bash
# For each file changed, check recent history
git log --oneline origin/main -20 -- <changed-file>

# Check if the code the PR modifies has been restructured
# Look for moves between: Dockerfile ↔ nemoclaw-start.sh ↔ bin/lib/onboard.js ↔ nemoclaw/src/
```

Derive drift patterns from recent history and current open PRs rather than old PR numbers. Check whether the touched code moved, was split, or has competing changes in another open PR.

Flag as 🔴 BLOCKER if the PR patches dead or moved code.

### Step 3: Check for Conflicting/Overlapping PRs

```bash
# List open PRs
gh pr list --repo NVIDIA/NemoClaw --state open --limit 30 --json number,title

# Check specific PRs that touch the same files
gh pr view <number> --repo NVIDIA/NemoClaw --json files,title,state
```

Always check:
- Does this PR **contradict** another open PR's approach?
- Does this PR **duplicate** work already in-flight?
- Is there a **merge order dependency** that needs coordination?
- Has a **more comprehensive version** of this fix already been proposed?

Flag overlaps explicitly with PR numbers and explain the conflict.

### Step 4: Security Review

See [references/security-review.md](references/security-review.md) for the detailed security checklist..
### Step 5: Implementation Quality

#### Caller/Callee Contract Verification

**When a PR changes how a function is called, follow the call chain and verify the callee actually handles what's being passed.** This includes intermediate wrappers — check that new options or argument types aren't silently dropped between the callsite and the final implementation. Read the callee source even when it's not in the diff.

Flag as 🔴 BLOCKER if there's a type or option mismatch anywhere in the chain.

#### Shell Scripts (nemoclaw-start.sh, brev-setup.sh)
- Use `execFileSync` not `execSync` for external commands (no shell interpretation)
- Use `mkdtempSync` for temp files, set mode 0o600
- Clean up temp files in both close and error handlers
- Don't suppress diagnostic output in CI (`>/dev/null 2>&1` hides failures)
- `set -euo pipefail` at the top
- Validate/sanitize all interpolated variables

#### Dockerfile
- Pin package versions (`gosu=1.17-1+b1`, not just `gosu`)
- No dead code (check if ACL/fallback lines actually execute)
- Don't build the same image twice in CI — cache or share via artifacts
- `hadolint` must pass

#### Python (inline in Dockerfile/start script)
- Read values from `os.environ`, never from string interpolation
- Simple boolean derivation preferred — `parsed.scheme == 'http'` (explicit allowlist) over `parsed.scheme != 'https'` (denylist that permits unknown schemes)

#### JavaScript/TypeScript (nemoclaw/src/, bin/)
- CJS in `bin/` (intentional, no build step needed)
- ESM + TypeScript in `nemoclaw/src/` (requires build)
- Co-locate tests as `*.test.ts` in plugin
- Root-level tests in `test/` use ESM imports

### Step 6: Test Coverage Assessment

Evaluate whether tests prove behavior or just prove intent:

- **Source pattern tests** (regex on file contents) prove the code looks right but not that it works
- **Behavioral tests** (mocked or real execution) prove actual behavior
- **E2E tests** (Brev instances) prove the full stack works

Decision framework for test depth:
- **Deterministic config/logic** (boolean derivation, set membership) → source pattern tests are sufficient
- **Shell interpretation, quoting, escaping** → must test actual execution (e2e)
- **Network/process behavior** → behavioral tests with mocks, or e2e

Flag tests that assert on implementation details rather than security properties:
> "If the implementation changes (e.g. `realpath` instead of `readlink`), these tests break even though the security property still holds."

### Step 6.5: E2E Advisor Verification

**Always check whether the E2E Advisor recommended tests, and whether those tests actually ran against the reviewed commit.** A PR review is incomplete if it says the test plan is sufficient while ignoring unrun advisor recommendations.

```bash
# Capture PR metadata and current head SHA
PR_NUMBER=<number>
gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw --json number,headRefName,headRefOid,comments,statusCheckRollup

# Inspect comments for E2E Advisor / CodeRabbit E2E recommendations
gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw --comments

# Check current PR checks
gh pr checks "$PR_NUMBER" --repo NVIDIA/NemoClaw

# Check recent dispatched E2E runs when advisor requested nightly/GPU/Brev validation
gh run list --repo NVIDIA/NemoClaw --workflow nightly-e2e.yaml --limit 20
gh run list --repo NVIDIA/NemoClaw --workflow e2e-brev.yaml --limit 20
```

Verification rules:
- Extract every E2E job/test recommended by the advisor, including nightly, GPU, Brev, and PR-CI E2E jobs.
- Confirm each recommended job either appears as a successful PR check or has a linked successful workflow run.
- Confirm the run tested the relevant PR branch/head SHA. If a workflow only runs against `main`, say that explicitly; do not treat it as pre-merge validation unless the PR commit was actually included.
- Do not trigger duplicate E2E for the same HEAD SHA if an equivalent successful run already exists.
- If recommendations are missing, ambiguous, or not yet posted, state that in the review instead of assuming no E2E is needed.

Severity guidance:
- 🔴 **BLOCKER**: advisor-recommended E2E is missing for runtime, security, networking, credentials, rebuild, snapshot, messaging, GPU, or install-flow changes where unit/PR-CI coverage cannot prove the behavior.
- 🟡 **WARNING**: advisor recommendation is missing for low-risk deterministic logic or docs-adjacent changes, or the run exists but is not clearly tied to the current HEAD SHA.
- ✅ **OK**: all advisor-recommended jobs passed against the reviewed commit, or the advisor made no E2E recommendation and the review independently agrees PR CI/unit tests are sufficient.

If E2E Advisor recommendations require dispatching or deeper validation, defer execution mechanics to `/skill:nemoclaw-pr-ci-loop` and the current workflow definitions.

### Step 7: Architectural Alignment Check

The NemoClaw CLI has had ongoing decomposition and type-safety work. Do **not** rely on frozen line counts, issue numbers, or module lists embedded in this skill. Recompute the current architectural baseline from the repo before reviewing:

```bash
# Current hotspots by size / exports / @ts-nocheck
find src nemoclaw/src -name '*.ts' -maxdepth 4 -print0 2>/dev/null | \
  xargs -0 wc -l | sort -nr | head -20
rg -n "@ts-nocheck|module\.exports|require\(" src nemoclaw/src 2>/dev/null
rg -n "run\(\s*['\"]|bash -c|shell:\s*true" src scripts nemoclaw/src 2>/dev/null

# Current decomposition/refactor context
gh issue list --repo NVIDIA/NemoClaw --state open --limit 100 \
  --search 'label:arch-improve OR label:refactor'
gh pr list --repo NVIDIA/NemoClaw --state open --limit 100 \
  --search 'label:refactor OR architecture OR extract OR type'
```

Treat large files, `@ts-nocheck`, CommonJS-style TypeScript, shell-string execution, duplicated helpers, and module-scoped mutable state as review signals only after verifying they still exist in the current tree.

#### Check each PR for these patterns

**🟢 Encourage (moves toward target architecture):**
- New code in **properly typed `.ts` files** with `import`/`export` (not `require`/`module.exports`)
- **Extracting functions from `onboard.ts`** into focused, testable modules
- **Converting `@ts-nocheck` files** to real TypeScript (even partially — removing `@ts-nocheck` from one function is progress)
- Using **`run([argv])` arrays** instead of `run("bash -c string")` shell strings (tracked in #1889)
- **Co-located tests** for extracted modules (`.test.ts` next to source)
- Creating **shared utility modules** that multiple consumers can import (e.g., `wait.ts`, `sandbox-session-state.ts`)
- **Reducing exports from `onboard.ts`** — moving consumers to import from the extracted module directly

**🟡 Flag (missed opportunity or neutral):**
- Adding new functions to `onboard.ts` instead of a focused module — suggest where it could live instead
- Adding new `require()` calls in files that could use `import` — note the inconsistency
- Adding another local wrapper where a current shared utility already exists — search before flagging and cite the actual utility
- Keeping ad-hoc sleeps/timeouts where a current readiness/wait helper exists — search before flagging and cite the actual helper
- New `@ts-nocheck` files — these should only be created by mechanical migration, never for new code

**🔴 Push back (moves away from target architecture):**
- Adding `@ts-nocheck` to an existing properly typed file
- New module-scoped mutable state in `onboard.ts` (the `NON_INTERACTIVE`, `RECREATE_SANDBOX` pattern is technical debt — new code should accept config as parameters)
- New shell-string `run("bash -c ...")` calls — this is a security regression tracked in #1889
- Growing `onboard.ts` exports — if a new function is only used by one external caller, it should live in a focused module, not be added to the 82-export God Object
- Duplicating functionality that already exists in a typed module (e.g., reimplementing openshell execution instead of using `src/lib/openshell.ts`)

#### In-flight refactoring PRs and issues

When reviewing, discover current active efforts at runtime. Check whether the PR overlaps, contradicts, or can reuse them:

```bash
gh pr list --repo NVIDIA/NemoClaw --state open --limit 100 \
  --json number,title,author,labels,files \
  --search 'refactor OR architecture OR extract OR type OR shell OR onboard'
gh issue list --repo NVIDIA/NemoClaw --state open --limit 100 \
  --json number,title,labels,updatedAt \
  --search 'label:arch-improve OR label:refactor OR onboard OR shell OR type'
```

Only cite PRs/issues/modules you just verified are still relevant.

#### How to phrase architectural feedback

Use constructive suggestions, not demands. Examples:

> 🟡 **Architectural note:** This adds a new function to `<large-file>` (currently `<N>` lines on this branch vs `<M>` on `origin/main`). Consider placing it in a focused module if a suitable current module exists, or extracting a new one. Not a blocker, but it helps the decomposition effort.
>
> 🟡 **Type safety opportunity:** This file uses `require()` / `module.exports` — if you're already editing it, consider converting to `import`/`export` and removing `@ts-nocheck`. Even converting just the functions you're touching is valuable progress.
>
> 🔴 **Shell injection regression:** This introduces a new `run("bash -c ...")` call. Use `run(["docker", "rm", name])` argv form instead — see #1889 for context. The polymorphic `run()` in `runner.ts` accepts both, so this is a drop-in change.

### Step 8: Monolith Growth Guard

**Every PR must be checked for net growth of known monolith files.** The decomposition effort is undermined when refactoring PRs add type annotations, helper imports, or new logic to the files we're trying to shrink.

#### Monolith files and current baselines

Compute baselines dynamically from files touched by the PR and the largest current files in `src/` / `nemoclaw/src/`. Do not maintain hardcoded line counts here.

```bash
# Compare touched large files against main
for f in $(git diff --name-only origin/main...HEAD | grep -E '^(src|nemoclaw/src)/.*\.ts$'); do
  base=$(git show "origin/main:$f" 2>/dev/null | wc -l | tr -d ' ' || echo 0)
  head=$(wc -l < "$f" | tr -d ' ')
  printf '%s %s -> %s (%+d)\n' "$f" "$base" "$head" "$((head-base))"
done

# Identify current hotspots if no obvious monolith was touched
find src nemoclaw/src -name '*.ts' -print0 2>/dev/null | xargs -0 wc -l | sort -nr | head -20
```

#### Decision framework

**Net-negative or net-zero** → ✅ Good — PR moves in the right direction or is neutral.

**Net-positive (+1 to +20 lines)** → 🟡 Flag as warning. Acceptable if:
- Adding essential type annotations (e.g., `@ts-nocheck` removal effort)
- Adding a required feature with no feasible extraction target
- The PR *also* extracts code elsewhere to offset the growth

**Net-positive (+20 lines or more)** → 🔴 Push back. Require the author to:
- Extract the new logic into a focused module instead of adding to the monolith
- Or offset the growth by extracting existing code in the same PR
- Reference issue #2306 (onboard decomposition) for extraction targets

#### How to phrase the feedback

For warnings:
> 🟡 **Monolith growth:** This PR adds ~N net lines to `<large-file>` (`<base>` → `<head>`). The new `<function>` logic may fit better in `<current-focused-module>` or a new focused module. Not blocking if required for this fix, but please consider extracting it.

For blockers:
> 🔴 **Monolith growth:** This PR adds ~N net lines to `<large-file>` (`<base>` → `<head>`). The new helpers are imported but the old inline code they replace isn't removed. Please make this net-neutral by extracting the replaced code or moving the new logic to a focused module.

### Step 9: Cross-Cutting Concerns

Always check:
- **Backward compatibility** — does this break existing deployments? Is there an opt-out?
- **Onboarding experience** — does this break the first-run `nemoclaw onboard` flow? Check whether `bin/lib/onboard.js` (`patchStagedDockerfile`) and `scripts/brev-setup.sh`/`setup.sh` pass any new build args or env vars introduced by the PR. Default flips (e.g. secure-by-default) are especially dangerous here since onboard assumes immediate dashboard access without pairing.
- **Unconditional changes** — features should be conditional, not forced on all users
- **Documentation alignment** — if behavior changes, do docs/tests/error messages all agree?
- **CI impact** — does this add duplicate builds? Can layers be cached/shared?
- **Commit hygiene** — conventional commit types (`fix`, `feat`, `docs`, `ci`, `refactor`, `test`, `chore`, `perf`)

---

## Output Format

Lead with the architectural/drift assessment, then specifics:

```markdown
## PR Review: <branch-name>

**Files Changed:** N
**Lines:** +X / -Y

### Architectural Assessment

[Is this PR patching the right code? Has the codebase drifted? Are there
conflicting PRs? State this first — it can invalidate everything below.]

### Architectural Alignment

[Does this PR move toward or away from the target architecture?
Check: type safety, module boundaries, shell execution patterns,
onboard.ts decomposition, shared utility reuse. Reference Step 7.]

### Monolith Impact

[Does this PR grow or shrink the monolith files?
Show: `onboard.ts` before → after (net +/-), `nemoclaw.ts` before → after.
Flag if net-positive. Reference Step 8.]

### E2E Advisor Status

[State whether E2E Advisor / CodeRabbit recommended E2E jobs. List each recommended job and whether it passed against the reviewed PR HEAD SHA. If no recommendation was found, say so and give your independent test-depth assessment.]

### 🔴 Blockers (must fix before merge)

1. **file:line** — Description
   - Why it matters
   - Suggested fix

### 🟡 Warnings (should fix)

1. **file:line** — Description

### 🔵 Suggestions (nice to have)

1. **file:line** — Description

### ✅ What's Good

[Give explicit credit when the approach is sound.]

### Recommendation

[One of: "Merge as-is", "Merge after fixing blockers",
"Needs rework — <reason>", "Superseded by #NNN"]
```

---

## Review Style Guide

Key patterns for effective NemoClaw reviews:

### Tone
- Direct and precise — no hedging when something is wrong
- Constructive — always provides the fix, not just the problem
- Credits good work explicitly ("Nice catch!", "The tests are good")
- Uses "I think" / "I'd prefer" for subjective calls vs. definitive language for objective issues

### Structure
- Opens with the **highest-impact finding** (often architectural, not line-level)
- Uses ### headers to separate distinct concerns
- Provides concrete code suggestions in ```suggestion blocks
- References other PRs by number constantly — maintains the full PR graph in context
- Explains the **"why"** behind every objection (not just "this is wrong" but "this fails because X changed in Y")

### Common Issues to Catch
1. **Stale-against-main** — the PR patches code that moved or was restructured
2. **PR conflicts** — two PRs take opposite positions on the same setting
3. **Security claim overstatement** — labeling a spoofable check as a security boundary
4. **Fail-open vs fail-closed** — missing files/configs should block, not bypass
5. **Denylist vs allowlist** — `!= 'https'` permits unknown schemes; `== 'http'` is safer
6. **Dead code** — ACL commands that can't run because the package isn't installed
7. **Suppressed errors** — `>/dev/null 2>&1` hiding build failures in CI
8. **Duplicate CI work** — building the same Docker image twice per PR
9. **Hardcoded lists vs dynamic scans** — fixed symlink name lists that miss future additions
10. **Caller/callee contract mismatches** — changing callsites without verifying the callee (and any intermediate wrappers) actually handles what's being passed
11. **Unrun E2E Advisor recommendations** — CodeRabbit/E2E Advisor requested validation jobs, but the review does not confirm they passed against the reviewed HEAD SHA
12. **Workflow trusted-code boundary violations** — `pull_request`/`pull_request_target` job checks out the PR ref and executes scripts from it while secrets or write tokens are in scope
13. **Unpinned installs in secret-bearing CI jobs** — `npm install -g pkg` / `pip install pkg` / `curl | sh` without a version pin, or third-party actions referenced by floating tag instead of commit SHA
14. **Script injection via `${{ github.event.* }}`** — PR title, branch name, or diff content interpolated directly into a `run:` shell block instead of passed through an env var

### Low-Friction Approvals
- Clean, scoped security fixes with tests
- Documentation improvements
- CI/tooling consolidation
- Targeted SSRF/policy hardening with test coverage
- Well-structured refactors that don't change behavior
