# Evaluation Report

Evaluation of the `cuopt-numerical-optimization-api-python` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `cuopt-numerical-optimization-api-python`
- Evaluation date: 2026-06-10
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Dataset: 4 evaluation tasks
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

The benchmark dataset contained 4 evaluation tasks:

- Positive tasks: 4 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 4 | 100% (+0%) | 100% (+0%) |
| Correctness | 4 | 65% (+29%) | 64% (+8%) |
| Discoverability | 4 | 50% (+44%) | 44% (+25%) |
| Effectiveness | 4 | 66% (+17%) | 56% (+3%) |
| Efficiency | 4 | 61% (+37%) | 44% (+17%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 10 total findings.

Top findings:

- MEDIUM PII/phone_numbers: International phone number (`assets/mps_solver/results.md:48`)
- MEDIUM PII/phone_numbers: International phone number (`assets/mps_solver/results.md:69`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/cuopt-numerical-optimization-api-python/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/cuopt-numerical-optimization-api-python/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description doesn't mention WHEN to use this skill (`skills/cuopt-numerical-optimization-api-python/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 9 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across assets/lp_warmstart/README.md and assets/lp_warmstart/model.py:
  "# LP PDLP Warmstart" in assets/lp_warmstart/README.md (lines 1-5)
  vs "(module docstring)" in assets/lp_warmstart/model.py (lines 1-4) (`assets/lp_warmstart/README.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and assets/mps_solver/README.md and references/qp_examples.md:
  "# Solve" in SKILL.md (lines 63-67)
  vs "# Configure and solve" in assets/mps_solver/README.md (lines 76-80)
  vs "# Solve" in references/qp_examples.md (lines 47-51) (`SKILL.md:63`)
- HIGH DUPLICATE/duplicate: Duplicate content found across assets/milp_basic/README.md and assets/milp_basic/model.py:
  "# Minimal MILP" in assets/milp_basic/README.md (lines 1-10)
  vs "(module docstring)" in assets/milp_basic/model.py (lines 1-6) (`assets/milp_basic/README.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found within SKILL.md:
  "# MILP-specific settings" in SKILL.md (lines 94-100)
  vs "# MILP gap tolerance (stop when within X% of optimal)" in SKILL.md (lines 220-222) (`SKILL.md:94`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and assets/mps_solver/README.md:
  "# Check status (CRITICAL: use PascalCase!)" in SKILL.md (lines 68-74)
  vs "# ✅ CORRECT" in SKILL.md (lines 148-151)
  vs "# Check solution" in assets/mps_solver/README.md (lines 81-85) (`SKILL.md:68`)
