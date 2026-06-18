# Evaluation Report

Evaluation of the `physical-ai-neural-reconstruction` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `physical-ai-neural-reconstruction`
- Evaluation date: 2026-05-28
- NVSkills-Eval profile: `external`
- Overall verdict: PASS
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 6 total findings.

Top findings:

- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/physical-ai-neural-reconstruction/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/physical-ai-neural-reconstruction/SKILL.md`)
- MEDIUM SECURITY/Unknown (SDI-2): The reference document instructs an AI agent to clone an external GitHub repository and execute a sequence of shell comm (`references/upstream-fetch.md:25`)
- MEDIUM SECURITY/Unknown (SDI-1): The skill manifest explicitly states 'Do NOT use for infra setup' yet the reference document provides detailed infrastru (`references/upstream-fetch.md:20`)
- MEDIUM SECURITY/Unknown (SQP-2): The markdown instructs git clone, git pull, mkdir, and checkout operations without any warning to the user about side ef (`references/upstream-fetch.md:25`)

## Tier 2: Deduplication Summary

Tier 2 validation passed. NVSkills-Eval ran 2 checks and found 0 total findings.

Notable observations:

- Context Deduplication: Collected 7 file(s)
- Inter-Skill Deduplication: Parsed skill 'physical-ai-neural-reconstruction': 149 char description

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
