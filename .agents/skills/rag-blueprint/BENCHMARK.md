# Evaluation Report

Evaluation of the `rag-blueprint` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `rag-blueprint`
- Evaluation date: 2026-05-29
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 5 total findings.

Top findings:

- LOW QUALITY/quality_discoverability: Description very long (368 chars, recommend 50-150) (`skills/rag-blueprint/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description doesn't mention WHEN to use this skill (`skills/rag-blueprint/SKILL.md`)
- LOW QUALITY/quality_discoverability: Broad description without negative triggers may cause over-triggering (`skills/rag-blueprint/SKILL.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'BENCHMARK.md' in skill root (`skills/rag-blueprint/BENCHMARK.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'eval' in skill root (`skills/rag-blueprint/eval`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 6 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/configure/query-and-conversation.md and references/configure/reasoning-and-generation.md:
  "## Process" in references/configure/query-and-conversation.md (lines 23-28)
  vs "## Process" in references/configure/reasoning-and-generation.md (lines 6-12) (`references/configure/query-and-conversation.md:23`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/configure/notebooks.md and references/deploy.md:
  "### Deployment" in references/configure/notebooks.md (lines 47-51)
  vs "## Notebooks" in references/deploy.md (lines 114-116) (`references/configure/notebooks.md:47`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/configure/multimodal-query.md and references/configure/vlm.md:
  "## When to Use" in references/configure/multimodal-query.md (lines 3-7)
  vs "## Notebooks" in references/configure/multimodal-query.md (lines 31-33)
  vs "## When to Use" in references/configure/vlm.md (lines 3-5)
  vs "## Notebooks" in references/configure/vlm.md (lines 51-53) (`references/configure/multimodal-query.md:3`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/deploy/library-full.md and references/deploy/library-lite.md and references/deploy/library.md:
  "## Source Documentation" in references/deploy/library-full.md (lines 42-43)
  vs "## Source Documentation" in references/deploy/library-lite.md (lines 36-37)
  vs "## Source Documentation" in references/deploy/library.md (lines 53-54) (`references/deploy/library-full.md:42`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/configure/models-and-infrastructure.md and references/deploy.md and references/deploy/docker.md and references/deploy/library.md:
  "### API Keys" in references/configure/models-and-infrastructure.md (lines 31-35)
  vs "## Verify NGC_API_KEY" in references/deploy/docker.md (lines 22-33)
  vs "## Verify NGC_API_KEY" in references/deploy/library.md (lines 18-27)
  vs "## Phase 2: NGC_API_KEY Handling" in references/deploy.md (lines 39-48) (`references/configure/models-and-infrastructure.md:31`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
