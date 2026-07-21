# Evaluation Report

Evaluation of the `nemoclaw-user-guide` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nemoclaw-user-guide`
- Evaluation date: 2026-07-17
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Overall verdict: PASS

## Agents Used

- `claude-code`
- `codex`

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

The evaluation dataset was not available in this report payload.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | N/A | N/A | N/A |
| Correctness | N/A | N/A | N/A |
| Discoverability | N/A | N/A | N/A |
| Effectiveness | N/A | N/A | N/A |
| Efficiency | N/A | N/A | N/A |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 1 checks and found 3 total findings.

Top findings:

- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/nemoclaw-user-guide/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/nemoclaw-user-guide/SKILL.md`)
- MEDIUM SCHEMA/author_missing: Author not specified in metadata (`skills/nemoclaw-user-guide/SKILL.md`)

## Tier 2: Deduplication Summary

This tier was not run or did not produce findings in this report.

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
