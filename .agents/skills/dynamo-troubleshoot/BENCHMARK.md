# Evaluation Report

Evaluation of the `dynamo-troubleshoot` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `dynamo-troubleshoot`
- Evaluation date: 2026-05-28
- NVSkills-Eval profile: `external`
- Overall verdict: FAIL
- Tier 3 live agent evaluation: not available in this report

## Agents Used

- Tier 3 agent details were not available in this report.

## Metrics Used

Reported benchmark dimensions:

- Security: checks whether skill-assisted execution avoids unsafe behavior such as secret leakage, destructive commands, or unauthorized access.
- Correctness: checks whether the agent follows the expected workflow and produces the correct final output.
- Discoverability: checks whether the agent loads the skill when relevant and avoids using it when irrelevant.
- Effectiveness: checks whether the agent performs measurably better with the skill than without it.
- Efficiency: checks whether the agent uses fewer tokens and avoids redundant work.

Underlying evaluation signals used in this run:

- No Tier 3 evaluation signal details were available in this report.

## Test Tasks

Tier 3 evaluation task details were not available in this report.

## Results

Tier 3 dimension rollup was not available in this report.

## Tier 1: Static Validation Summary

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 7 total findings.

Top findings:

- MEDIUM SECURITY/Unknown (LP3): MCP Least Privilege: The skill invokes shell commands (kubectl, python3) and writes output files (debug bundle) without declaring explicit pe (`SKILL.md:1`)
- MEDIUM SECURITY/Unknown (SDI-4): The 'Limitations' section explicitly claims the skill is 'Read-only. Never mutates the cluster; remediation commands are (`SKILL.md:144`)
- MEDIUM SECURITY/Unknown (SQP-2): The skill card documents that outputs include 'Shell commands' and 'Configuration instructions' but does not include any (`skill-card.md:26`)
- LOW QUALITY/quality_discoverability: Description very long (221 chars, recommend 50-150) (`skills/dynamo-troubleshoot/SKILL.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'skill-card.md' in skill root (`skills/dynamo-troubleshoot/skill-card.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 1 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found within SKILL.md:
  "### 1. Collect A Read-Only Bundle" in SKILL.md (lines 23-41)
  vs "## Available Scripts" in SKILL.md (lines 83-94)
  vs "## Examples" in SKILL.md (lines 95-116) (`SKILL.md:23`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
