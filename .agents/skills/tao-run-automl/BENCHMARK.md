# Evaluation Report

Evaluation of the `tao-run-automl` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tao-run-automl`
- Evaluation date: 2026-06-06
- NVSkills-Eval profile: `external`
- Environment: `astra-sandbox`
- Dataset: 1 evaluation tasks
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

The benchmark dataset contained 1 evaluation tasks:

- Positive tasks: 1 tasks where the skill was expected to activate.
- Negative tasks: 0 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 2 | 100% (+0%) | 100% (+0%) |
| Correctness | 2 | 75% (+75%) | 92% (+92%) |
| Discoverability | 2 | 44% (+44%) | 97% (+97%) |
| Effectiveness | 2 | 87% (+73%) | 71% (+57%) |
| Efficiency | 2 | 51% (+24%) | 96% (+68%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 14 total findings.

Top findings:

- MEDIUM SCHEMA/folder_hierarchy: Unexpected nesting depth for general skill (`skills/applications/tao-run-automl`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/applications/tao-run-automl/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/applications/tao-run-automl/SKILL.md`)
- MEDIUM SECURITY/Unknown (SQP-2): The documentation describes sending hyperparameter search data (training specs, metric results, parameter ranges, and op (`references/automl-settings.md:98`)
- MEDIUM SECURITY/Unknown (SQP-2): The example conversation demonstrates a user passing a plaintext API key ('sk-abc123') directly in chat input, which the (`references/examples.md:34`)

## Tier 2: Deduplication Summary

Tier 2 validation passed with observations. NVSkills-Eval ran 2 checks and found 1 total findings.

Top findings:

- LOW DUPLICATE/duplicate: Duplicate content found within references/hooks-and-wandb.md:
  "# or (when reinstalling tao-run-automl with the wandb extra — append ,wandb to your platform extra):" in references/hooks-and-wandb.md (lines 62-62)
  vs "#   pip install "$("${TAO_SKILL_BANK_PATH:?}/scripts/resolve_versions_key.py" wheels.tao_automl_lepton | sed 's/]/,wandb]/')"" in references/hooks-and-wandb.md (lines 63-65) (`references/hooks-and-wandb.md:62`)

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
