# Evaluation Report

Evaluation of the `tao-finetune-huggingface-model` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tao-finetune-huggingface-model`
- Evaluation date: 2026-06-05
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
| Correctness | 2 | 75% (+75%) | 97% (+97%) |
| Discoverability | 2 | 44% (+44%) | 97% (+97%) |
| Effectiveness | 2 | 89% (+75%) | 80% (+61%) |
| Efficiency | 2 | 51% (+24%) | 96% (+68%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 22 total findings.

Top findings:

- MEDIUM PII/phone_numbers: International phone number (`references/tao-rerun-segformer-foodseg103.md:53`)
- MEDIUM PII/phone_numbers: International phone number (`references/tao-rerun-segformer-foodseg103.md:54`)
- MEDIUM PII/phone_numbers: International phone number (`references/tao-rerun-convnext-cifar10.md:72`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in execution-platform.md (`skills/applications/tao-finetune-huggingface-model/SKILL.md`)
- MEDIUM SCHEMA/folder_hierarchy: Unexpected nesting depth for general skill (`skills/applications/tao-finetune-huggingface-model`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 13 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within references/cv-scripts.md:
  "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/cv-scripts.md (lines 633-639)
  vs "## inference.py" in references/cv-scripts.md (lines 735-741) (`references/cv-scripts.md:633`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and examples/README.md and references/compat-workarounds.md and references/core-rules.md and references/cv-scripts.md and references/dataset-patterns.md and references/dataset-recommendations.md and references/dataset-sources.md and references/deliverables.md and references/docker-runs.md and references/error-playbook.md and references/execution-platform.md and references/hardware-audit-ngc.md and references/hardware-container.md and references/hub-push.md and references/model-discovery.md and references/pipeline-skill-template.md and references/progress-tracking.md and references/project-scaffold.md and references/reference-index.md and references/reporting.md and references/research-priorities.md and references/step1-probes.md and references/testing.md and references/vlm-scripts.md:
  "(preamble)" in SKILL.md (lines 1-17)
  vs "(preamble)" in examples/README.md (lines 1-16)
  vs "(preamble)" in references/compat-workarounds.md (lines 1-16)
  vs "(preamble)" in references/core-rules.md (lines 1-16)
  vs "(preamble)" in references/cv-scripts.md (lines 1-16)
  vs "(preamble)" in references/dataset-patterns.md (lines 1-16)
  vs "(preamble)" in references/dataset-recommendations.md (lines 1-16)
  vs "(preamble)" in references/dataset-sources.md (lines 1-16)
  vs "(preamble)" in references/deliverables.md (lines 1-16)
  vs "(preamble)" in references/docker-runs.md (lines 1-16)
  vs "(preamble)" in references/error-playbook.md (lines 1-16)
  vs "(preamble)" in references/execution-platform.md (lines 1-16)
  vs "(preamble)" in references/hardware-audit-ngc.md (lines 1-16)
  vs "(preamble)" in references/hardware-container.md (lines 1-16)
  vs "(preamble)" in references/hub-push.md (lines 1-16)
  vs "(preamble)" in references/model-discovery.md (lines 1-16)
  vs "(preamble)" in references/pipeline-skill-template.md (lines 1-16)
  vs "(preamble)" in references/progress-tracking.md (lines 1-16)
  vs "(preamble)" in references/project-scaffold.md (lines 1-16)
  vs "(preamble)" in references/reference-index.md (lines 1-16)
  vs "(preamble)" in references/reporting.md (lines 1-16)
  vs "(preamble)" in references/research-priorities.md (lines 1-16)
  vs "(preamble)" in references/step1-probes.md (lines 1-16)
  vs "(preamble)" in references/testing.md (lines 1-16)
  vs "(preamble)" in references/vlm-scripts.md (lines 1-16) (`SKILL.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/cv-scripts.md and references/dataset-patterns.md and references/reporting.md and references/vlm-scripts.md:
  "## train.py" in references/cv-scripts.md (lines 354-357)
  vs "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/cv-scripts.md (lines 524-529)
  vs "## inference.py" in references/cv-scripts.md (lines 714-720)
  vs "## prepare_data.py — Universal Template" in references/dataset-patterns.md (lines 37-40)
  vs "# ── Arg parsing ──────────────────────────────────────────────────────────────" in references/reporting.md (lines 60-73)
  vs "## train.py" in references/vlm-scripts.md (lines 360-363)
  vs "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/vlm-scripts.md (lines 566-571) (`references/cv-scripts.md:354`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/cv-scripts.md and references/vlm-scripts.md:
  "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/cv-scripts.md (lines 641-643)
  vs "## inference.py" in references/cv-scripts.md (lines 752-755)
  vs "## train.py" in references/vlm-scripts.md (lines 370-371)
  vs "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/vlm-scripts.md (lines 588-590) (`references/cv-scripts.md:641`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/cv-scripts.md and references/dataset-patterns.md and references/reporting.md and references/vlm-scripts.md:
  "## train.py" in references/cv-scripts.md (lines 390-393)
  vs "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/cv-scripts.md (lines 629-632)
  vs "## inference.py" in references/cv-scripts.md (lines 731-734)
  vs "## prepare_data.py — Universal Template" in references/dataset-patterns.md (lines 72-75)
  vs "# ── Main ──────────────────────────────────────────────────────────────────────" in references/reporting.md (lines 334-337)
  vs "## train.py" in references/vlm-scripts.md (lines 453-456)
  vs "## run_eval.py (NOT `evaluate.py` — collides with HF `evaluate` library)" in references/vlm-scripts.md (lines 572-575) (`references/cv-scripts.md:390`)
