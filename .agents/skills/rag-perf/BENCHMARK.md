# Evaluation Report

Evaluation of the `rag-perf` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `rag-perf`
- Evaluation date: 2026-05-29
- NVSkills-Eval profile: `external`
- Overall verdict: PASS
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 5 total findings.

Top findings:

- MEDIUM PII/phone_numbers: US phone number pattern (`references/synthetic-generation.md:85`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in config-schema.md (`skills/rag-perf/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (241 chars, recommend 50-150) (`skills/rag-perf/SKILL.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'BENCHMARK.md' in skill root (`skills/rag-perf/BENCHMARK.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'eval' in skill root (`skills/rag-perf/eval`)

## Tier 2: Deduplication Summary

Tier 2 validation passed. NVSkills-Eval ran 2 checks and found 0 total findings.

Notable observations:

- Context Deduplication: Collected 4 file(s)
- Inter-Skill Deduplication: Parsed skill 'rag-perf': 241 char description

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
