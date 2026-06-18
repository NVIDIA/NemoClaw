# Evaluation Report

Evaluation of the `tao-mine-aoi-images` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tao-mine-aoi-images`
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
| Correctness | 2 | 75% (+65%) | 87% (+87%) |
| Discoverability | 2 | 44% (+44%) | 97% (+97%) |
| Effectiveness | 2 | 94% (+68%) | 62% (+44%) |
| Efficiency | 2 | 51% (+24%) | 96% (+68%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 10 total findings.

Top findings:

- MEDIUM SCHEMA/folder_hierarchy: Unexpected nesting depth for general skill (`skills/data/tao-mine-aoi-images`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/data/tao-mine-aoi-images/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/data/tao-mine-aoi-images/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (341 chars, recommend 50-150) (`skills/data/tao-mine-aoi-images/SKILL.md`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/data/tao-mine-aoi-images/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 3 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/invocation.md:
  "## Method" in SKILL.md (lines 54-57)
  vs "## The three commands, in order" in references/invocation.md (lines 73-76) (`SKILL.md:54`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/invocation.md:
  "### Step 1 — Embed the target images" in SKILL.md (lines 58-66)
  vs "### Step 2 — Embed the source pool" in SKILL.md (lines 67-75)
  vs "### Step 1 — Embed the target images" in references/invocation.md (lines 77-89)
  vs "### Step 2 — Embed the source pool" in references/invocation.md (lines 90-100)
  vs "# Step 1: embed targets" in references/invocation.md (lines 148-156)
  vs "# Step 2: embed source pool (SAME embedding spec as Step 1)" in references/invocation.md (lines 157-165) (`SKILL.md:58`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/invocation.md:
  "# DEFT Mining and Embedding Skill" in SKILL.md (lines 1-10)
  vs "### Step 3 — Mine nearest neighbours" in SKILL.md (lines 76-89)
  vs "### Step 3 — Mine nearest neighbours" in references/invocation.md (lines 101-114)
  vs "# Step 3: mine nearest neighbours" in references/invocation.md (lines 166-175) (`SKILL.md:1`)
