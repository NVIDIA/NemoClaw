# Evaluation Report

Evaluation of the `tao-port-huggingface-model` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tao-port-huggingface-model`
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
| Correctness | 2 | 50% (+50%) | 97% (+97%) |
| Discoverability | 2 | 0% (+0%) | 84% (+84%) |
| Effectiveness | 2 | 91% (+77%) | 81% (+71%) |
| Efficiency | 2 | 27% (-0%) | 79% (+50%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation reported findings. NVSkills-Eval ran 9 checks and found 14 total findings.

Top findings:

- MEDIUM QUALITY/quality_efficiency: Deeply nested references in phase-3-implementation.md (`skills/applications/tao-port-huggingface-model/SKILL.md`)
- MEDIUM SCHEMA/folder_hierarchy: Unexpected nesting depth for general skill (`skills/applications/tao-port-huggingface-model`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/applications/tao-port-huggingface-model/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/applications/tao-port-huggingface-model/SKILL.md`)
- MEDIUM SECURITY/Unknown (SQP-2): The skill orchestrates Docker container execution with bind-mounted local directories, GPU passthrough, and package inst (`SKILL.md:88`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 17 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/phase-4-deploy.md and references/workflow-consistency.md:
  "### Step 9 — Implement TensorRT Engine Builder (`tao-deploy`)" in references/phase-4-deploy.md (lines 106-118)
  vs "### Standard EvaluateConfig / InferenceConfig fields:" in references/workflow-consistency.md (lines 175-184)
  vs "### Standard GenTrtEngineConfig fields:" in references/workflow-consistency.md (lines 198-218)
  vs "### gen_trt_engine.yaml:" in references/workflow-consistency.md (lines 381-394) (`references/phase-4-deploy.md:106`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/docker-patterns.md and references/execution-and-debugging.md and references/hf-inspection.md and references/repo-structure.md and references/tao-patterns.md and references/task-type-guide.md and references/workflow-consistency.md:
  "(preamble)" in SKILL.md (lines 1-17)
  vs "(preamble)" in references/docker-patterns.md (lines 1-16)
  vs "(preamble)" in references/execution-and-debugging.md (lines 1-16)
  vs "(preamble)" in references/hf-inspection.md (lines 1-16)
  vs "(preamble)" in references/repo-structure.md (lines 1-16)
  vs "(preamble)" in references/tao-patterns.md (lines 1-16)
  vs "(preamble)" in references/task-type-guide.md (lines 1-16)
  vs "(preamble)" in references/workflow-consistency.md (lines 1-16) (`SKILL.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/phase-4-deploy.md and references/workflow-consistency.md:
  "### Step 9 — Implement TensorRT Engine Builder (`tao-deploy`)" in references/phase-4-deploy.md (lines 94-102)
  vs "# Build engine" in references/workflow-consistency.md (lines 706-720) (`references/phase-4-deploy.md:94`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/phase-3-implementation.md and references/phase-5-packaging.md and references/repo-structure.md and references/tao-patterns.md and references/workflow-consistency.md:
  "## Phase 5 — Packaging & L0 Testing" in SKILL.md (lines 105-112)
  vs "# Then in experiment_spec.yaml: model.backbone.pretrained_backbone_path: /path/to/newarch_hf_weights.pth" in references/phase-3-implementation.md (lines 508-511)
  vs "### Step 12 — Package Native DL Backend (`tao-pytorch`)" in references/phase-5-packaging.md (lines 21-31)
  vs "### Step 13 — Package Deployment Backend (`tao-deploy`)" in references/phase-5-packaging.md (lines 32-40)
  vs "### `tao-pytorch/setup.py`" in references/repo-structure.md (lines 181-190)
  vs "### `tao-deploy/setup.py`" in references/repo-structure.md (lines 191-202)
  vs "### CLI Entrypoint (model-level CLI)" in references/tao-patterns.md (lines 331-347)
  vs "# In tao-pytorch/setup.py, entry_points.console_scripts:" in references/tao-patterns.md (lines 477-480)
  vs "# In tao-deploy/setup.py, entry_points.console_scripts:" in references/tao-patterns.md (lines 483-490)
  vs "# tao-pytorch entrypoint: nvidia_tao_pytorch/cv/<model_name>/entrypoint/<model_name>.py" in references/workflow-consistency.md (lines 73-84)
  vs "# tao-deploy entrypoint: nvidia_tao_deploy/cv/<model_name>/entrypoint/<model_name>.py" in references/workflow-consistency.md (lines 85-101) (`SKILL.md:105`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/phase-4-deploy.md and references/workflow-consistency.md:
  "### Step 9 — Implement TensorRT Engine Builder (`tao-deploy`)" in references/phase-4-deploy.md (lines 119-132)
  vs "### Step 9 — Implement TensorRT Engine Builder (`tao-deploy`)" in references/phase-4-deploy.md (lines 133-149)
  vs "### inference.yaml:" in references/workflow-consistency.md (lines 395-409)
  vs "### evaluate.yaml:" in references/workflow-consistency.md (lines 410-431) (`references/phase-4-deploy.md:119`)
