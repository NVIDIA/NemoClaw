---
name: nemoclaw-maintainer-cut-release-tag
description: Prepare and cut a final NemoClaw v1 product release. Use when a maintainer asks to prepare or cut a v0.1.x release tag, or to check that a candidate is ready for the cut.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from main's candidate-evidence.md at 4649634639d2ddcb26b84cb34db63b2d4176a8a1 for v1's Markdown changelog and RC process. -->

# Cut a v1 Product Release

For a release candidate such as `v0.1.0-rc.1`, record changes in the [internal release candidate notes](../../../internal-docs/contributing/release-candidates.md) and follow the [staging procedure](../../../internal-docs/contributing/releases.md#staging-from-a-tag).

## Prepare the Final Release

Set `tag` to the requested final version, such as `v0.1.0`, and `candidate` to the full commit SHA you intend to tag.
Run `git fetch origin v1`, then run the check from the repository root.
Exactly one dated changelog entry must contain the heading `## <tag>`, with at least one bullet describing a shipped change under that heading.

```sh
check_release_notes() (
  tag=$1
  candidate=$2
  printf '%s\n' "$tag" | grep -Eq '^v0\.1\.(0|[1-9][0-9]*)$' || return 1
  [ "$(git rev-parse --verify "$candidate^{commit}")" = "$candidate" ] || return 1
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
Review the brief with the maintainer and confirm the [product release sign-offs and license review](../../../internal-docs/contributing/releases.md#publishing). A preparation request ends with the brief.

## Cut the Approved Tag

Once the maintainer approves the displayed tag and SHA for release, run the following in the same shell. A failed notes check stops the cut before Git creates the tag.

```sh
check_release_notes "$tag" "$candidate" &&
  git tag "$tag" "$candidate" &&
  git push origin "refs/tags/$tag"
```

Read back the tag with `git ls-remote origin "refs/tags/$tag" "refs/tags/$tag^{}"`. Confirm that its commit matches the approved SHA before reporting the cut.
