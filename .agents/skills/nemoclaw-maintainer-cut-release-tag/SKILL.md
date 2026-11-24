---
name: nemoclaw-maintainer-cut-release-tag
description: Check the release notes at the candidate commit before cutting a final NemoClaw v1 tag. Use during maintainer release preparation for v0.1.x final or release candidate tags.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Adapted from main's candidate-evidence.md at 4649634639d2ddcb26b84cb34db63b2d4176a8a1 for v1's Markdown changelog and RC process. -->

# Check Release Notes Before Tagging

For a release candidate such as `v0.1.0-rc.1`, record changes in the [internal release candidate notes](../../../internal-docs/contributing/release-candidates.md) and follow the [staging procedure](../../../internal-docs/contributing/releases.md#staging-from-a-tag).

For a final tag such as `v0.1.0`, set `tag` to the proposed tag and `candidate` to the full commit SHA you intend to tag.
Run `git fetch origin v1`, then run the check from the repository root.
Exactly one dated changelog entry must contain the heading `## <tag>`, with at least one bullet describing a shipped change under that heading.

```sh
(
  set -eu
  git merge-base --is-ancestor "$candidate" origin/v1
  tag_pattern=$(printf '%s\n' "$tag" | sed 's/[.]/[.]/g')
  matches=$(git grep --no-color --no-heading -n -e "^## ${tag_pattern}$" "$candidate" -- \
    ':(top,glob)docs/changelog/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].md')
  [ "$(printf '%s\n' "$matches" | wc -l)" -eq 1 ]
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
```

Proceed only if the check succeeds, the filename matches the planned release date, and the section describes changes that ship in this commit.
Include the commit SHA, path, and section in the maintainer's release brief.
If the entry is missing, duplicated, or lacks a release detail, stop before creating the tag. Merge the correction into `v1` and repeat the check on the new candidate.
Before tagging that SHA, complete the remaining [publishing requirements](../../../internal-docs/contributing/releases.md#publishing).
