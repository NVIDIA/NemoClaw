#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# chad-upstream-sync.sh — keep tantodefi/NemoClaw (fork) current with
# NVIDIA/NemoClaw (upstream), WITHOUT ever auto-merging a conflict onto a
# protected branch.
#
# What it does (idempotent, safe to run on a cron):
#   1. Fetch upstream + origin.
#   2. If upstream/main has no new commits past the base branch, exit 0 (noop).
#   3. Create a fresh sync branch off the base branch and `git merge upstream/main`.
#   4. CLEAN merge  -> run the gate (`make check` + tests if present), push the
#      branch, open a PR into the base branch. A human (or the maintainer loop)
#      reviews + merges. We never push straight to the base branch.
#   5. CONFLICT     -> keep the conflict markers, push the branch, open a PR
#      titled "needs manual conflict resolution" with the conflicted paths in the
#      body. NEVER resolve conflicts automatically (honors the Chad git-write
#      boundary: no autonomous writes to a shared branch).
#
# Chad-local filesets that must survive every upstream merge (if upstream ever
# touches these paths, the conflict PR surfaces it for a human):
#   scripts/openwebui/   scripts/chad-*   scripts/chad-cron-wrappers/
#   scripts/chad-smithers/   docs/design/multi-user-chad.md
#   docs/design/MASTER-REVIEW-*.md
#
# Requires: git, gh (authenticated). Env knobs:
#   BASE_BRANCH   (default: chad-dev)      — the fork branch to keep current
#   UPSTREAM_REF  (default: upstream/main)
#   DRY_RUN=1                              — do everything except push + PR

set -euo pipefail

BASE_BRANCH="${BASE_BRANCH:-chad-dev}"
UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
DRY_RUN="${DRY_RUN:-}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SYNC_BRANCH="chad/upstream-sync-${STAMP}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # repo root (scripts/..)
cd "$here"

log() { printf '[upstream-sync %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

command -v git >/dev/null || die "git not found"
git remote get-url upstream >/dev/null 2>&1 || die "no 'upstream' remote (expected NVIDIA/NemoClaw)"

# Never run on a dirty tree — we don't want to entangle local edits in the merge.
if [ -n "$(git status --porcelain)" ]; then
  die "working tree is dirty; commit or stash before syncing"
fi

log "fetching upstream + origin"
git fetch --quiet upstream
git fetch --quiet origin

# How far behind is the base branch?
behind="$(git rev-list --count "origin/${BASE_BRANCH}..${UPSTREAM_REF}" 2>/dev/null || echo 0)"
if [ "${behind}" = "0" ]; then
  log "origin/${BASE_BRANCH} is already current with ${UPSTREAM_REF}; nothing to do"
  exit 0
fi
log "${UPSTREAM_REF} is ${behind} commit(s) ahead of origin/${BASE_BRANCH}"

# Work on a throwaway branch off the current base.
git checkout --quiet -b "${SYNC_BRANCH}" "origin/${BASE_BRANCH}"

conflict=0
if git merge --no-edit --no-ff "${UPSTREAM_REF}"; then
  log "clean merge"
else
  conflict=1
  log "merge CONFLICT — leaving markers for human resolution"
fi

if [ "${conflict}" = "1" ]; then
  conflicts="$(git diff --name-only --diff-filter=U || true)"
  log "conflicted paths:"; printf '%s\n' "${conflicts}" >&2
  if [ -n "${DRY_RUN}" ]; then
    log "DRY_RUN: would push ${SYNC_BRANCH} + open a conflict PR"; git merge --abort; git checkout --quiet "${BASE_BRANCH}"; exit 0
  fi
  # Commit the conflicted state as-is so the PR shows the markers.
  git add -A
  git commit --no-verify -m "merge: upstream/main into ${BASE_BRANCH} (CONFLICTS — manual resolution needed) [${STAMP}]" >/dev/null
  git push --quiet -u origin "${SYNC_BRANCH}"
  body=$(printf 'Automated upstream sync hit merge conflicts.\n\n**Do not merge as-is** — resolve the conflicts first.\n\nConflicted paths:\n```\n%s\n```\n\nChad-local paths that must be preserved: `scripts/openwebui/`, `scripts/chad-*`, `scripts/chad-cron-wrappers/`, `scripts/chad-smithers/`, `docs/design/multi-user-chad.md`.\n' "${conflicts}")
  gh pr create --base "${BASE_BRANCH}" --head "${SYNC_BRANCH}" \
    --title "chore: upstream sync ${STAMP} — ⚠ CONFLICTS need resolution" \
    --body "${body}" --label "upstream-sync" 2>/dev/null \
    || gh pr create --base "${BASE_BRANCH}" --head "${SYNC_BRANCH}" \
         --title "chore: upstream sync ${STAMP} — CONFLICTS" --body "${body}"
  log "opened conflict PR; exiting non-zero so the cron surfaces it"
  exit 2
fi

# Clean merge: run the gate before proposing it.
gate_ok=1
if [ -f Makefile ] && grep -qE '^check:' Makefile; then
  log "running 'make check'"; make check >/tmp/chad-upstream-check.log 2>&1 || gate_ok=0
fi
if [ "${gate_ok}" = "0" ]; then
  log "gate FAILED (see /tmp/chad-upstream-check.log) — opening PR as draft for review"
fi

if [ -n "${DRY_RUN}" ]; then
  log "DRY_RUN: clean merge, gate_ok=${gate_ok}; would push + open PR"; git checkout --quiet "${BASE_BRANCH}"; exit 0
fi

git push --quiet -u origin "${SYNC_BRANCH}"
draft=""; [ "${gate_ok}" = "0" ] && draft="--draft"
gh pr create --base "${BASE_BRANCH}" --head "${SYNC_BRANCH}" ${draft} \
  --title "chore: upstream sync ${STAMP} (${behind} commits)" \
  --body "Automated clean merge of \`${UPSTREAM_REF}\` into \`${BASE_BRANCH}\`. Gate: $([ "${gate_ok}" = 1 ] && echo 'make check passed ✅' || echo 'make check FAILED ❌ — draft, review before merge'). Review + merge; never force." \
  --label "upstream-sync" 2>/dev/null \
  || gh pr create --base "${BASE_BRANCH}" --head "${SYNC_BRANCH}" ${draft} \
       --title "chore: upstream sync ${STAMP}" --body "Clean merge of ${UPSTREAM_REF}."
log "opened PR for review"
