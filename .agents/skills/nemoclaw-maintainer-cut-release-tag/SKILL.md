---
name: nemoclaw-maintainer-cut-release-tag
description: Prepare and cut a final NemoClaw v1 product release. Use when a maintainer asks to prepare or cut a v0.1.x release tag, or to check that a candidate is ready for the cut.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from main's cut-release-tag skill at 4649634639d2ddcb26b84cb34db63b2d4176a8a1 for v1's Markdown changelog and release workflows. -->

# Cut a v1 Product Release

For a release candidate such as `v0.1.0-rc.1`, record changes in the [internal release candidate notes](../../../internal-docs/contributing/release-candidates.md) and follow the [staging procedure](../../../internal-docs/contributing/releases.md#staging-from-a-tag).

## Prepare the Final Release

Follow the [maintainer evening handoff](../nemoclaw-maintainer-evening/SKILL.md) through step 3 to gather the evidence.
From the repository root, verify that `origin` is `NVIDIA/NemoClaw`, fetch `origin/v1`, and establish the previous final tag and its commit for the release range.
Set `tag` to the requested final version, such as `v0.1.0`, and `candidate` to the full SHA of the selected commit on `origin/v1`.
Use the same tag and SHA through planning, approval, and the cut.
Exactly one dated changelog entry must contain the heading `## <tag>`, with at least one bullet describing a shipped change under that heading.

```sh
check_release_notes() (
  tag=$1
  candidate=$2
  git check-ref-format "refs/tags/$tag" &&
    printf '%s\n' "$tag" | grep -Eq '^v0\.1\.(0|[1-9][0-9]*)$' || return 1
  [ "$(git rev-parse --verify "${candidate}^{commit}")" = "$candidate" ] || return 1
  git merge-base --is-ancestor "$candidate" origin/v1 || return 1
  tag_pattern=$(printf '%s\n' "$tag" | sed 's/[.]/[.]/g')
  matches=$(git grep --no-color --no-heading -n -e "^## ${tag_pattern}$" "$candidate" -- \
    ':(top,glob)docs/changelog/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md') || return 1
  [ "$(printf '%s\n' "$matches" | wc -l)" -eq 1 ] || return 1
  entry=${matches#*:}
  entry=${entry%%:*}
  printf '%s:%s\n' "$candidate" "$entry"
  git show "$candidate:$entry" | awk -v heading="## $tag" '
    $0 == heading { found = 1 }
    found && $0 != heading && /^##[[:space:]]/ { exit }
    found { print }
    found && /^-[[:space:]]+[^[:space:]]/ { detail = 1 }
    END { exit !detail }
  '
)
check_release_notes "$tag" "$candidate"
```

Proceed only if the check succeeds, the filename matches the planned release date, and the section describes changes that ship in this commit.
Include the commit SHA, path, and section in the maintainer's release brief.
If the entry is missing, duplicated, or lacks a release detail, stop before creating the tag. Merge the correction into `v1` and repeat the check on the new candidate.

Record the version, previous release, release range, candidate SHA, and exact confirmation phrase in a new plan under `../nemoclaw-release-vX.Y.Z/`.
Write `release-brief.md` in that directory with the release entry, documentation coverage and decision, RC and image evidence, and the maintainer's E2E decision.
Confirm the [product sign-offs and license review](../../../internal-docs/contributing/releases.md#publishing) and review the brief with the maintainer.
A new candidate requires a new plan, brief, and confirmation.
A preparation request ends with the reviewed brief.

## Cut the Approved Tag

For a requested cut, ask the maintainer for `CONFIRM RELEASE vX.Y.Z <full-candidate-sha>`, using the version and SHA from the plan.
Check that the final version is unused on the remote.
In the same shell, set `confirmation` to the maintainer's exact reply and `brief` to the reviewed `release-brief.md`.
The signing key stays on the maintainer's workstation.

```sh
test "$confirmation" = "CONFIRM RELEASE $tag $candidate" &&
  check_release_notes "$tag" "$candidate" &&
  remote_ref=$(git ls-remote --refs origin "refs/tags/$tag") &&
  test -z "$remote_ref" &&
  git tag -s -F "$brief" --cleanup=verbatim "$tag" "$candidate" &&
  git push --no-follow-tags origin "refs/tags/$tag:refs/tags/$tag"
```

Read back the tag with `git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}"`.
Verify that the tag object matches `git rev-parse "refs/tags/$tag"` and that it peels to the approved SHA.
If the push reports an error, read back the remote before deciding whether the tag was cut.
If the remote and local objects disagree, stop and report both. Keep version tags immutable.
Report a successful cut as soon as readback matches, including the plan and brief paths.

## Follow the Release

Find the push runs for the exact tag and candidate SHA in [CI / Bundle](../../../.github/workflows/rust.yml), [Release / Stage](../../../.github/workflows/release.yml), and [CD / Documentation](../../../.github/workflows/docs.yml).
Monitor the runs and record their URLs and attempts.
Require the bundle run, **Publish the release** job, and documentation **Release** job to succeed.
Read back the GitHub release and verify that it is public and that its assets identify the final version.
Verify the published changelog entry on the v1 documentation route.

Draft the announcement from the approved range and release brief for maintainer review.
Report the release and documentation outcomes when the tag runs reach terminal states.
For a failed run, report its failed job and the next recovery action. Ask before rerunning a workflow.
A publication failure leaves the tag in place.
