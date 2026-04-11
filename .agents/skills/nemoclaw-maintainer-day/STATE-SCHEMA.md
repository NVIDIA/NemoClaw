# State File Schema

Path: `.nemoclaw-maintainer/state.json` (excluded via `.git/info/exclude`).

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

- `gates.autoMerge` is always `false`. The loop may approve but never merges.
- `gates.autoPushSmallFixes` allows pushing narrow fixes to contributor branches.
- `excluded.prs` / `excluded.issues`: keys are numbers (as strings), values are `{ "reason": "...", "excludedAt": "ISO" }`. Items here are permanently skipped by triage until the user removes them.
- `history` entries: `{ "at": "ISO", "item": "PR#1234", "action": "approved|salvaged|blocked|sequenced", "note": "one line" }`. Keep under 50 entries; trim oldest.
- `queue.items` and `queue.nearMisses` store the latest triage output for comparison across runs.
