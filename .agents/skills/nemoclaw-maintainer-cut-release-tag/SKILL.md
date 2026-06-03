---
name: nemoclaw-maintainer-cut-release-tag
description: Creates deterministic NemoClaw semver release tags on origin/main and drafts release notes. Use when cutting a release, tagging a version, shipping a build, creating vX.Y.Z tags, or preparing release announcements.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cut Release Tag

Create one annotated semver tag on an already-merged `origin/main` commit. The tag is the release. Do not bump version files, open a release PR, push `latest`, or touch `lkg` from this skill.

A GitHub workflow moves `latest` after the semver tag is pushed. Release admins promote `lkg` manually after validation.

## Hard Rules

- Tag only commits reachable from `origin/main`.
- Ask the maintainer to confirm the exact commit before creating or pushing a tag.
- Create annotated tags (`git tag -a`), never lightweight tags.
- Push only the semver tag (`vX.Y.Z`). Never push `latest` or `lkg`.
- If a remote semver tag already exists, stop. Do not move, delete, or force-push it unless the maintainer explicitly starts a remediation flow.
- Draft release notes locally after tagging. Do not create the GitHub Discussion; the maintainer does that.

## Workflow

Copy this checklist and update it as you proceed:

```text
Release Progress:
- [ ] Step 1: Verify repository and remote state
- [ ] Step 2: Choose the next semver tag
- [ ] Step 3: Confirm the exact origin/main commit with the maintainer
- [ ] Step 4: Create and push the annotated semver tag
- [ ] Step 5: Verify the semver tag and workflow-managed latest tag
- [ ] Step 6: Draft release notes for maintainer review
- [ ] Step 7: Hand off announcement and sharing steps
```

### Step 1: Verify Repository and Remote State

```bash
git rev-parse --show-toplevel
git remote get-url origin
git status --short
git fetch origin main --tags --force
```

Continue only if:

- the repo is `NVIDIA/NemoClaw`,
- the worktree is clean,
- `origin/main` is fetched.

Find the latest remote semver tag from the remote, not local tag state:

```bash
git ls-remote --tags origin 'v*' \
  | awk '{print $2}' \
  | sed 's#refs/tags/##; s#\^{}##' \
  | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -Vr \
  | head -1
```

### Step 2: Choose the Next Semver Tag

Present patch/minor/major choices with patch as default. Example:

```text
Current release: v0.0.56

Which version bump?
1. Patch → v0.0.57 (default)
2. Minor → v0.1.0
3. Major → v1.0.0
```

If the maintainer says "yes", "go", or similar without choosing, use the patch default.

Before continuing, verify the remote tag does not already exist:

```bash
if git ls-remote --exit-code --tags origin <new-version> >/dev/null; then
  echo "Tag already exists: <new-version>" >&2
  exit 1
fi
```

### Step 3: Confirm the Exact Commit

Show the target commit and changelog:

```bash
git log --oneline origin/main -1
git log --oneline <previous-version>..origin/main
```

Ask:

```text
Confirm: create annotated tag <new-version> pointing at origin/main commit <sha>?
```

Do not tag until the maintainer confirms the exact commit.

### Step 4: Create and Push the Semver Tag

Use the confirmed commit SHA, not a branch name that can move:

```bash
target=<confirmed-origin-main-sha>
tag=<new-version>

git fetch origin main --tags --force
git cat-file -e "${target}^{commit}"
git merge-base --is-ancestor "$target" origin/main

git tag -a "$tag" "$target" -m "$tag"
git push origin "refs/tags/$tag"
```

If any command fails, stop and report the failure.

### Step 5: Verify Tags

Verify the semver tag immediately:

```bash
git ls-remote --tags origin <new-version> 'refs/tags/<new-version>^{}'
```

Then wait for the GitHub workflow that updates `latest`, and verify both tags peel to the confirmed commit:

```bash
git ls-remote --tags origin \
  <new-version> 'refs/tags/<new-version>^{}' \
  latest 'refs/tags/latest^{}'
```

Use `gh run list --workflow release-latest-tag.yaml --limit 3` if you need the workflow status.

If `latest` does not update, report the workflow URL/status and stop. Do not move `latest` manually from this skill.

### Step 6: Draft Release Notes

Draft release notes from live GitHub data using the release range `<previous-version>...<new-version>`. Save the local draft outside the checkout root, for example:

```text
../nemoclaw-<new-version>-release-note-draft.md
```

Follow the release-note style from `nemoclaw-maintainer-release-notes`, but stop after producing the local draft. Do not create or update a GitHub Discussion.

### Step 7: Hand Off Announcement

Return:

- release tag,
- confirmed release commit,
- `latest` verification status,
- Markdown draft path,
- suggested discussion title: `NemoClaw <new-version> is out`,
- reminder: maintainer creates the Announcement discussion and shares its link in external channels.

## Recovery

- Remote semver tag already exists: stop. Do not retag unless the maintainer explicitly asks for protected-tag remediation.
- Semver tag pushed but `latest` workflow fails: report the failed workflow. Do not manually update `latest`.
- Confirmed commit is not reachable from `origin/main`: stop; ask the maintainer for the correct commit.
- Wrong tag was pushed: stop; protected-tag remediation requires explicit maintainer/admin instruction.
