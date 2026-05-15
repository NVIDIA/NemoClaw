---
name: nemoclaw-pr-triage
description: Checkout a NemoClaw PR into a fresh git worktree and review it to determine if it needs E2E tests or if unit tests are sufficient. Use when user says "triage PR", "check PR", "does this PR need e2e", "review PR testing", or provides a PR number to evaluate. Creates a worktree in NemoClaw-working, runs a full code review, and produces a test-depth recommendation.
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---


<!-- markdownlint-disable MD022 MD026 MD031 MD032 MD036 MD040 MD058 -->

# NemoClaw PR Triage

Checkout a NemoClaw PR into a fresh git worktree, run a full code review, and determine whether the PR requires E2E tests or if unit tests are sufficient.

## When to Use

- When a new PR is opened and you need to decide on test strategy
- When user says "triage PR #NNNN" or "does PR #NNNN need e2e?"
- When evaluating a batch of open PRs for test requirements

## Input

The user provides a PR number (e.g., `2027`, `#2027`, or `PR 2027`). Extract the numeric PR number.

## Workflow

### Step 1: Validate the PR exists and is open

Use any existing NemoClaw worktree under the working directory to run `gh` commands.

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
# Find any existing worktree to use as a git context
EXISTING_WORKTREE=$(ls -d "${WORKTREE_BASE}"/*/ 2>/dev/null | head -1)
cd "$EXISTING_WORKTREE"

gh pr view <PR_NUMBER> --json number,title,state,author,headRefName,body,files \
  --jq '{number,title,state,author: .author.login,headRefName,files: [.files[].path]}'
```

If the PR is already merged or closed, inform the user and stop.

### Step 2: Create a fresh git worktree and configure identity

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
PR_NUMBER=<number>
WORKTREE_PATH="${WORKTREE_BASE}/pr-${PR_NUMBER}"

cd "$EXISTING_WORKTREE"

# Prune stale worktrees first
git worktree prune

# Check if worktree already exists
if [ -d "$WORKTREE_PATH" ]; then
  echo "Worktree already exists at $WORKTREE_PATH — reusing it"
  cd "$WORKTREE_PATH"
  gh pr checkout "$PR_NUMBER"
else
  # Fetch latest and create worktree from main, then checkout the PR
  git fetch origin main
  git worktree add "$WORKTREE_PATH" origin/main --detach
  cd "$WORKTREE_PATH"
  gh pr checkout "$PR_NUMBER"
fi

# Configure git identity — worktrees may not inherit local config from the
# main repo, which causes commits to use test@example.com and fail
# copy-pr-bot verification.
MAIN_REPO="${NEMOCLAW_REPO}"
git config user.name  "$(git -C "$MAIN_REPO" config user.name)"
git config user.email "$(git -C "$MAIN_REPO" config user.email)"
git config user.signingkey "$(git -C "$MAIN_REPO" config user.signingkey)"
git config commit.gpgsign "$(git -C "$MAIN_REPO" config commit.gpgsign)"
git config gpg.format "$(git -C "$MAIN_REPO" config gpg.format)"
```

### Step 3: Ensure PR is assigned to me

```bash
cd "$WORKTREE_PATH"

# Check if I'm already assigned
ASSIGNED=$(gh pr view "$PR_NUMBER" --repo NVIDIA/NemoClaw --json assignees --jq '.assignees[].login' 2>/dev/null)
MY_LOGIN=$(gh api user --jq '.login' 2>/dev/null)

if echo "$ASSIGNED" | grep -qx "$MY_LOGIN"; then
  echo "Already assigned to @${MY_LOGIN}"
else
  gh pr edit "$PR_NUMBER" --repo NVIDIA/NemoClaw --add-assignee @me
  echo "Assigned @${MY_LOGIN} to PR #${PR_NUMBER}"
fi
```

### Step 4: Run the PR review

Now load and execute `/skill:nemoclaw-pr-review` against the checked-out worktree at `$WORKTREE_PATH`. Follow its full review process (Steps 1–8).

### Step 5: Test depth recommendation

After completing the review, produce a **Test Depth Recommendation** section. This is the primary output of this skill. Use the decision framework below.

## Test Depth Decision Framework

Evaluate the PR's changes against these categories. A PR may span multiple categories — use the **deepest required level**.

### Level 1: Unit tests only ✅

The PR **only** touches:
- **Pure logic / config transforms** — boolean derivation, enum mapping, string formatting, set membership
- **Type-only changes** — interface definitions, type narrowing, `@ts-nocheck` removal with no behavior change
- **Documentation** — markdown, comments, JSDoc, README updates
- **Deterministic utilities** — pure functions with no I/O (e.g., `sleepSeconds`, `stripCredentials`, `parseConfig`)
- **Test-only changes** — adding/fixing tests without changing source
- **Linting / formatting** — eslint config, prettier, whitespace

**Confidence signals for unit-only:**
- All changed functions are pure (input → output, no side effects)
- No `execSync`, `execFileSync`, `spawnSync`, `run()`, or `docker` calls added/modified
- No network policy files touched
- No Dockerfile changes
- No `nemoclaw-start.sh` or entrypoint changes
- No sandbox lifecycle operations (create, destroy, rebuild, connect)

### Level 2: Unit tests + behavioral mocks 🟡

The PR touches:
- **CLI argument parsing** — new flags, changed option handling
- **Session state management** — `onboard-session.ts`, step transitions, resume logic
- **Credential handling** — rotation, propagation, validation (but not the actual Docker/K8s layer)
- **HTTP probing** — inference health checks, endpoint validation (mockable with nock/msw)
- **Configuration file generation** — `openclaw.json` assembly, policy merging

**These can be tested with mocked I/O** — no real containers needed.

### Level 3: E2E tests required 🔴

The PR touches **any** of these — unit tests are NOT sufficient:

| Category | Why E2E is needed | Examples |
|----------|-------------------|----------|
| **Dockerfile / build-time changes** | Build context, layer ordering, permissions only verifiable in real container | `Dockerfile`, `sandbox-build-context.ts`, image build args |
| **Shell scripts / entrypoint** | Shell quoting, variable expansion, process lifecycle need real execution | `nemoclaw-start.sh`, `brev-setup.sh`, `install.sh` |
| **Network policies** | Egress rules, SSRF filters, proxy routing need real network stack | `policies/*.yaml`, `policies/presets/*.yaml`, `ssrf.ts` firewall rules |
| **Sandbox operations** | Create, destroy, rebuild, snapshot, connect involve Docker + K8s | `openshell` command wrappers, sandbox lifecycle code |
| **Gateway interaction** | Provider creation, inference routing, TLS, port binding | Gateway setup, `openshell gateway/provider/inference` paths |
| **Landlock / security policies** | Filesystem restrictions only testable under real Landlock enforcement | Landlock profiles, `capsh` usage, `chattr` immutability |
| **Process execution patterns** | `run()` calls, `execFileSync`, `spawnSync` with real binaries | New or modified subprocess calls, especially shell-string `run("bash -c ...")` |
| **Onboard flow end-to-end** | Multi-step wizard with real Docker, provider setup, inference verification | Changes to `onboard.ts` that affect the install → configure → verify pipeline |
| **Rebuild / upgrade path** | Config migration, policy survival, version transitions | `nemoclaw rebuild`, migration-state logic that reads real sandbox state |

**Confidence signals for E2E needed:**
- PR modifies files under `test/e2e/` (it's already in E2E territory)
- Changes touch `Dockerfile` or `nemoclaw-start.sh`
- New `run()` / `execFileSync` / `spawnSync` calls targeting `docker` or `openshell`
- Network policy YAML files added or modified
- The PR description mentions "sandbox", "gateway", "rebuild", or "container"

## Output Format

After completing the nemoclaw-pr-review output, append:

```markdown
---

## Test Depth Recommendation

**PR:** #<number> — <title>
**Author:** @<login>

### Classification

| Changed Area | Test Level | Rationale |
|-------------|-----------|-----------|
| <area 1> | 🟢 Unit / 🟡 Mock / 🔴 E2E | <why> |
| <area 2> | ... | ... |

### Verdict: <Unit Tests Sufficient ✅ | E2E Tests Required 🔴 | Behavioral Mocks Recommended 🟡>

<1-2 sentence summary explaining the recommendation>

### Suggested Test Approach

<Specific guidance on what to test and how — which test files, what assertions, whether to use existing E2E scripts or write new ones>
```

## Notes

- The worktree base path is always `${NEMOCLAW_WORKTREE_BASE}`
- Worktrees are named `pr-<number>` (e.g., `pr-2027`)
- If a worktree for this PR already exists, reuse it and just checkout the latest
- Always `git worktree prune` before creating new worktrees to clean up stale references
- Read the current `nemoclaw-pr-review` skill before executing Step 4; resolve it from `.agents/skills/nemoclaw-pr-review/SKILL.md` rather than a user-specific path
