#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Weekly upstream sync — merges NVIDIA/NemoClaw main into this fork via a
# dated integration branch, validates the result, then opens a PR.
#
# Usage:
#   scripts/sync-upstream.sh              # full run: merge, test, open PR
#   scripts/sync-upstream.sh --dry-run    # stop after merge, skip push/PR
#   scripts/sync-upstream.sh --cleanup    # delete merged integration/* branches older than 30 days

set -euo pipefail

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/NVIDIA/NemoClaw.git"
UPSTREAM_BRANCH="main"
DATE="$(date +%Y-%m-%d)"
BRANCH="integration/upstream-sync-${DATE}"

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info() { printf "${CYAN}[INFO]${NC}  %s\n" "$*"; }
ok() { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
warn() { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
err() { printf "${RED}[ERR]${NC}   %s\n" "$*" >&2; }
die() {
  err "$@"
  exit 1
}

# ── Flags ────────────────────────────────────────────────────────────────────
DRY_RUN=false
CLEANUP=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --cleanup) CLEANUP=true ;;
    --help | -h)
      echo "Usage: $0 [--dry-run] [--cleanup]"
      echo "  --dry-run   Merge and test but do not push or open a PR"
      echo "  --cleanup   Delete merged integration/* branches older than 30 days"
      exit 0
      ;;
    *) die "Unknown flag: $arg" ;;
  esac
done

# ── Cleanup mode ─────────────────────────────────────────────────────────────
if $CLEANUP; then
  info "Cleaning up merged integration branches older than 30 days..."
  cutoff=$(date -d "30 days ago" +%s 2>/dev/null || date -v-30d +%s 2>/dev/null || echo 0)
  deleted=0
  for ref in $(git for-each-ref --format='%(refname:short)' refs/heads/integration/upstream-sync-*); do
    branch_date="${ref##*sync-}"
    branch_ts=$(date -d "$branch_date" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$branch_date" +%s 2>/dev/null || echo 0)
    if [[ "$branch_ts" -gt 0 && "$branch_ts" -lt "$cutoff" ]]; then
      # Only delete if already merged into main
      if git merge-base --is-ancestor "$ref" main 2>/dev/null; then
        info "Deleting local branch: $ref"
        git branch -d "$ref"
        # Try to delete remote branch too
        if git push origin --delete "${ref}" 2>/dev/null; then
          ok "Deleted remote branch: origin/$ref"
        fi
        deleted=$((deleted + 1))
      fi
    fi
  done
  ok "Cleaned up $deleted branch(es)."
  exit 0
fi

# ── Pre-flight checks ───────────────────────────────────────────────────────
info "Running pre-flight checks..."

# Must be in a git repo
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Not inside a git repository."

# Change to repo root
cd "$(git rev-parse --show-toplevel)"

# Working tree must be clean
if [[ -n "$(git status --porcelain)" ]]; then
  die "Working tree is dirty. Commit or stash changes before syncing."
fi

# Must be on main
current_branch="$(git symbolic-ref --short HEAD)"
if [[ "$current_branch" != "main" ]]; then
  die "Must be on 'main' branch (currently on '$current_branch'). Run: git checkout main"
fi

# Ensure upstream remote exists
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  info "Adding upstream remote: $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
  git config "remote.${UPSTREAM_REMOTE}.fetch" "+refs/heads/main:refs/remotes/${UPSTREAM_REMOTE}/main"
fi

# Check gh CLI (only needed for non-dry-run)
if ! $DRY_RUN; then
  if ! command -v gh >/dev/null 2>&1; then
    die "GitHub CLI (gh) is required for PR creation. Install: https://cli.github.com"
  fi
  if ! gh auth status >/dev/null 2>&1; then
    die "GitHub CLI is not authenticated. Run: gh auth login"
  fi
fi

ok "Pre-flight checks passed."

# ── Fetch upstream ───────────────────────────────────────────────────────────
info "Fetching upstream/${UPSTREAM_BRANCH}..."
git fetch "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"

# Check if there's anything new
LOCAL_SHA="$(git rev-parse origin/main)"
UPSTREAM_SHA="$(git rev-parse "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"

if [[ "$LOCAL_SHA" == "$UPSTREAM_SHA" ]]; then
  ok "Already up to date — origin/main and upstream/main point to the same commit."
  exit 0
fi

AHEAD_COUNT="$(git rev-list --count "origin/main..${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}")"
BEHIND_COUNT="$(git rev-list --count "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}..origin/main")"
info "Divergence: upstream is $AHEAD_COUNT commit(s) ahead, fork is $BEHIND_COUNT commit(s) ahead."

# ── Check for existing branch ────────────────────────────────────────────────
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  die "Branch '$BRANCH' already exists locally. Delete it first or wait until tomorrow."
fi
if git ls-remote --exit-code origin "refs/heads/$BRANCH" >/dev/null 2>&1; then
  die "Branch '$BRANCH' already exists on origin. A sync for today may already be in progress."
fi

# ── Create integration branch ────────────────────────────────────────────────
info "Creating integration branch: $BRANCH"
git checkout -b "$BRANCH" main

# ── Merge upstream ───────────────────────────────────────────────────────────
info "Merging ${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH} ($AHEAD_COUNT new commit(s))..."

if ! git merge "${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}" --no-edit \
  -m "merge: upstream NVIDIA/NemoClaw main ${DATE}

Upstream commits: ${AHEAD_COUNT}
Fork-only commits: ${BEHIND_COUNT}
Upstream SHA: ${UPSTREAM_SHA}
Origin SHA: ${LOCAL_SHA}"; then

  echo ""
  err "═══════════════════════════════════════════════════════════════"
  err "  MERGE CONFLICTS DETECTED — manual resolution required"
  err "═══════════════════════════════════════════════════════════════"
  echo ""
  warn "Conflicting files:"
  git diff --name-only --diff-filter=U | while read -r f; do
    echo "  - $f"
  done
  echo ""

  # Print hotspot-specific guidance
  if git diff --name-only --diff-filter=U | grep -q "bin/nemoclaw.js"; then
    echo ""
    warn "╭─ HOTSPOT: bin/nemoclaw.js ─────────────────────────────────────╮"
    warn "│ This file contains ALL fork-specific CLI commands.             │"
    warn "│ Accept upstream structural changes, then re-apply fork         │"
    warn "│ commands: backup, restore, repair-main, discord-probe,        │"
    warn "│ dashboard, destroy, policy-add, policy-list, setup-spark,     │"
    warn "│ deploy. Check FORK_FEATURES.md for the full list.             │"
    warn "╰────────────────────────────────────────────────────────────────╯"
    echo ""
  fi

  if git diff --name-only --diff-filter=U | grep -q "scripts/nemoclaw-start.sh"; then
    echo ""
    warn "╭─ HOTSPOT: scripts/nemoclaw-start.sh ──────────────────────────╮"
    warn "│ Preserve these fork additions:                                 │"
    warn "│  • ensure_agent_webchat_sessions() — agent visibility          │"
    warn "│  • agents-overlay.json merge logic — custom agent persistence  │"
    warn "│  • Bounded probe timeouts (--max-time) — hang prevention       │"
    warn "│  • Background launch guard — sandbox create compatibility      │"
    warn "╰────────────────────────────────────────────────────────────────╯"
    echo ""
  fi

  if git diff --name-only --diff-filter=U | grep -q "package.json"; then
    echo ""
    warn "╭─ HOTSPOT: package.json ────────────────────────────────────────╮"
    warn "│ Accept upstream version bumps. Preserve fork-specific scripts. │"
    warn "│ Run 'npm install' after resolution to regenerate lockfile.     │"
    warn "╰────────────────────────────────────────────────────────────────╯"
    echo ""
  fi

  if git diff --name-only --diff-filter=U | grep -qE "Dockerfile|Dockerfile\.base"; then
    echo ""
    warn "╭─ HOTSPOT: Dockerfile / Dockerfile.base ────────────────────────╮"
    warn "│ Accept upstream package changes. Preserve pinned openclaw      │"
    warn "│ version and update.checkOnStart=false suppression.             │"
    warn "╰────────────────────────────────────────────────────────────────╯"
    echo ""
  fi

  echo ""
  info "To resolve:"
  info "  1. Fix conflicts in the files listed above"
  info "  2. git add <resolved-files>"
  info "  3. git commit --no-edit"
  info "  4. Re-run: $0"
  info ""
  info "To abort:"
  info "  git merge --abort && git checkout main && git branch -D $BRANCH"
  exit 1
fi

ok "Merge completed cleanly."

# ── Post-merge validation ────────────────────────────────────────────────────
info "Running post-merge validation..."

info "[1/4] Installing dependencies..."
npm install --ignore-scripts
(cd nemoclaw && npm install)

info "[2/4] Building TypeScript plugin..."
(cd nemoclaw && npm run build)

info "[3/4] Running unit tests..."
npx vitest run

info "[4/4] Running lint checks..."
make check

ok "All post-merge validation passed."

# ── Summary ──────────────────────────────────────────────────────────────────
FILES_CHANGED="$(git diff --stat "main..${BRANCH}" | tail -1)"
echo ""
info "══════════════════════════════════════════════════════════════"
info "  Sync summary"
info "══════════════════════════════════════════════════════════════"
info "  Branch:    $BRANCH"
info "  Upstream:  $AHEAD_COUNT new commit(s) merged"
info "  Fork:      $BEHIND_COUNT fork-only commit(s) preserved"
info "  Changes:   $FILES_CHANGED"
info "══════════════════════════════════════════════════════════════"
echo ""

# ── Push and open PR ─────────────────────────────────────────────────────────
if $DRY_RUN; then
  warn "Dry run — skipping push and PR creation."
  info "To proceed manually:"
  info "  git push origin $BRANCH"
  info "  gh pr create --base main --title 'merge: upstream NVIDIA/NemoClaw main $DATE'"
  exit 0
fi

info "Pushing branch to origin..."
git push origin "$BRANCH"

info "Opening pull request..."

PR_BODY="## Upstream Sync — ${DATE}

Merges \`NVIDIA/NemoClaw\` \`main\` into this fork.

### Stats
- **Upstream commits merged:** ${AHEAD_COUNT}
- **Fork-only commits preserved:** ${BEHIND_COUNT}
- **Upstream SHA:** \`${UPSTREAM_SHA}\`
- **Origin SHA (before merge):** \`${LOCAL_SHA}\`
- **Files changed:** ${FILES_CHANGED}

### Validation
- [x] \`npm install\` — dependencies installed
- [x] \`npm run build\` — TypeScript plugin compiles
- [x] \`npx vitest run\` — all unit tests pass
- [x] \`make check\` — lint and hooks pass

### Post-merge review checklist
See the [upstream-sync PR template](.github/PULL_REQUEST_TEMPLATE/upstream-sync.md) for the full checklist.
Refer to [FORK_FEATURES.md](FORK_FEATURES.md) for the complete fork feature inventory.
"

PR_URL=$(gh pr create \
  --base main \
  --head "$BRANCH" \
  --title "merge: upstream NVIDIA/NemoClaw main ${DATE}" \
  --body "$PR_BODY" \
  --label "upstream-sync" 2>&1) || true

if [[ "$PR_URL" == http* ]]; then
  ok "Pull request created: $PR_URL"
else
  warn "Could not create PR automatically (label may not exist yet)."
  warn "gh output: $PR_URL"
  info "Create manually:"
  info "  gh pr create --base main --head $BRANCH --title 'merge: upstream NVIDIA/NemoClaw main $DATE'"
fi

echo ""
ok "Upstream sync complete. Review the PR, then merge when CI passes."
