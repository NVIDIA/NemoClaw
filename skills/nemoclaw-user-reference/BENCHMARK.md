# Evaluation Report

Evaluation of the `nemoclaw-user-reference` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nemoclaw-user-reference`
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 14 total findings.

Top findings:

- MEDIUM PII/ip_addresses: Non-RFC1918 IP address (`references/troubleshooting.md:137`)
- MEDIUM QUALITY/quality_correctness: Guide-only skill has very little content (14 lines) (`skills/nemoclaw-user-reference/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/nemoclaw-user-reference/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.tags' (`skills/nemoclaw-user-reference/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in troubleshooting.md (`skills/nemoclaw-user-reference/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 2 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/architecture.md and references/cli-selection-guide.md and references/commands.md and references/network-policies.md and references/troubleshooting.md:
  "(preamble)" in SKILL.md (lines 1-3)
  vs "(preamble)" in references/architecture.md (lines 1-2)
  vs "(preamble)" in references/cli-selection-guide.md (lines 1-2)
  vs "(preamble)" in references/commands.md (lines 1-2)
  vs "(preamble)" in references/network-policies.md (lines 1-2)
  vs "(preamble)" in references/troubleshooting.md (lines 1-2) (`SKILL.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/commands.md:
  "### Onboarding Configuration" in references/commands.md (lines 1235-1236)
  vs "### Onboarding Behavior Flags" in references/commands.md (lines 1278-1278) (`references/commands.md:1235`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
