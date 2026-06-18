# Evaluation Report

Evaluation of the `deepstream-import-vision-model` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `deepstream-import-vision-model`
- Evaluation date: 2026-05-28
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 5 evaluation tasks
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

- `skill_execution` (Skill Execution): verifies that the agent loaded the expected skill and workflow.
- `skill_efficiency` (Efficiency): checks routing quality, decoy avoidance, and redundant tool usage.
- `accuracy` (Accuracy): grades final-answer correctness against the reference answer.
- `goal_accuracy` (Goal Accuracy): checks whether the overall user task completed successfully.
- `behavior_check` (Behavior Check): verifies expected behavior steps, including safety expectations.
- `token_efficiency` (Token Efficiency): compares token usage with and without the skill.

## Test Tasks

The benchmark dataset contained 5 evaluation tasks:

- Positive tasks: 3 tasks where the skill was expected to activate.
- Negative tasks: 2 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 8 | 68% (+13%) | 72% (+18%) |
| Correctness | 8 | 83% (-2%) | 89% (+13%) |
| Discoverability | 8 | 61% (+0%) | 80% (+1%) |
| Effectiveness | 8 | 80% (+2%) | 81% (+17%) |
| Efficiency | 8 | 52% (+2%) | 70% (+2%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 12 total findings.

Top findings:

- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.tags' (`skills/deepstream-import-vision-model/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/deepstream-import-vision-model/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/deepstream-import-vision-model/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (285 chars, recommend 50-150) (`skills/deepstream-import-vision-model/SKILL.md`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/deepstream-import-vision-model/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 7 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across scripts/deepstream/benchmark-ds.sh and scripts/deepstream/ds-kitti-dump.sh and scripts/deepstream/ds-perf-run.sh and scripts/deepstream/ds-single-stream.sh and scripts/deepstream/ds-sweep.sh and scripts/deepstream/extract-frame.sh and scripts/engine/benchmark-trtexec.sh and scripts/model/cleanup.sh and scripts/model/hf-download-config.sh and scripts/model/hf-list-files.sh and scripts/model/ngc-download.sh and scripts/model/ngc-list-files.sh and scripts/model/safetensors-to-onnx.sh and scripts/report/md-to-pdf.sh:
  "(comment)" in scripts/deepstream/benchmark-ds.sh (lines 3-16)
  vs "(comment)" in scripts/deepstream/ds-kitti-dump.sh (lines 3-16)
  vs "(comment)" in scripts/deepstream/ds-perf-run.sh (lines 3-16)
  vs "(comment)" in scripts/deepstream/ds-single-stream.sh (lines 3-16)
  vs "(comment)" in scripts/deepstream/ds-sweep.sh (lines 3-16)
  vs "(comment)" in scripts/deepstream/extract-frame.sh (lines 3-16)
  vs "(comment)" in scripts/engine/benchmark-trtexec.sh (lines 3-16)
  vs "(comment)" in scripts/model/cleanup.sh (lines 3-16)
  vs "(comment)" in scripts/model/hf-download-config.sh (lines 3-16)
  vs "(comment)" in scripts/model/hf-list-files.sh (lines 3-16)
  vs "(comment)" in scripts/model/ngc-download.sh (lines 3-16)
  vs "(comment)" in scripts/model/ngc-list-files.sh (lines 3-16)
  vs "(comment)" in scripts/model/safetensors-to-onnx.sh (lines 3-16)
  vs "(comment)" in scripts/report/md-to-pdf.sh (lines 3-16) (`scripts/deepstream/benchmark-ds.sh:3`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/pipeline-run.md:
  "# Hard constraint: num_streams <= engine max batch size — always" in references/pipeline-run.md (lines 437-442)
  vs "# Hard constraint: num_streams <= engine max batch size — always" in references/pipeline-run.md (lines 458-463) (`references/pipeline-run.md:437`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/report-generation.md and scripts/deepstream/ds-perf-run.sh:
  "# Capture stream-0 instantaneous FPS (\K after `**PERF:`) — 1 value per line — so" in references/report-generation.md (lines 136-136)
  vs "(comment)" in scripts/deepstream/ds-perf-run.sh (lines 131-134) (`references/report-generation.md:136`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/pipeline-run.md:
  "# 2=DeepStream NMS (dense heads: YOLO, SSD). Use 4 if engine has fused NMS output" in references/pipeline-run.md (lines 225-244)
  vs "# 2=DeepStream NMS (dense heads: YOLO, SSD). Use 4 if engine has fused NMS output" in references/pipeline-run.md (lines 401-414) (`references/pipeline-run.md:225`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/model-acquire.md:
  "#### 2b-vi: onnxsim — Run After Export When Needed" in references/model-acquire.md (lines 273-282)
  vs "# Use the _sim.onnx for engine building if the original triggers ForeignNode errors" in references/model-acquire.md (lines 283-287) (`references/model-acquire.md:273`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
