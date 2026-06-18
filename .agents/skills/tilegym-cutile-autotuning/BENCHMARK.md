# Evaluation Report

Evaluation of the `tilegym-cutile-autotuning` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tilegym-cutile-autotuning`
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
| Correctness | 5 | 100% (+15%) | 97% (+10%) |
| Discoverability | 5 | 100% (+15%) | 93% (+0%) |
| Effectiveness | 5 | 99% (+18%) | 95% (+13%) |
| Efficiency | 5 | 96% (+14%) | 91% (-0%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 15 total findings.

Top findings:

- MEDIUM PII/phone_numbers: International phone number (`SKILL.md:206`)
- MEDIUM QUALITY/quality_correctness: SKILL_SPEC recommended field missing: 'metadata.author' (`skills/tilegym-cutile-autotuning/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in workflow.md (`skills/tilegym-cutile-autotuning/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/tilegym-cutile-autotuning/SKILL.md`)
- MEDIUM SCHEMA/author_missing: Author not specified in metadata (`skills/tilegym-cutile-autotuning/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 4 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/api-reference.md and references/workflow.md:
  "# Then in the host wrapper:" in references/api-reference.md (lines 126-132)
  vs "## Adding Autotune to a New Kernel" in references/workflow.md (lines 6-7) (`references/api-reference.md:126`)
- HIGH DUPLICATE/duplicate: Duplicate content found across assets/examples/03_rope_inplace_splitbuffer/autotuned_launch.py and assets/examples/03_rope_inplace_splitbuffer/fixed_launch.py:
  "precompute_freqs()" in assets/examples/03_rope_inplace_splitbuffer/autotuned_launch.py (lines 112-117)
  vs "precompute_freqs()" in assets/examples/03_rope_inplace_splitbuffer/fixed_launch.py (lines 89-95) (`assets/examples/03_rope_inplace_splitbuffer/autotuned_launch.py:112`)
- HIGH DUPLICATE/duplicate: Duplicate content found within SKILL.md:
  "# Module-level cache: tune once, launch fast forever after" in SKILL.md (lines 47-59)
  vs "# Module-level cache: tune once, launch fast forever after" in SKILL.md (lines 60-63) (`SKILL.md:47`)
- LOW DUPLICATE/duplicate: Duplicate content found within references/search-strategies.md:
  "# 2. Tune once (exhaustive search over all configs)" in references/search-strategies.md (lines 19-29)
  vs "# Step 1: Run exhaustive_search to find optimal config (outside NCU)" in references/search-strategies.md (lines 100-104) (`references/search-strategies.md:19`)
