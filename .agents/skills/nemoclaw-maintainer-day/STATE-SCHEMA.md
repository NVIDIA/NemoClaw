<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# State File Schema

Store state in `.nemoclaw-maintainer/state.json`.
Git excludes this file through `.git/info/exclude`.

```json
{
  "version": 1,
  "repo": "NVIDIA/NemoClaw",
  "updatedAt": null,
  "priorities": [
    "reduce_pr_backlog",
    "reduce_security_risk",
    "increase_test_coverage",
    "cool_hot_files"
  ],
  "gates": {
    "greenCi": true,
    "noConflicts": true,
    "noMajorCodeRabbit": true,
    "testsForTouchedRiskyCode": true,
    "autoApprove": true,
    "autoPushSmallFixes": true,
    "autoMerge": false
  },
  "excluded": {
    "prs": {},
    "issues": {}
  },
  "queue": {
    "generatedAt": null,
    "topAction": null,
    "items": [],
    "nearMisses": []
  },
  "hotspots": {
    "generatedAt": null,
    "files": []
  },
  "activeWork": {
    "kind": null,
    "target": null,
    "branch": null,
    "goal": null,
    "startedAt": null
  },
  "history": []
}
```

## Field Notes

- Set `gates.autoMerge` to `false`. The loop can approve a PR but must not merge it.
- `gates.autoPushSmallFixes` permits small fixes on contributor branches.
- Use number strings as keys in `excluded.prs` and `excluded.issues`.
  Use `{ "reason": "...", "excludedAt": "ISO" }` as each value.
  Triage skips these items until the user removes them.
- Use this format for `history` entries: `{ "at": "ISO", "item": "PR#1234", "action": "approved|salvaged|blocked|sequenced", "note": "one line" }`.
  Keep at most 50 entries. Remove the oldest entries first.
- `queue.items` and `queue.nearMisses` store the latest triage output for comparison across runs.
