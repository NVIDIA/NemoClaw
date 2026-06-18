# Evaluation Report

Evaluation of the `nv-generate-mr-brain-finetune` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nv-generate-mr-brain-finetune`
- Evaluation date: 2026-05-31
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 2 evaluation tasks
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

The benchmark dataset contained 2 evaluation tasks:

- Positive tasks: 2 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 4 | 100% (+50%) | 100% (+0%) |
| Correctness | 4 | 95% (-1%) | 95% (+57%) |
| Discoverability | 4 | 89% (+11%) | 71% (+10%) |
| Effectiveness | 4 | 77% (+10%) | 72% (+62%) |
| Efficiency | 4 | 65% (+15%) | 54% (+5%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 8 total findings.

Top findings:

- MEDIUM SECURITY/subprocess module call (AST4): Dangerous Code Execution:     return subprocess.run(
        command,
        cwd=str(upstream_root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    ) (`scripts/run_mr_brain_finetune.py:431`)
- MEDIUM SECURITY/Unknown (LP3): MCP Least Privilege: The skill uses Bash and performs environment variable access, file reads/writes, and shell execution, but does not decla (`SKILL.md:1`)
- LOW SCHEMA/unexpected_file: Unexpected 'fixtures' in skill root (`skills/nv-generate-mr-brain-finetune/fixtures`)
- LOW SCHEMA/unexpected_file: Unexpected 'skill_manifest.yaml' in skill root (`skills/nv-generate-mr-brain-finetune/skill_manifest.yaml`)
- LOW SCHEMA/unexpected_file: Unexpected 'validators' in skill root (`skills/nv-generate-mr-brain-finetune/validators`)

## Tier 2: Deduplication Summary

Tier 2 validation passed. NVSkills-Eval ran 2 checks and found 0 total findings.

Notable observations:

- Context Deduplication: Collected 4 file(s)
- Inter-Skill Deduplication: Parsed skill 'nv-generate-mr-brain-finetune': 129 char description

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
