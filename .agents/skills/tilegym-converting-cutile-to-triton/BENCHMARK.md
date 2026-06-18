# Evaluation Report

Evaluation of the `tilegym-converting-cutile-to-triton` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tilegym-converting-cutile-to-triton`
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
| Correctness | 5 | 100% (+15%) | 99% (+12%) |
| Discoverability | 5 | 100% (+15%) | 99% (+8%) |
| Effectiveness | 5 | 100% (+18%) | 97% (+17%) |
| Efficiency | 5 | 96% (+14%) | 97% (+6%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 16 total findings.

Top findings:

- MEDIUM QUALITY/quality_efficiency: Deeply nested references in performance-gotchas.md (`skills/tilegym-converting-cutile-to-triton/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/tilegym-converting-cutile-to-triton/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (505 chars, recommend 50-150) (`skills/tilegym-converting-cutile-to-triton/SKILL.md`)
- LOW QUALITY/quality_discoverability: Broad description without negative triggers may cause over-triggering (`skills/tilegym-converting-cutile-to-triton/SKILL.md`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/tilegym-converting-cutile-to-triton/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 4 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within translations/workflow.md:
  "### TMA Setup (Required Once)" in translations/workflow.md (lines 208-218)
  vs "# TMA allocator (required once per kernel launch context)" in translations/workflow.md (lines 362-368) (`translations/workflow.md:208`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/harness-integration.md and translations/workflow.md:
  "# Testing & Validation (cuTile → Triton)" in references/harness-integration.md (lines 1-7)
  vs "# Performance testing (Triton vs cuTile)" in translations/workflow.md (lines 168-170)
  vs "### Step 1: Benchmark" in translations/workflow.md (lines 236-243) (`references/harness-integration.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found within translations/workflow.md:
  "## TMA OPTIMIZATION (Phase c2t-4) {#tma-optimization-phase-c2t-4}" in translations/workflow.md (lines 178-181)
  vs "### Performance Killer #1: Raw Pointer Arithmetic vs TMA Tensor Descriptors" in translations/workflow.md (lines 329-335) (`translations/workflow.md:178`)
- LOW DUPLICATE/duplicate: Duplicate content found within translations/workflow.md:
  "### Triton Debug / Profiling" in translations/workflow.md (lines 115-125)
  vs "# Triton profiling / autotune visibility" in translations/workflow.md (lines 171-177) (`translations/workflow.md:115`)
