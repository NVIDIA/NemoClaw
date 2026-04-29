---
name: nemoclaw-maintainer-cut-release-tag
description: Cut a new semver release — bump all version strings via bump-version.ts, open a release PR, and after merge tag main and push. Use when cutting a release, tagging a version, shipping a build, or preparing a deployment. Trigger keywords - cut tag, release tag, new tag, cut release, tag version, ship it.
user_invocable: true
---

# Cut Release Tag

Bump all version strings, open a release PR, and after merge create annotated semver + `latest` tags on `origin/main`.

This skill delegates the version-bump work to `scripts/bump-version.ts` (invoked via `npm run bump:version`). That script updates package.json (root + plugin), blueprint.yaml, installer defaults, docs config, and versioned doc links — then runs the build and tests before opening a PR.

## Prerequisites

- You must be in the NemoClaw git repository.
- You must have push access to `origin` (NVIDIA/NemoClaw).
- The nightly E2E suite should have passed before tagging. Check with the user if unsure.

## Step 1: Determine the Current Version

Fetch all tags and find the latest semver tag:

```bash
git fetch origin --tags
git tag --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1
```

Parse the major, minor, and patch components from this tag.

## Step 2: Ask the User Which Bump

Present the options with the **patch bump as default**:

- **Patch** (default): `vX.Y.(Z+1)` — bug fixes, small changes
- **Minor**: `vX.(Y+1).0` — new features, larger changes
- **Major**: `v(X+1).0.0` — breaking changes

Show the concrete version strings. Example prompt:

> Current tag: `v0.0.2`
>
> Which version bump?
>
> 1. **Patch** → `v0.0.3` (default)
> 2. **Minor** → `v0.1.0`
> 3. **Major** → `v1.0.0`

Wait for the user to confirm before proceeding. If they just say "yes", "go", "do it", or similar, use the patch default.

## Step 3: Show What's Being Tagged

Show the user the commit that will be tagged and the changelog since the last tag:

```bash
git log --oneline origin/main -1
git log --oneline <previous-tag>..origin/main
```

Ask for confirmation before proceeding.

## Step 4: Run the Version Bump Script

First, preview the plan with `--dry-run`:

```bash
npm run bump:version -- <version-without-v-prefix> --dry-run
```

Show the dry-run output to the user. After confirmation, ask the user which mode they want:

### Option A: PR mode (default, recommended)

```bash
npm run bump:version -- <version-without-v-prefix>
```

This will:

1. Update all version strings across the repo
2. Run the build and tests
3. Create a `release/<version>` branch and open a release PR against `main`

In PR mode, tagging is deferred — proceed to Step 5 after the PR merges.

### Option B: Direct mode (no PR)

```bash
npm run bump:version -- <version-without-v-prefix> --no-create-pr --push
```

This will:

1. Update all version strings across the repo
2. Run the build and tests
3. Commit directly on `main`
4. Create annotated `v<version>` and `latest` tags
5. Push the commit and both tags to origin

In direct mode, tagging and pushing are handled by the script — skip to Step 6.

If the user wants to skip tests (e.g., they already ran them), add `--skip-tests` to either mode.

## Step 5: Create and Push Tags (PR mode only, after PR merge)

Skip this step if you used direct mode in Step 4 — the script already tagged and pushed.

Once the release PR is merged into `main`, create the annotated tag, move `latest`, and push:

```bash
git fetch origin main --tags
git tag -a <new-version> origin/main -m "<new-version>"

# Move the latest tag (delete old, create new)
git tag -d latest 2>/dev/null || true
git tag -a latest origin/main -m "latest"

# Push both tags (force-push latest since it moves)
git push origin <new-version>
git push origin latest --force
```

## Step 6: Verify

```bash
git ls-remote --tags origin | grep -E '(<new-version>|latest)'
```

Confirm both tags point to the same commit on the remote.

## Important Notes

- NEVER tag without explicit user confirmation of the version.
- NEVER tag a branch other than `origin/main`.
- Always use annotated tags (`-a`), not lightweight tags.
- The `latest` tag is a floating tag that always points to the most recent release — it requires `--force` to push.
- The version string passed to `npm run bump:version` should NOT have a `v` prefix (e.g., `0.0.3`, not `v0.0.3`). The script adds the `v` prefix for tags internally.
