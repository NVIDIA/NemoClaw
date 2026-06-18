# Evaluation Report

Evaluation of the `rag-eval` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `rag-eval`
- Evaluation date: 2026-05-29
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 3 total findings.

Top findings:

- MEDIUM QUALITY/quality_efficiency: Deeply nested references in benchmark-execution.md (`skills/rag-eval/SKILL.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'BENCHMARK.md' in skill root (`skills/rag-eval/BENCHMARK.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'eval' in skill root (`skills/rag-eval/eval`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 2 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/benchmark-execution.md and references/evaluate-rag-cli.md:
  "### Toggle pipeline stages" in references/benchmark-execution.md (lines 94-104)
  vs "### Pipeline stage toggles" in references/evaluate-rag-cli.md (lines 37-47) (`references/benchmark-execution.md:94`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/result-analysis.md:
  "## Per-query table with worst-accuracy rows" in references/result-analysis.md (lines 7-34)
  vs "## Markdown table of worst queries" in references/result-analysis.md (lines 58-75) (`references/result-analysis.md:7`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
