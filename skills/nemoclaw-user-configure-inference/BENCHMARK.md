# Evaluation Report

Evaluation of the `nemoclaw-user-configure-inference` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nemoclaw-user-configure-inference`
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 13 total findings.

Top findings:

- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/inference-options.md:89`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/nemoclaw-user-configure-inference/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.tags' (`skills/nemoclaw-user-configure-inference/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in set-up-sub-agent.md (`skills/nemoclaw-user-configure-inference/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/nemoclaw-user-configure-inference/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 3 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/inference-options.md and references/set-up-sub-agent.md and references/switch-inference-providers.md and references/tool-calling-reliability.md and references/use-local-inference-details.md:
  "(preamble)" in SKILL.md (lines 1-3)
  vs "(preamble)" in references/inference-options.md (lines 1-2)
  vs "(preamble)" in references/set-up-sub-agent.md (lines 1-2)
  vs "(preamble)" in references/switch-inference-providers.md (lines 1-2)
  vs "(preamble)" in references/tool-calling-reliability.md (lines 1-2)
  vs "(preamble)" in references/use-local-inference-details.md (lines 1-2) (`SKILL.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/inference-options.md and references/tool-calling-reliability.md:
  "## Next Steps" in references/inference-options.md (lines 138-142)
  vs "## Next Steps" in references/tool-calling-reliability.md (lines 160-164) (`references/inference-options.md:138`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/inference-options.md and references/switch-inference-providers.md:
  "## How Inference Routing Works" in references/inference-options.md (lines 9-19)
  vs "## Notes" in references/switch-inference-providers.md (lines 197-204) (`references/inference-options.md:9`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
