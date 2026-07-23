<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Reduce Merge Conflicts

Find files that slow development and reduce future merge conflicts.

## Step 1: Run the Hotspot Script

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/hotspots.ts
```

The script combines 30 days of `main` changes with file overlap from open PRs.
It marks risky areas and returns a ranked JSON list.

Pipe into state:

```bash
node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/hotspots.ts | node --experimental-strip-types --no-warnings .agents/skills/nemoclaw-maintainer-day/scripts/state.ts set-hotspots
```

## Step 2: Prioritize

Review the ranked output.
Start with entries that have a high `combinedScore`, `isRisky: true`, and few tests.

## Step 3: Select a change

Select the smallest change that reduces future conflicts:

- extract stable logic into a tested helper
- split parsing from execution
- add regression tests around repeated breakage
- deduplicate workflow logic
- narrow interfaces with typed helpers

Prefer changes that also improve testability.

## Step 4: Keep Small

Process one file cluster in each pass.
If the next step requires a redesign, follow [SEQUENCE-WORK.md](SEQUENCE-WORK.md).

## Step 5: Validate

Run tests for the changed behavior.
If the code is in a risky area, also follow [TEST-GAPS.md](TEST-GAPS.md).

## Notes

- Reduce future merge conflicts. Do not make style-only changes.
- Do not add a refactor that exceeds the contributor's objective.
