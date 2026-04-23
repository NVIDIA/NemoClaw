---
name: nemoclaw-maintainer-normalize-title-tags
description: Normalizes GitHub issue and PR titles by removing any bracketed [NemoClaw] tag case-insensitively, even when the tag appears later in the title. Use when cleaning issue tags, bulk-renaming titles, or normalizing repo title hygiene.
user_invocable: true
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# NemoClaw Maintainer — Normalize Title Tags

Preview and optionally apply bulk title cleanup for bracketed NemoClaw tags in GitHub issue and PR titles.

## Examples

- `[NemoClaw][All Platforms] local-inference policy preset missing Ollama ports` → `[All Platforms] local-inference policy preset missing Ollama ports`
- `[Bug] [Nemoclaw] [Slack] Slack configuration in Nemoclaw Onboard fails` → `[Bug] [Slack] Slack configuration in Nemoclaw Onboard fails`

## Prerequisites

- You must be in the NemoClaw git repository.
- The `gh` CLI must be authenticated with write access to `NVIDIA/NemoClaw`.
- Default behavior is a dry run. Do not apply changes until the user approves the preview.

## Workflow

Copy this checklist and track progress:

```text
Title tag cleanup progress:
- [ ] Step 1: Verify GitHub auth
- [ ] Step 2: Preview proposed title changes
- [ ] Step 3: Confirm scope
- [ ] Step 4: Apply changes
- [ ] Step 5: Verify no matching tags remain in scope
```

## Step 1: Verify GitHub Auth

```bash
gh auth status
```

## Step 2: Preview Proposed Changes

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-normalize-title-tags/scripts/normalize-title-tags.ts
```

The script matches bracket tags whose content is `nemoclaw`, case-insensitively, anywhere in the title.
It prints a dry-run summary by default. Review the proposed renames with the user before applying anything.

## Step 3: Confirm Scope

Ask the user which scope they want:

- **Default** — all open and closed issues and PRs in `NVIDIA/NemoClaw`
- **State filter** — optionally limit to `open` or `closed`
- **Repo override** — only when the user explicitly wants a different repository

## Step 4: Apply Changes

Apply to all items:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-normalize-title-tags/scripts/normalize-title-tags.ts \
  --apply
```

Apply only to open items:

```bash
node --experimental-strip-types --no-warnings \
  .agents/skills/nemoclaw-maintainer-normalize-title-tags/scripts/normalize-title-tags.ts \
  --state open \
  --apply
```

## Step 5: Verify

The script automatically re-runs the same search after `--apply` and exits non-zero if matching tags remain.

If verification fails, stop and show the remaining matches to the user instead of retrying blindly.

## Notes

- The script uses the GitHub Issues API, which covers both issues and pull requests.
- It removes only bracket tags whose content is `nemoclaw`, ignoring case. Plain-text mentions of `NemoClaw` are untouched.
- The default repository is `NVIDIA/NemoClaw`. Pass `--repo OWNER/REPO` only when the user explicitly wants a different repo.
