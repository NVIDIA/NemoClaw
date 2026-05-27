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

## Step 7: Conditionally Sweep Stale-Issue Verification Labels

Strip `fixed-on-latest` from open issues only when the verification has actually gone stale or a regression risk appeared since we verified — never blanket-sweep. A blanket sweep on every release re-verifies labels that were freshly applied yesterday, wasting Brev cost and creating noise. The skill's by-design path uses the existing repo `status: wont-fix` label, which is **not** swept (also applied for non-skill triage reasons, so clearing it would erase human work). `verify-inconclusive` is also kept on the same conditional cascade as `fixed-on-latest`.

**Decision cascade per labeled-and-open issue:**

| Order | Check | Action |
|---|---|---|
| 1 | Project [NVIDIA/199](https://github.com/orgs/NVIDIA/projects/199) status == **Done** | **Skip clear** — maintainer already accepted the verification; label can stay until the issue closes. |
| 2 | More than 14 days since the skill marker comment AND status != Done | **Clear** — verification is stale; reporter never confirmed in the review window. Re-verify on next skill run. |
| 3 | A PR merged since the marker date touches the paths the comment cited in `Relevant changes since v0.0.X` | **Clear** — regression risk; what was "fixed" may have been re-broken. |
| — | else | **Skip clear** — verification still holds; skill won't re-run on this issue (still excluded by Step 3 marker-TTL plus the live label). |

Closed issues are not iterated (the `--state open` filter on the listing excludes them implicitly).

Requires the `project` scope on the maintainer's gh CLI for the Project 199 status lookup. If missing, run `gh auth refresh -h github.com -s project` in a real terminal once (OAuth device-code flow). With the scope absent, the sweep falls back to the **time + regression** logic alone (skips check #1) and logs a warning.

```bash
PROJECT_NUMBER=199
TODAY_TS=$(date -u +%s)
HAVE_PROJECT_SCOPE=0
gh auth status 2>&1 | grep -q "'project'" && HAVE_PROJECT_SCOPE=1 || \
  echo "[release-sweep] WARN gh missing 'project' scope — Done-state check disabled this run"

for label in fixed-on-latest verify-inconclusive; do
  for n in $(gh issue list --repo NVIDIA/NemoClaw --state open --label "$label" --json number -q '.[].number'); do

    # 1. Project Done-state check (only if we have project scope)
    if [ "$HAVE_PROJECT_SCOPE" = "1" ]; then
      STATUS=$(gh api graphql -F num="$n" -f query='
        query($num: Int!) {
          repository(owner: "NVIDIA", name: "NemoClaw") {
            issue(number: $num) {
              projectItems(first: 100) {
                nodes {
                  project { number }
                  fieldValueByName(name: "Status") {
                    ... on ProjectV2ItemFieldSingleSelectValue { name }
                  }
                }
              }
            }
          }
        }' --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number == 199) | .fieldValueByName.name' 2>/dev/null | head -1)
      if [ "$STATUS" = "Done" ]; then
        echo "[release-sweep] kept #$n ($label) — Project 199 status is Done"
        continue
      fi
    fi

    # 2. Find the most recent skill marker comment date
    MARKER_DATE=$(gh issue view "$n" --repo NVIDIA/NemoClaw --json comments \
      --jq '.comments | map(select(.body | test("nemoclaw-verify-stale v\\d+ \\d{4}-\\d{2}-\\d{2}"))) | last | .body | (capture("nemoclaw-verify-stale v\\d+ (?<d>\\d{4}-\\d{2}-\\d{2})") // {}) | .d // empty')
    if [ -z "$MARKER_DATE" ]; then
      # Label exists but no skill marker — applied manually; leave alone.
      echo "[release-sweep] kept #$n ($label) — no skill marker, label applied manually"
      continue
    fi

    AGE_DAYS=$(( (TODAY_TS - $(date -u -j -f "%Y-%m-%d" "$MARKER_DATE" +%s 2>/dev/null || date -u -d "$MARKER_DATE" +%s)) / 86400 ))
    if [ "$AGE_DAYS" -ge 14 ]; then
      gh issue edit "$n" --repo NVIDIA/NemoClaw --remove-label "$label"
      echo "[release-sweep] cleared #$n ($label) — stale (verified ${AGE_DAYS}d ago, reporter not confirmed)"
      continue
    fi

    # 3. Regression check — any PR-merge commit since MARKER_DATE touch the paths the
    # comment's `Relevant changes since v0.0.X` block cited?
    PATHS=$(gh issue view "$n" --repo NVIDIA/NemoClaw --json comments \
      --jq '.comments | map(select(.body | test("nemoclaw-verify-stale v\\d+"))) | last | .body' \
      | grep -oE '`[a-zA-Z0-9_/.-]+\.(ts|js|sh|py|yaml|yml|md)`' | tr -d '`' | sort -u)
    if [ -n "$PATHS" ]; then
      # Run from the current directory — Step 1's prerequisite already requires the maintainer
      # to be inside the NemoClaw repo, and hardcoding ~/NemoClaw breaks anyone with a non-default
      # checkout location.
      REGRESSED=$(git log --since="$MARKER_DATE" origin/main --name-only --format=oneline -- $PATHS 2>/dev/null | head -1)
      if [ -n "$REGRESSED" ]; then
        gh issue edit "$n" --repo NVIDIA/NemoClaw --remove-label "$label"
        echo "[release-sweep] cleared #$n ($label) — regression risk (commits since ${MARKER_DATE} touch implicated paths)"
        continue
      fi
    fi

    echo "[release-sweep] kept #$n ($label) — verified ${AGE_DAYS}d ago, no Done state, no regression touch"
  done
done
```

The verification record itself stays in each issue's comment history — only the labels are reset, and only when the cascade above fires.

## Important Notes

- NEVER tag without explicit user confirmation of the version.
- NEVER tag a branch other than `origin/main`.
- Always use annotated tags (`-a`), not lightweight tags.
- The `latest` tag is a floating tag that always points to the most recent release — it requires `--force` to push.
- The version string passed to `npm run bump:version` should NOT have a `v` prefix (e.g., `0.0.3`, not `v0.0.3`). The script adds the `v` prefix for tags internally.
