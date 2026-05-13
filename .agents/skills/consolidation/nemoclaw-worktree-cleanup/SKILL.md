---
name: nemoclaw-worktree-cleanup
description: Clean up stale NemoClaw git worktrees whose issues or PRs have been closed or merged. Scans worktree directories in NemoClaw-working, checks GitHub status, and recommends deletions. Use when user says "clean up worktrees", "prune worktrees", "clean up NemoClaw-working", "remove old worktrees", or "worktree cleanup".
author: Julie Yaunches
author_email: jyaunches@nvidia.com

---

# NemoClaw Worktree Cleanup

Scan the NemoClaw-working directory for git worktrees tied to issues or PRs that have been closed/merged on GitHub, then recommend and (on confirmation) delete them.

## When to Use

- When the user wants to clean up old/stale worktrees
- When NemoClaw-working has accumulated many directories
- When user says "clean up worktrees", "prune worktrees", or similar

## Constants

```
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
REPO="NVIDIA/NemoClaw"
```

## Workflow

### Step 1: Discover worktrees

List all directories in `WORKTREE_BASE` that match the patterns `issue-*` or `pr-*`. Extract the type (issue or pr) and number from each directory name.

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"
ls -d "${WORKTREE_BASE}"/issue-* "${WORKTREE_BASE}"/pr-* 2>/dev/null
```

### Step 2: Check GitHub status for each

Use an existing worktree to run `gh` commands. For each discovered worktree:

**For issue worktrees (`issue-NNNN`):**
```bash
gh issue view <NUMBER> --repo NVIDIA/NemoClaw --json state,title --jq '.state + " | " + .title'
```

**For PR worktrees (`pr-NNNN`):**
```bash
gh pr view <NUMBER> --repo NVIDIA/NemoClaw --json state,title --jq '.state + " | " + .title'
```

Classify each worktree:
- **Stale** — issue is `CLOSED` or PR is `MERGED` or `CLOSED`
- **Active** — issue is `OPEN` or PR is `OPEN`

### Step 3: Present findings

Display results in a clear table showing all worktrees, their GitHub status, and which ones are candidates for deletion.

Example format:

```
## Worktree Status

| Directory     | Type  | #    | Title                          | GitHub Status | Action      |
|---------------|-------|------|--------------------------------|---------------|-------------|
| issue-2273    | Issue | 2273 | Rebuild is not atomic...       | CLOSED        | 🗑 Delete   |
| pr-1478       | PR    | 1478 | Example merged PR title... | MERGED        | 🗑 Delete   |
| issue-2390    | Issue | 2390 | Typed command registry...      | OPEN          | ✅ Keep     |
```

List out specifically which worktrees will be deleted, and ask the user to confirm.

### Step 4: Delete confirmed worktrees

On user confirmation, for each stale worktree:

```bash
WORKTREE_BASE="${NEMOCLAW_WORKTREE_BASE}"

# Remove the git worktree registration first
cd "${WORKTREE_BASE}/issue-2273"  # any existing worktree to run git from
git worktree remove --force "${WORKTREE_BASE}/<worktree-dir>"
```

After all removals, prune any remaining stale worktree references:

```bash
git worktree prune
```

Report what was deleted and confirm the cleanup is complete.

## Notes

- Always check GitHub status **before** recommending deletion — never assume based on age alone
- If `gh` commands fail for a worktree (e.g., issue/PR not found), flag it as `⚠️ Unknown` and do NOT recommend deletion
- If a worktree directory doesn't match `issue-*` or `pr-*` patterns, skip it (e.g., `.agent-local/`)
- The user must explicitly confirm before any deletion happens
- Use `git worktree remove --force` to handle worktrees with uncommitted changes — but warn the user if uncommitted changes are detected before deleting
