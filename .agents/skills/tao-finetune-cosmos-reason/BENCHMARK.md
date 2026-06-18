# Evaluation Report

Evaluation of the `tao-finetune-cosmos-reason` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tao-finetune-cosmos-reason`
- Evaluation date: 2026-06-06
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Dataset: 1 evaluation tasks
- Attempts per task: 2
- Pass threshold: 50%
- Overall verdict: FAIL
The skill should be reviewed before NVSkills-Eval publication. **Skill owners should address the applicable findings below and rerun NVSkills-Eval to refresh this benchmark.**

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

The benchmark dataset contained 1 evaluation tasks:

- Positive tasks: 1 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 2 | 100% (+0%) | 100% (+0%) |
| Correctness | 2 | 100% (+100%) | 58% (+40%) |
| Discoverability | 2 | 86% (+86%) | 48% (+17%) |
| Effectiveness | 2 | 86% (+59%) | 57% (+46%) |
| Efficiency | 2 | 70% (+43%) | 62% (+17%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 14 total findings.

Top findings:

- MEDIUM QUALITY/quality_correctness: No documented scripts in table format (`skills/models/tao-finetune-cosmos-reason/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: Instructions don't mention 'run_script' (`skills/models/tao-finetune-cosmos-reason/SKILL.md`)
- MEDIUM SCHEMA/folder_hierarchy: Unexpected nesting depth for general skill (`skills/models/tao-finetune-cosmos-reason`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/models/tao-finetune-cosmos-reason/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/models/tao-finetune-cosmos-reason/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 2 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/scripts/analyze_gaps.py and scripts/analyze_gaps.py:
  "(module docstring)" in references/scripts/analyze_gaps.py (lines 1-11)
  vs "(module docstring)" in scripts/analyze_gaps.py (lines 1-11) (`references/scripts/analyze_gaps.py:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/scripts/analyze_gaps.py and scripts/analyze_gaps.py:
  "_find_results_json()" in references/scripts/analyze_gaps.py (lines 33-54)
  vs "_find_results_json()" in scripts/analyze_gaps.py (lines 33-54) (`references/scripts/analyze_gaps.py:33`)
