# Evaluation Report

Evaluation of the `vss-deploy-detection-tracking-2d` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `vss-deploy-detection-tracking-2d`
- Evaluation date: 2026-06-08
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Dataset: 2 evaluation tasks
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

The benchmark dataset contained 2 evaluation tasks:

- Positive tasks: 1 tasks where the skill was expected to activate.
- Negative tasks: 1 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 4 | 100% (+0%) | 100% (+0%) |
| Correctness | 4 | 69% (+33%) | 96% (+36%) |
| Discoverability | 4 | 97% (+41%) | 92% (+22%) |
| Effectiveness | 4 | 54% (+24%) | 74% (+29%) |
| Efficiency | 4 | 86% (+29%) | 80% (+15%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 5 total findings.

Top findings:

- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/vss-deploy-detection-tracking-2d/SKILL.md`)
- MEDIUM QUALITY/quality_discoverability: Description contains vague words (`skills/vss-deploy-detection-tracking-2d/SKILL.md`)
- MEDIUM SCHEMA/author_missing: Author not specified in metadata (`skills/vss-deploy-detection-tracking-2d/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (366 chars, recommend 50-150) (`skills/vss-deploy-detection-tracking-2d/SKILL.md`)
- LOW SCRIPT_LINT/magic_numbers: calibration_manager.py contains magic numbers (`skills/vss-deploy-detection-tracking-2d/scripts/calibration_manager.py`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 2 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/deploy-vss-detection-tracking-2d.md and references/start-app.md and references/ux-conventions.md:
  "### Universal box format (every step exit)" in references/deploy-vss-detection-tracking-2d.md (lines 622-627)
  vs "### Pre-rendered top + bottom borders — COPY VERBATIM" in references/deploy-vss-detection-tracking-2d.md (lines 817-821)
  vs "### Worked example — warehouse-2d (eglsink + dynamic + cache hit, batch=3)" in references/start-app.md (lines 318-322)
  vs "## Final deploy receipt — the "Perception Application — Results" box" in references/ux-conventions.md (lines 180-189) (`references/deploy-vss-detection-tracking-2d.md:622`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/next-steps.md and references/troubleshooting.md:
  "### Bonus quick-checks (liveness / readiness / startup — shown only when explicitly asked)" in references/next-steps.md (lines 305-311)
  vs "# Readiness — pipeline is ready (after streams attached)" in references/troubleshooting.md (lines 14-15) (`references/next-steps.md:305`)
