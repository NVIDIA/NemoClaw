# Evaluation Report

Evaluation of the `tilegym-improve-cutile-kernel-perf` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tilegym-improve-cutile-kernel-perf`
- Evaluation date: 2026-06-10
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Dataset: 5 evaluation tasks
- Attempts per task: 1
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

The benchmark dataset contained 5 evaluation tasks:

- Positive tasks: 1 tasks where the skill was expected to activate.
- Negative tasks: 4 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 5 | 100% (+0%) | 100% (+0%) |
| Correctness | 5 | 88% (+8%) | 99% (+12%) |
| Discoverability | 5 | 80% (+0%) | 99% (+7%) |
| Effectiveness | 5 | 85% (+12%) | 97% (+17%) |
| Efficiency | 5 | 83% (-0%) | 97% (+7%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation reported findings. NVSkills-Eval ran 9 checks and found 37 total findings.

Top findings:

- MEDIUM PII/phone_numbers: International phone number (`references/perf-knobs-catalog.md:38`)
- MEDIUM PII/phone_numbers: International phone number (`references/perf-knobs-catalog.md:103`)
- MEDIUM PII/phone_numbers: International phone number (`references/perf-knobs-catalog.md:178`)
- MEDIUM PII/phone_numbers: International phone number (`references/perf-knobs-catalog.md:179`)
- MEDIUM PII/phone_numbers: International phone number (`references/perf-knobs-catalog.md:180`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 4 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/ir-dump-guide.md and references/optimization-playbook.md:
  "### Mitigate" in references/ir-dump-guide.md (lines 209-219)
  vs "### Mitigate" in references/optimization-playbook.md (lines 323-332) (`references/ir-dump-guide.md:209`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/optimization-playbook.md and references/perf-knobs-catalog.md:
  "## Optimization D: Add TF32 Dtype Guard for MMA" in references/optimization-playbook.md (lines 181-187)
  vs "# Cast FP32 → TF32 for tensor core utilization" in references/optimization-playbook.md (lines 200-209)
  vs "## 9. TF32 Guard for MMA" in references/perf-knobs-catalog.md (lines 126-142) (`references/optimization-playbook.md:181`)
- LOW DUPLICATE/duplicate: Duplicate content found within references/cutile-api-reference.md:
  "# Prefer Python arithmetic on host (simpler, no ct import needed)" in references/cutile-api-reference.md (lines 468-470)
  vs "# Host — prefer Python arithmetic:" in references/cutile-api-reference.md (lines 652-653)
  vs "# CORRECT — tuple of 1, 2, or 3 ints" in references/cutile-api-reference.md (lines 725-730) (`references/cutile-api-reference.md:468`)
- LOW DUPLICATE/duplicate: Duplicate content found within references/optimization-playbook.md:
  "### Before" in references/optimization-playbook.md (lines 188-194)
  vs "### After" in references/optimization-playbook.md (lines 195-199) (`references/optimization-playbook.md:188`)
