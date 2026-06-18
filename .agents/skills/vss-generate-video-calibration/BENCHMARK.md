# Evaluation Report

Evaluation of the `vss-generate-video-calibration` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `vss-generate-video-calibration`
- Evaluation date: 2026-06-10
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Dataset: 3 evaluation tasks
- Attempts per task: 1
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

The benchmark dataset contained 3 evaluation tasks:

- Positive tasks: 3 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 3 | 100% (+0%) | 83% (-17%) |
| Correctness | 3 | 79% (+42%) | 61% (+26%) |
| Discoverability | 3 | 95% (+34%) | 62% (+10%) |
| Effectiveness | 3 | 36% (+30%) | 30% (+26%) |
| Efficiency | 3 | 80% (+23%) | 53% (+6%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 7 total findings.

Top findings:

- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/vss-generate-video-calibration/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in common-steps.md (`skills/vss-generate-video-calibration/SKILL.md`)
- MEDIUM SCHEMA/author_missing: Author not specified in metadata (`skills/vss-generate-video-calibration/SKILL.md`)
- MEDIUM SECURITY/Unknown (SQP-2): The RTSP capture script sets ssl_verify=False when communicating with the MS endpoint and handles RTSP URLs that may con (`references/rtsp.md:227`)
- MEDIUM SECURITY/Unknown (SQP-2): The skill automatically executes `curl -LsSf https://astral.sh/uv/install.sh | sh` without explicit user consent when th (`references/sample-dataset.md:132`)

## Tier 2: Deduplication Summary

Tier 2 validation passed. NVSkills-Eval ran 2 checks and found 0 total findings.

Notable observations:

- Context Deduplication: Collected 7 file(s)
- Inter-Skill Deduplication: Parsed skill 'vss-generate-video-calibration': 182 char description

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
