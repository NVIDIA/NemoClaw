<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Publishing a NemoClaw skill to the NVIDIA Verified Skills catalog

The `skills/` directory at the repo root is the NVSkills CI watched location.
Whatever lives there is what gets signed and published. There is no
allowlist, manifest, or generator script — adding a skill to the catalog
means copying the source skill into `skills/` and pushing it through
NVSkills CI signing.

## Add a skill to the catalog

```bash
mkdir -p skills
cp -R .agents/skills/nemoclaw-user-<name> skills/
git add skills/nemoclaw-user-<name>
git commit -m "chore(skills): publish nemoclaw-user-<name>"
```

Open the PR, comment `/nvskills-ci`, wait for the signing job to push back
`skill.oms.sig` and `skill-card.md`, then merge. Repeat per skill — NVSkills
CI signs one at a time.

## Update an already-published skill

```bash
rm -rf skills/nemoclaw-user-<name>
cp -R .agents/skills/nemoclaw-user-<name> skills/
git add -A skills/nemoclaw-user-<name>
git commit -m "chore(skills): refresh nemoclaw-user-<name>"
```

The `skill.oms.sig` from the previous signing is removed by the `rm -rf`,
so NVSkills CI will re-sign on the next `/nvskills-ci` comment. Use
`git add -A` so newly added files in the refreshed skill are staged
alongside removals tracked by `git commit -a`.

## Spot-checking for drift

Source (`/.agents/skills/`) and published (`/skills/`) can drift if a
source-side edit lands without a corresponding refresh PR. To check, ask
an agent to compare every subdirectory of `skills/` against its counterpart
under `.agents/skills/` and report any file content differences (ignoring
`skill.oms.sig` and `skill-card.md`).

## What goes in the catalog

Only customer-facing skills, identified by the `nemoclaw-user-*` naming
convention. Internal skills (`nemoclaw-maintainer-*`, `nemoclaw-contributor-*`)
must not be copied into `skills/`.
