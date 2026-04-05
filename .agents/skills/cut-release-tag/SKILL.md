---
name: cut-release-tag
description: Cut a new semver release tag on main, move the `latest` tag, and push. Use when cutting a release, tagging a version, shipping a build, or preparing a deployment. Trigger keywords - cut tag, release tag, new tag, cut release, tag version, ship it.
user_invocable: true
---

# Cut Release Tag

Create an annotated semver tag on `origin/main` HEAD, move the `latest` floating tag, and push both.

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

Ask for confirmation: "Tag `<new-version>` at commit `<sha>`?"

## Step 4: Create and Push Tags

Create the annotated tag, move `latest`, and push:

```bash
# Create annotated tag on main HEAD
git tag -a <new-version> origin/main -m "<new-version>"

# Move the latest tag (delete old, create new)
git tag -d latest 2>/dev/null || true
git tag -a latest origin/main -m "latest"

# Push both tags (force-push latest since it moves)
git push origin <new-version>
git push origin latest --force
```

## Step 5: Verify

```bash
git ls-remote --tags origin | grep -E '(<new-version>|latest)'
```

Confirm both tags point to the same commit on the remote.

## Important Notes

- NEVER tag without explicit user confirmation of the version.
- NEVER tag a branch other than `origin/main`.
- Always use annotated tags (`-a`), not lightweight tags.
- The `latest` tag is a floating tag that always points to the most recent release — it requires `--force` to push.
- Do NOT update `package.json` version — that is handled separately.
