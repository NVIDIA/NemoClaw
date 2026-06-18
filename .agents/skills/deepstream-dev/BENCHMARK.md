# Evaluation Report

Evaluation of the `deepstream-dev` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `deepstream-dev`
- Evaluation date: 2026-05-28
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 7 evaluation tasks
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

The benchmark dataset contained 7 evaluation tasks:

- Positive tasks: 5 tasks where the skill was expected to activate.
- Negative tasks: 2 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 8 | 74% (+9%) | 57% (-2%) |
| Correctness | 8 | 94% (+6%) | 88% (+9%) |
| Discoverability | 8 | 86% (+11%) | 76% (+9%) |
| Effectiveness | 8 | 81% (+6%) | 78% (+9%) |
| Efficiency | 8 | 72% (+12%) | 64% (+9%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 34 total findings.

Top findings:

- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/service_maker_api.md:804`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/service_maker_api.md:827`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/service_maker_api.md:829`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/service_maker_api.md:1279`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/use_cases_pipelines.md:842`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 34 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within references/metamux_config.md:
  "# default pts-tolerance is 60 ms." in references/metamux_config.md (lines 67-72)
  vs "# default pts-tolerance is 60 ms." in references/metamux_config.md (lines 125-130) (`references/metamux_config.md:67`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/buffer_apis.md and references/kafka_messaging.md and references/service_maker_api.md and references/use_cases_pipelines.md and references/utilities_config.md:
  "### Pattern 3: Selective Frame Capture" in references/buffer_apis.md (lines 1198-1199)
  vs "### Pattern 5: Frame Analysis and Logging" in references/buffer_apis.md (lines 1339-1340)
  vs "#### Example 2: Pipeline with Both Kafka and Display (Using Tee)" in references/kafka_messaging.md (lines 167-168)
  vs "#### Custom Kafka Producer Probe" in references/kafka_messaging.md (lines 581-582)
  vs "# Enable tensor output in nvinfer" in references/service_maker_api.md (lines 1329-1333)
  vs "#### Approach 3: Custom Postprocessing with Tensor Metadata" in references/use_cases_pipelines.md (lines 837-841)
  vs "### Pattern 3: Custom Postprocessing" in references/utilities_config.md (lines 1275-1279) (`references/buffer_apis.md:1198`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/buffer_apis.md and references/kafka_messaging.md and references/use_cases_pipelines.md and references/utilities_config.md:
  "# from multiprocessing import Queue  # Use this for MULTIPROCESSING!" in references/buffer_apis.md (lines 1059-1063)
  vs "### Pattern 3: Selective Frame Capture" in references/buffer_apis.md (lines 1195-1197)
  vs "### Pattern 5: Frame Analysis and Logging" in references/buffer_apis.md (lines 1336-1338)
  vs "#### Example 2: Pipeline with Both Kafka and Display (Using Tee)" in references/kafka_messaging.md (lines 162-166)
  vs "#### Custom Kafka Producer Probe" in references/kafka_messaging.md (lines 576-580)
  vs "#### Approach 3: Custom Postprocessing with Tensor Metadata" in references/use_cases_pipelines.md (lines 832-836)
  vs "### Pattern 3: Custom Postprocessing" in references/utilities_config.md (lines 1272-1274) (`references/buffer_apis.md:1059`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/utilities_config.md:
  "### Pattern 1: Load and Use Source Configuration" in references/utilities_config.md (lines 1107-1109)
  vs "### Pattern 1: Load and Use Source Configuration" in references/utilities_config.md (lines 1127-1128)
  vs "### Pattern 1: Load and Use Source Configuration" in references/utilities_config.md (lines 1142-1143) (`references/utilities_config.md:1107`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/metamux_config.md:
  "# mux all source if don't set it." in references/metamux_config.md (lines 74-78)
  vs "# mux all source if don't set it." in references/metamux_config.md (lines 132-136) (`references/metamux_config.md:74`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
