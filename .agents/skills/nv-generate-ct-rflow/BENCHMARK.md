# Evaluation Report

Evaluation of the `nv-generate-ct-rflow` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nv-generate-ct-rflow`
- Evaluation date: 2026-05-31
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 2 evaluation tasks
- Attempts per task: 2
- Pass threshold: 50%
- Overall verdict: FAIL

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

The benchmark dataset contained 2 evaluation tasks:

- Positive tasks: 2 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 4 | 100% (+0%) | 100% (+0%) |
| Correctness | 4 | 88% (+10%) | 76% (+26%) |
| Discoverability | 4 | 90% (-5%) | 70% (+14%) |
| Effectiveness | 4 | 64% (+3%) | 55% (+36%) |
| Efficiency | 4 | 69% (-5%) | 58% (+15%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 36 total findings.

Top findings:

- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`fixtures/ct_image_only_default.json:4`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`fixtures/ct_mask_lung_tumor.json:6`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/fov-and-downloads.md:16`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/fov-and-downloads.md:17`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/fov-and-downloads.md:18`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 1 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across scripts/run_ct_image.py and scripts/run_rflow_ct.py:
  "_load_config_override()" in scripts/run_ct_image.py (lines 118-136)
  vs "_load_config_override()" in scripts/run_rflow_ct.py (lines 112-131) (`scripts/run_ct_image.py:118`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
