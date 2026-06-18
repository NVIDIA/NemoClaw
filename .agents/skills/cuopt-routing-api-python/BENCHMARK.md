# Evaluation Report

Evaluation of the `cuopt-routing-api-python` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `cuopt-routing-api-python`
- Evaluation date: 2026-05-29
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 1 evaluation tasks
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

The benchmark dataset contained 1 evaluation tasks:

- Positive tasks: 1 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 2 | 100% (+0%) | 100% (+0%) |
| Correctness | 2 | 100% (+0%) | 95% (+3%) |
| Discoverability | 2 | 100% (+0%) | 70% (-5%) |
| Effectiveness | 2 | 83% (+14%) | 83% (+12%) |
| Efficiency | 2 | 93% (-0%) | 56% (-5%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 8 total findings.

Top findings:

- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/cuopt-routing-api-python/SKILL.md`)
- MEDIUM SECURITY/Unknown (SQP-2): Binding the cuOpt server to 0.0.0.0 exposes it on all network interfaces, making it accessible to any host that can reac (`references/server_examples.md:7`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/cuopt-routing-api-python/SKILL.md`)
- LOW QUALITY/quality_reliability: No prerequisites/requirements documented (`skills/cuopt-routing-api-python/SKILL.md`)
- LOW QUALITY/quality_reliability: No limitations documented (`skills/cuopt-routing-api-python/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 4 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within references/server_examples.md:
  "# Poll for solution" in references/server_examples.md (lines 45-51)
  vs "# Poll for solution" in references/server_examples.md (lines 156-162) (`references/server_examples.md:45`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/examples.md:
  "# Capacities" in SKILL.md (lines 30-35)
  vs "# Add capacity dimension (name, demand_per_order, capacity_per_vehicle)" in references/examples.md (lines 73-75)
  vs "# Add capacity dimension" in references/examples.md (lines 156-158) (`SKILL.md:30`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/examples.md and references/server_examples.md:
  "## Additional References (tested in CI)" in references/examples.md (lines 237-249)
  vs "## Additional References (tested in CI)" in references/server_examples.md (lines 193-204) (`references/examples.md:237`)
- HIGH DUPLICATE/duplicate: Duplicate content found across assets/pdp_basic/README.md and assets/pdp_basic/model.py:
  "# Pickup-Delivery (PDP)" in assets/pdp_basic/README.md (lines 1-7)
  vs "(module docstring)" in assets/pdp_basic/model.py (lines 1-2) (`assets/pdp_basic/README.md:1`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
