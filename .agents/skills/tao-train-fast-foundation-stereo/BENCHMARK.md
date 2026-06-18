# Evaluation Report

Evaluation of the `tao-train-fast-foundation-stereo` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tao-train-fast-foundation-stereo`
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
| Correctness | 2 | 85% (+80%) | 58% (+58%) |
| Discoverability | 2 | 93% (+92%) | 48% (+48%) |
| Effectiveness | 2 | 70% (+53%) | 61% (+46%) |
| Efficiency | 2 | 81% (+54%) | 62% (+34%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 8 total findings.

Top findings:

- MEDIUM SCHEMA/folder_hierarchy: Unexpected nesting depth for general skill (`skills/models/tao-train-fast-foundation-stereo`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/models/tao-train-fast-foundation-stereo/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/models/tao-train-fast-foundation-stereo/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (457 chars, recommend 50-150) (`skills/models/tao-train-fast-foundation-stereo/SKILL.md`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/models/tao-train-fast-foundation-stereo/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 6 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/tao-deploy-fast-foundation-stereo.md and references/troubleshooting.md:
  "## Common errors" in references/tao-deploy-fast-foundation-stereo.md (lines 265-265)
  vs "# FastFoundationStereo Troubleshooting" in references/troubleshooting.md (lines 4-4) (`references/tao-deploy-fast-foundation-stereo.md:265`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/tao-deploy-fast-foundation-stereo.md and references/troubleshooting.md:
  "## Common errors" in references/tao-deploy-fast-foundation-stereo.md (lines 271-271)
  vs "# FastFoundationStereo Troubleshooting" in references/troubleshooting.md (lines 13-13) (`references/tao-deploy-fast-foundation-stereo.md:271`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/parent-model-inference.md:
  "## Spec Param / Parent Model Inference" in SKILL.md (lines 192-196)
  vs "# FastFoundationStereo Spec Param / Parent Model Inference" in references/parent-model-inference.md (lines 30-30) (`SKILL.md:192`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/tao-deploy-fast-foundation-stereo.md:
  "### Recommended deployment paths" in references/tao-deploy-fast-foundation-stereo.md (lines 178-186)
  vs "### Implication for fp16 deploy" in references/tao-deploy-fast-foundation-stereo.md (lines 187-193) (`references/tao-deploy-fast-foundation-stereo.md:178`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/tao-deploy-fast-foundation-stereo.md:
  "## Common errors" in references/tao-deploy-fast-foundation-stereo.md (lines 267-270)
  vs "## Common errors" in references/tao-deploy-fast-foundation-stereo.md (lines 272-275) (`references/tao-deploy-fast-foundation-stereo.md:267`)
