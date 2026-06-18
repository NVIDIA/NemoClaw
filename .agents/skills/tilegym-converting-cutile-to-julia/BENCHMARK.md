# Evaluation Report

Evaluation of the `tilegym-converting-cutile-to-julia` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `tilegym-converting-cutile-to-julia`
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
| Correctness | 5 | 100% (+20%) | 99% (+14%) |
| Discoverability | 5 | 100% (+20%) | 99% (+8%) |
| Effectiveness | 5 | 99% (+18%) | 96% (+18%) |
| Efficiency | 5 | 96% (+13%) | 97% (+7%) |

Score values show skill-assisted performance. Values in parentheses show uplift versus the no-skill baseline when baseline data is available.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 16 total findings.

Top findings:

- MEDIUM QUALITY/quality_correctness: No documented scripts in table format (`skills/tilegym-converting-cutile-to-julia/SKILL.md`)
- MEDIUM QUALITY/quality_correctness: Instructions don't mention 'run_script' (`skills/tilegym-converting-cutile-to-julia/SKILL.md`)
- MEDIUM QUALITY/quality_efficiency: Deeply nested references in debugging.md (`skills/tilegym-converting-cutile-to-julia/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/tilegym-converting-cutile-to-julia/SKILL.md`)
- MEDIUM SECURITY/Unknown (SQP-2): The workflow instructs the agent to auto-proceed through all phases without user confirmation, including writing files t (`translations/workflow.md:26`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 6 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within references/critical-rules.md:
  "# Critical Rules for cuTile Python → Julia Conversion" in references/critical-rules.md (lines 32-33)
  vs "# Critical Rules for cuTile Python → Julia Conversion" in references/critical-rules.md (lines 34-36) (`references/critical-rules.md:32`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/api-mapping.md and references/critical-rules.md and translations/workflow.md:
  "## Memory Layout Considerations" in references/api-mapping.md (lines 233-248)
  vs "# Critical Rules for cuTile Python → Julia Conversion" in references/critical-rules.md (lines 8-8)
  vs "### Step 4: Memory Layout Considerations" in translations/workflow.md (lines 288-305) (`references/api-mapping.md:233`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/testing.md and translations/workflow.md:
  "### Step 2: Register in `julia/test/runtests.jl`" in references/testing.md (lines 67-79)
  vs "### Step 2: Register in `julia/test/runtests.jl`" in translations/workflow.md (lines 355-363) (`references/testing.md:67`)
- HIGH DUPLICATE/duplicate: Duplicate content found across SKILL.md and references/testing.md and translations/workflow.md:
  "# Run tests" in SKILL.md (lines 92-100)
  vs "### Step 1: Create test file `julia/test/test_<op>.jl`" in references/testing.md (lines 43-48)
  vs "# Load kernel" in references/testing.md (lines 49-66)
  vs "### Step 1: Write Test File" in translations/workflow.md (lines 329-354) (`SKILL.md:92`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/testing.md and translations/workflow.md:
  "# Run a single test file directly" in references/testing.md (lines 32-34)
  vs "# Run a single test file directly" in translations/workflow.md (lines 106-108)
  vs "# Run a single test file" in translations/workflow.md (lines 370-379) (`references/testing.md:32`)
