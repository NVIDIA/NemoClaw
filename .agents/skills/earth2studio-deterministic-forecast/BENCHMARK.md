# Evaluation Report

Evaluation of the `earth2studio-deterministic-forecast` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `earth2studio-deterministic-forecast`
- Evaluation date: 2026-06-02
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 7 total findings.

Top findings:

- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Instructions' (`skills/earth2studio-deterministic-forecast/SKILL.md`)
- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/earth2studio-deterministic-forecast/SKILL.md`)
- MEDIUM SECURITY/Unknown (SDI-2): The script appends to /etc/environment without sanitizing the REPO_ROOT variable, which could allow path injection if RE (`evals/environment/setup/bootstrap.sh:27`)
- MEDIUM SECURITY/Unknown (SQP-2): Writing to /etc/environment modifies system-wide environment configuration for all users and processes in the container  (`evals/environment/setup/bootstrap.sh:27`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/earth2studio-deterministic-forecast/SKILL.md`)

## Tier 2: Deduplication Summary

Tier 2 validation passed. NVSkills-Eval ran 2 checks and found 0 total findings.

Notable observations:

- Context Deduplication: Collected 2 file(s)
- Inter-Skill Deduplication: Parsed skill 'earth2studio-deterministic-forecast': 158 char description

## Publication Recommendation

The skill is suitable to proceed toward NVSkills-Eval publication based on this benchmark. Skill owners should keep this file with the skill and refresh it when the evaluation dataset, skill behavior, or target agents materially change.
