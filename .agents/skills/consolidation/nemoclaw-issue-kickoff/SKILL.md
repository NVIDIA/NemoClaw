---
name: nemoclaw-issue-kickoff
description: Pick up a NemoClaw GitHub issue, create a git worktree, research the codebase, and produce a phased development plan with test-depth classification. Use when user says "pick up issue", "kickoff issue", "start issue", "new issue", or provides an issue number to begin working on. Creates a worktree in NemoClaw-working, deeply researches the relevant code, and outputs an implementation plan.
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw Issue Kickoff

Pick up a NemoClaw GitHub issue, create a fresh git worktree, research the codebase in depth, and produce a phased development plan with test-depth classification for each phase.

## When to Use

- When starting work on a new NemoClaw issue or bug
- When user says "pick up issue #NNNN", "kickoff #NNNN", or "start issue #NNNN"
- When user wants a development plan before writing code

## Input

The user provides an issue number (e.g., `2342`, `#2342`, or `issue 2342`). Extract the numeric issue number.

If the user also provides a branch name, use it. Otherwise, derive one from the issue title (see Step 2).

## Workflow

### Step 1: Fetch the issue and validate

Use any existing NemoClaw worktree under the working directory to run `gh` commands.

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
EXISTING_WORKTREE=$(ls -d "${WORKTREE_BASE}"/*/ 2>/dev/null | head -1)
if [ -z "$EXISTING_WORKTREE" ]; then
  echo "No existing NemoClaw worktree found under $WORKTREE_BASE; set NEMOCLAW_WORKTREE_BASE or clone/create a worktree first" >&2
  exit 1
fi
cd "$EXISTING_WORKTREE"

gh issue view <ISSUE_NUMBER> --repo NVIDIA/NemoClaw
```

If the issue is closed, inform the user and ask whether to proceed anyway.

Capture:
- Title, labels, body, assignees
- Related issues mentioned in the body (search for `#NNNN` references)

### Step 2: Create a fresh git worktree and configure identity

Worktrees for issues use the naming pattern `issue-<number>` (not `pr-<number>`).

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
ISSUE_NUMBER=<number>
WORKTREE_PATH="${WORKTREE_BASE}/issue-${ISSUE_NUMBER}"

cd "$EXISTING_WORKTREE"

# Prune stale worktrees first
git worktree prune

# Check if worktree already exists
if [ -d "$WORKTREE_PATH" ]; then
  echo "Worktree already exists at $WORKTREE_PATH — reusing it"
  cd "$WORKTREE_PATH"
else
  # Fetch latest and create worktree from main
  git fetch origin main
  git worktree add "$WORKTREE_PATH" origin/main --detach
  cd "$WORKTREE_PATH"
fi

# Create a feature branch — derive from issue title if not provided
# Pattern: issue-<number>-<slugified-title> (max ~60 chars)
git checkout -b <BRANCH_NAME>

# Configure git identity (worktrees may not inherit local config)
MAIN_REPO="${NEMOCLAW_REPO}"
git config user.name  "$(git -C "$MAIN_REPO" config user.name)"
git config user.email "$(git -C "$MAIN_REPO" config user.email)"
git config user.signingkey "$(git -C "$MAIN_REPO" config user.signingkey)"
git config user.gpgsign "$(git -C "$MAIN_REPO" config commit.gpgsign)"
git config gpg.format "$(git -C "$MAIN_REPO" config gpg.format)"
```

### Step 3: Research the codebase

This is the most important step. The goal is to deeply understand the problem space before proposing any fixes.

#### 3a: Identify affected areas from the issue

Parse the issue body for:
- Error messages, log output, symptoms described
- File paths, function names, or CLI commands mentioned
- Environment details (platform, Brev, macOS, Linux, GPU/CPU)
- Reproduction steps

#### 3b: Search for related code

Use targeted searches across the worktree. Cast a wide net first, then narrow:

```bash
cd "$WORKTREE_PATH"

# Search for keywords from the issue (error messages, feature names, etc.)
grep -rn "<keyword>" --include="*.ts" --include="*.sh" --include="*.js" src/ scripts/ test/ | head -30

# Find files related to the affected area
find . -type f \( -name "*.ts" -o -name "*.sh" \) | xargs grep -li "<keyword>" | head -20

# Check for existing tests in the area
find . -type f -name "*.test.*" | xargs grep -li "<keyword>" | head -10
```

#### 3c: Read the key source files

Read each file identified above. For large files like `onboard.ts`, use targeted `grep -n` to find relevant line ranges, then read those sections.

Understand:
- **Data flow**: How does data move through the affected code path?
- **Entry points**: What triggers the buggy behavior? (CLI command, onboard step, shell script)
- **Dependencies**: What other modules/files does the affected code depend on?
- **Existing tests**: What test coverage already exists for this area?

#### 3d: Search for related issues and PRs

```bash
cd "$WORKTREE_PATH"

# Search for related issues
gh issue list --repo NVIDIA/NemoClaw --search "<relevant keywords>" --state all --limit 10

# Check for related open PRs that might conflict
gh pr list --repo NVIDIA/NemoClaw --search "<relevant keywords>" --state open --limit 10
```

Read the bodies of closely related issues to gather additional context, past attempts, and known workarounds.

### Step 4: Classify root causes

After the research, identify and document each distinct root cause. For each root cause:

1. **Name it** — a short label (e.g., "Missing port forward on Brev Launchable")
2. **Explain it** — what's happening and why
3. **Locate it** — which files and line ranges are involved
4. **Relate it** — how it connects to the symptoms described in the issue

There may be a single root cause or multiple contributing factors. Document all of them.

### Step 5: Refactoring alignment

Lightweight survey of the active refactoring agenda to find opportunities where this issue's implementation can advance architectural goals — or avoid adding debt to modules slated for decomposition.

#### 5a: Fetch the refactoring landscape

Query GitHub for in-flight refactoring work:

```bash
cd "$WORKTREE_PATH"

# Architectural improvement proposals (team-filed design issues)
gh issue list --repo NVIDIA/NemoClaw --label "arch-improve" --state open --limit 15

# Refactoring work items
gh issue list --repo NVIDIA/NemoClaw --label "refactor" --state open --limit 15

# Open refactor-tagged PRs
gh pr list --repo NVIDIA/NemoClaw --label "refactor" --state open --limit 10

# Recent refactor/arch PRs from core contributors
for author in ${GH_USER} <maintainer> <maintainer> <maintainer>; do
  gh pr list --repo NVIDIA/NemoClaw --author "$author" --state open --limit 5 \
    --json number,title --jq ".[] | \"#\(.number)\t${author}\t\(.title)\""
done
```

Read the body of each `arch-improve` issue — these describe proposed patterns and target modules that are the primary alignment targets.

> **Note:** Core team handles are currently `${GH_USER}`, core maintainers. Update as team composition changes.

#### 5b: Cross-reference with fix areas

For each root cause / fix area from Step 4, check for five types of intersection with the refactoring landscape:

1. **File overlap with open refactor PRs** — use `gh pr diff <NUMBER> --repo NVIDIA/NemoClaw --name-only` to check whether this issue touches files an open refactor PR also changes. Signals merge-order opportunities ("land first so they can adopt it") or conflict risks ("coordinate before changing this file").

2. **Pattern seeding** — does the fix introduce logic that an `arch-improve` issue proposes as a new pattern? If so, structure the code to match the proposed design: use the proposed interface signature, place it in the proposed module, and add `// TODO(#NNNN): migrate to <pattern>` comments.

3. **Debt avoidance** — does the fix add code to a module that a refactor issue wants to decompose or split? If so, structure the addition to be easily extractable (standalone function, minimal coupling to the host module's internals) rather than deepening the monolith.

4. **Shared infrastructure** — does the fix create test helpers, utility functions, or type definitions that other in-flight refactoring work could reuse? Place them in a shared importable location rather than inlining.

5. **Structured output** — does the fix touch CLI output paths? Return data structures that the CLI layer formats, rather than embedding ANSI codes or formatting in business logic.

#### 5c: Produce alignment findings

For each intersection found, produce a concrete recommendation:
- The specific refactoring issue or PR number
- What the overlap is (file, pattern, or infrastructure)
- The specific action: "structure X as Y for #NNNN", "land before PR #NNNN so they can adopt it", "add TODO(#NNNN) at Z"

If no refactoring goals intersect with this issue's changes, state that explicitly — "No active refactoring goals intersect with this issue's changes." Not every issue has alignment, and that's fine. Keep this step proportional — it's a survey, not deep research.

### Step 6: Produce the development plan

The development plan has four sections: **Root Causes**, **Fix Areas with Test Depth**, **Refactoring Alignment** (from Step 5), and **Phased Implementation**.

#### 6a: Fix Areas & Test Depth Classification

For each fix area, classify its test depth using the framework below. A fix area may span multiple categories — use the **deepest required level**.

**Level 1: Unit tests only 🟢**

The fix **only** touches:
- Pure logic / config transforms — boolean derivation, enum mapping, string formatting
- Type-only changes — interface definitions, type narrowing
- Documentation — markdown, comments, JSDoc
- Deterministic utilities — pure functions with no I/O
- Test-only changes — adding/fixing tests without changing source

**Confidence signals for unit-only:**
- All changed functions are pure (input → output, no side effects)
- No `execSync`, `execFileSync`, `spawnSync`, `run()`, or `docker` calls added/modified
- No network policy files touched
- No Dockerfile changes
- No `nemoclaw-start.sh` or entrypoint changes
- No sandbox lifecycle operations (create, destroy, rebuild, connect)

**Level 2: Unit tests + behavioral mocks 🟡**

The fix touches:
- CLI argument parsing — new flags, changed option handling
- Session state management — `onboard-session.ts`, step transitions
- Credential handling — rotation, propagation, validation (not Docker/K8s layer)
- HTTP probing — inference health checks, endpoint validation (mockable)
- Configuration file generation — `openclaw.json` assembly, policy merging

**Level 3: E2E tests required 🔴**

The fix touches **any** of:

| Category | Why E2E is needed |
|----------|-------------------|
| Dockerfile / build-time changes | Build context, layer ordering, permissions need real container |
| Shell scripts / entrypoint | Shell quoting, variable expansion, process lifecycle need real execution |
| Network policies | Egress rules, SSRF filters, proxy routing need real network stack |
| Sandbox operations | Create, destroy, rebuild, snapshot, connect involve Docker + K8s |
| Gateway interaction | Provider creation, inference routing, TLS, port binding |
| Landlock / security policies | Filesystem restrictions only testable under real enforcement |
| Process execution patterns | `run()` calls, `execFileSync`, `spawnSync` with real binaries |
| Onboard flow end-to-end | Multi-step wizard with real Docker, provider setup, inference |
| Rebuild / upgrade path | Config migration, policy survival, version transitions |

**Confidence signals for E2E needed:**
- Changes touch `Dockerfile` or `nemoclaw-start.sh`
- New `run()` / `execFileSync` / `spawnSync` calls targeting `docker` or `openshell`
- Network policy YAML files added or modified
- Fix involves "sandbox", "gateway", "rebuild", or "container" operations

#### 6b: Phased Implementation

Break the work into phases ordered by:
1. **Quick wins first** — locally testable changes that unblock further work
2. **Core fix next** — the change that directly addresses the primary symptom
3. **Resilience** — hardening and edge case coverage
4. **Integration verification** — E2E confidence on real infrastructure

Each phase should include:
- **Goal** — one sentence
- **What to change** — specific files and what changes
- **Test strategy** — what tests to write and at what level
- **Dependencies** — can this phase run in parallel or does it depend on a prior phase?

## Output Format

Present the development plan in this structure:

```markdown
# Issue #<number> — Development Plan
## <Issue title>

### Diagnosis
<2-3 sentence summary of what's happening and why>

### Root Causes
#### RC-1: <name>
<explanation, files involved, connection to symptoms>

#### RC-2: <name> (if applicable)
...

### Fix Areas & Test Depth Classification

| # | Area | Change | Test Level | Rationale |
|---|------|--------|-----------|-----------|
| 1 | ... | ... | 🟢/🟡/🔴 | ... |

### Refactoring Alignment

| # | Refactoring Goal | Overlap | Recommendation |
|---|-----------------|---------|----------------|
| 1 | #NNNN — <title> | <file / pattern / infrastructure> | <specific action> |

_Or: "No active refactoring goals intersect with this issue's changes."_

### Implementation Plan

#### Phase 1: <name> (<test level>)
**Goal:** ...
- What to change
- Tests to write
- Dependencies
- **Refactoring notes** — <alignment actions for this phase, or omit if none>

#### Phase 2: <name> (<test level>)
...

### Recommended Order
<which phases can be parallel, which are sequential>

### Verdict: <overall test depth>
<summary table of phases vs test levels>
```

## Notes

- The worktree base path is always `${NEMOCLAW_WORKTREE_BASE}`
- Worktrees are named `issue-<number>` (e.g., `issue-2342`)
- If a worktree already exists, reuse it (do not recreate)
- Always `git worktree prune` before creating new worktrees
- Branch names follow the pattern `issue-<number>-<slug>` (e.g., `issue-2342-brev-gateway-dashboard-offline`)
- The main repo for git config is at `${NEMOCLAW_REPO}`
- Read `CONTRIBUTING.md`, `src/lib/README.md`, and nearby package README files if you need architecture context during research
- For bugs: prioritize understanding the **data flow** that leads to the symptom before proposing fixes
- For features: prioritize understanding **existing patterns** in the codebase before designing new ones
- Always check for related open issues and PRs to avoid duplicate work or conflicts
