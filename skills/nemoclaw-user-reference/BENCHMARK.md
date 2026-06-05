# Evaluation Report

Evaluation of the `nemoclaw-user-reference` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `nemoclaw-user-reference`
- Evaluation date: 2026-06-04
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
| Correctness | 2 | 100% (+62%) | 92% (+50%) |
| Discoverability | 2 | 100% (+38%) | 76% (+22%) |
| Effectiveness | 2 | 93% (+59%) | 91% (+54%) |
| Efficiency | 2 | 88% (+32%) | 67% (+24%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 13 total findings.

Top findings:

- MEDIUM PII/ip_addresses: Non-RFC1918 IP address (`references/troubleshooting.md:135`)
- MEDIUM QUALITY/quality_correctness: Guide-only skill has very little content (12 lines) (`skills/nemoclaw-user-reference/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/nemoclaw-user-reference/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in troubleshooting.md (`skills/nemoclaw-user-reference/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/nemoclaw-user-reference/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 3 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within references/commands.md:
  "#### `--from <Dockerfile>`" in references/commands.md (lines 298-334)
  vs "### `nemoclaw onboard --from`" in references/commands.md (lines 350-358) (`references/commands.md:298`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/commands.md:
  "#### `--resume` and `--fresh`" in references/commands.md (lines 124-127)
  vs "#### `--resume` and `--fresh`" in references/commands.md (lines 131-131) (`references/commands.md:124`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/commands.md:
  "#### `--resume` and `--fresh`" in references/commands.md (lines 208-211)
  vs "### `nemoclaw <name> channels add <channel>`" in references/commands.md (lines 881-884) (`references/commands.md:208`)
