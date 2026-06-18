# Evaluation Report

Evaluation of the `omniverse-realtime-viewer` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `omniverse-realtime-viewer`
- Evaluation date: 2026-05-28
- NVSkills-Eval profile: `external`
- Overall verdict: FAIL
- Tier 3 live agent evaluation: not available in this report

## Agents Used

- Tier 3 agent details were not available in this report.

## Metrics Used

Reported benchmark dimensions:

- Security: checks whether skill-assisted execution avoids unsafe behavior such as secret leakage, destructive commands, or unauthorized access.
- Correctness: checks whether the agent follows the expected workflow and produces the correct final output.
- Discoverability: checks whether the agent loads the skill when relevant and avoids using it when irrelevant.
- Effectiveness: checks whether the agent performs measurably better with the skill than without it.
- Efficiency: checks whether the agent uses fewer tokens and avoids redundant work.

Underlying evaluation signals used in this run:

- No Tier 3 evaluation signal details were available in this report.

## Test Tasks

Tier 3 evaluation task details were not available in this report.

## Results

Tier 3 dimension rollup was not available in this report.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 32 total findings.

Top findings:

- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/stage-hierarchy/fallback-worker-protocol.md:55`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/stage-hierarchy/fallback-worker-protocol.md:56`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/headless-shm-cli/README.md:156`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/headless-shm-cli/README.md:169`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/cpp-native-viewer/interaction-features.md:20`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 21 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/stage-hierarchy/README.md and references/stage-queries/README.md:
  "### `prim_list_handle` Use" in references/stage-hierarchy/README.md (lines 91-102)
  vs "## `prim_list_handle`" in references/stage-queries/README.md (lines 124-129) (`references/stage-hierarchy/README.md:91`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/conventions.md and references/routing.md and references/stage-hierarchy/fallback-worker-protocol.md and references/streaming-messages/server-handler-map.md and references/streaming-server/frame-loop-and-continuity.md and references/troubleshooting/scenario-playbooks.md and references/validation.md:
  "(preamble)" in SKILL.md (lines 1-3)
  vs "(preamble)" in references/conventions.md (lines 1-3)
  vs "(preamble)" in references/routing.md (lines 1-3)
  vs "(preamble)" in references/stage-hierarchy/fallback-worker-protocol.md (lines 1-3)
  vs "(preamble)" in references/streaming-messages/server-handler-map.md (lines 1-3)
  vs "(preamble)" in references/streaming-server/frame-loop-and-continuity.md (lines 1-3)
  vs "(preamble)" in references/troubleshooting/scenario-playbooks.md (lines 1-3)
  vs "(preamble)" in references/validation.md (lines 1-3) (`SKILL.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/ovrtx-rendering/README.md and references/stage-loading/README.md and references/stage-management/README.md:
  "## Stage Composition APIs" in references/ovrtx-rendering/README.md (lines 36-48)
  vs "## ovrtx 0.3 Stage Composition APIs" in references/stage-loading/README.md (lines 13-25)
  vs "## Stage Composition Policy" in references/stage-management/README.md (lines 32-40) (`references/ovrtx-rendering/README.md:36`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/conventions.md and references/electron-shm-viewer/protocol-interaction-lifecycle.md and references/ovui-local-viewer-recipe/setup-shell-renderer.md and references/stage-management/README.md and references/streaming-viewer-recipe/server-runtime.md:
  "## Scene Loading" in references/conventions.md (lines 83-94)
  vs "## Scene Loading, Queries, And Settings" in references/electron-shm-viewer/protocol-interaction-lifecycle.md (lines 88-116)
  vs "## 5. Implement Scene Loading" in references/ovui-local-viewer-recipe/setup-shell-renderer.md (lines 125-159)
  vs "## Adding This To An Existing Omniverse Realtime Viewer" in references/stage-management/README.md (lines 172-183)
  vs "## 5. Implement Scene Loading" in references/streaming-viewer-recipe/server-runtime.md (lines 164-198) (`references/conventions.md:83`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/stage-hierarchy/README.md and references/stage-queries/README.md:
  "### AND / OR / NOT Filters" in references/stage-hierarchy/README.md (lines 43-71)
  vs "## Filter Construction" in references/stage-queries/README.md (lines 35-70) (`references/stage-hierarchy/README.md:43`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
