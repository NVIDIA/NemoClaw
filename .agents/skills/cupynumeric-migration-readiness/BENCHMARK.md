# Evaluation Report

Evaluation of the `cupynumeric-migration-readiness` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `cupynumeric-migration-readiness`
- Evaluation date: 2026-05-29
- NVSkills-Eval profile: `external`
- Environment: `local`
- Dataset: 27 evaluation tasks
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

The benchmark dataset contained 27 evaluation tasks:

- Positive tasks: 23 tasks where the skill was expected to activate.
- Negative tasks: 4 tasks where no skill was expected.
- Unlabeled tasks: 0 tasks where positive/negative intent could not be inferred.

Task composition is derived from the evaluation dataset when possible. Entries with `expected_skill` set are treated as positive skill-activation cases, while entries with `expected_skill: null` are treated as negative activation cases.

## Results

| Dimension | Num | `claude-code` | `codex` |
|---|---:|---:|---:|
| Security | 8 | 100% (+0%) | 100% (+1%) |
| Correctness | 8 | 98% (+24%) | 87% (+13%) |
| Discoverability | 8 | 96% (+42%) | 66% (+8%) |
| Effectiveness | 8 | 81% (+16%) | 70% (+15%) |
| Efficiency | 8 | 81% (+28%) | 52% (+2%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 6 total findings.

Top findings:

- MEDIUM QUALITY/quality_correctness: Instructions don't mention 'run_script' (`skills/cupynumeric-migration-readiness/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in idioms-that-block.md (`skills/cupynumeric-migration-readiness/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (815 chars, recommend 50-150) (`skills/cupynumeric-migration-readiness/SKILL.md`)
- LOW QUALITY/quality_discoverability: Broad description without negative triggers may cause over-triggering (`skills/cupynumeric-migration-readiness/SKILL.md`)
- LOW QUALITY/quality_reliability: No prerequisites/requirements documented (`skills/cupynumeric-migration-readiness/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 1 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across assets/sample_report.md and references/case-studies.md:
  "## Verdict: **NOT RECOMMENDED**" in assets/sample_report.md (lines 115-118)
  vs "## What blocks (BLOCKS findings)" in assets/sample_report.md (lines 123-131)
  vs "## Compatibility / cost notes (INFO findings)" in assets/sample_report.md (lines 136-140)
  vs "## Recommended next steps" in assets/sample_report.md (lines 156-160)
  vs "### Verdict" in references/case-studies.md (lines 197-200)
  vs "### What blocks (BLOCKS findings)" in references/case-studies.md (lines 205-215)
  vs "### Compatibility / cost notes (INFO findings)" in references/case-studies.md (lines 220-225)
  vs "### Recommended next steps" in references/case-studies.md (lines 241-248) (`assets/sample_report.md:115`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
