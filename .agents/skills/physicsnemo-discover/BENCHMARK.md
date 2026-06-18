# Evaluation Report

Evaluation of the `physicsnemo-discover` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `physicsnemo-discover`
- Evaluation date: 2026-05-29
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 4 evaluation tasks
- Attempts per task: 2
- Pass threshold: 50%
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

- `security` (Security): checks for unsafe operations, secret leakage, and unauthorized access.
- `skill_execution` (Skill Execution): verifies that the agent loaded the expected skill and workflow.
- `skill_efficiency` (Efficiency): checks routing quality, decoy avoidance, and redundant tool usage.
- `accuracy` (Accuracy): grades final-answer correctness against the reference answer.
- `goal_accuracy` (Goal Accuracy): checks whether the overall user task completed successfully.
- `behavior_check` (Behavior Check): verifies expected behavior steps, including safety expectations.
- `token_efficiency` (Token Efficiency): compares token usage with and without the skill.

## Test Tasks

The benchmark dataset contained 4 evaluation tasks:

- Positive tasks: 2 tasks where the skill was expected to activate.
- Negative tasks: 2 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 8 | 100% (+0%) | 100% (+0%) |
| Correctness | 8 | 99% (+10%) | 87% (-0%) |
| Discoverability | 8 | 99% (+34%) | 81% (+3%) |
| Effectiveness | 8 | 87% (-9%) | 76% (-5%) |
| Efficiency | 8 | 86% (+28%) | 73% (+3%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 10 total findings.

Top findings:

- MEDIUM QUALITY/quality_discoverability: Description contains vague words (`skills/physicsnemo-discover/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/physicsnemo-discover/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/physicsnemo-discover/SKILL.md`)
- MEDIUM SECURITY/Unknown (SDI-2): The skill instructs an agent to shallow-clone an external Git repository (https://github.com/NVIDIA/physicsnemo) into a  (`SKILL.md:37`)
- LOW QUALITY/quality_discoverability: Description very long (504 chars, recommend 50-150) (`skills/physicsnemo-discover/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation passed. NVSkills-Eval ran 2 checks and found 0 total findings.

Notable observations:

- Context Deduplication: Collected 3 file(s)
- Inter-Skill Deduplication: Parsed skill 'physicsnemo-discover': 504 char description

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
