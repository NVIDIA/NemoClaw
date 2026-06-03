# Evaluation Report

Evaluation of the `nemoclaw-user-overview` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nemoclaw-user-overview`
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

- MEDIUM QUALITY/quality_correctness: Guide-only skill has very little content (13 lines) (`skills/nemoclaw-user-overview/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/nemoclaw-user-overview/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.tags' (`skills/nemoclaw-user-overview/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in how-it-works.md (`skills/nemoclaw-user-overview/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/nemoclaw-user-overview/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 1 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/ecosystem.md and references/how-it-works.md and references/overview.md and references/release-notes.md:
  "(preamble)" in SKILL.md (lines 1-3)
  vs "(preamble)" in references/ecosystem.md (lines 1-2)
  vs "(preamble)" in references/how-it-works.md (lines 1-2)
  vs "(preamble)" in references/overview.md (lines 1-2)
  vs "(preamble)" in references/release-notes.md (lines 1-2) (`SKILL.md:1`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
