# Evaluation Report

Evaluation of the `omniverse-cad-to-simready` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `omniverse-cad-to-simready`
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 10 total findings.

Top findings:

- MEDIUM SCHEMA/body_recommended_section: Missing recommended section: '## Examples' (`skills/omniverse-cad-to-simready/SKILL.md`)
- LOW QUALITY/quality_correctness: No examples provided (`skills/omniverse-cad-to-simready/SKILL.md`)
- LOW QUALITY/quality_discoverability: Description very long (422 chars, recommend 50-150) (`skills/omniverse-cad-to-simready/SKILL.md`)
- LOW QUALITY/quality_discoverability: No '## Purpose' section (`skills/omniverse-cad-to-simready/SKILL.md`)
- LOW SCHEMA/unexpected_file: Unexpected 'BENCHMARK.md' in skill root (`skills/omniverse-cad-to-simready/BENCHMARK.md`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 13 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/omni-asset-validate-geometry/scripts/run.py and references/omni-asset-validate-physics/scripts/run.py:
  "validate()" in references/omni-asset-validate-geometry/scripts/run.py (lines 25-35)
  vs "validate()" in references/omni-asset-validate-physics/scripts/run.py (lines 25-35) (`references/omni-asset-validate-geometry/scripts/run.py:25`)
- HIGH DUPLICATE/duplicate: Duplicate content found within references/simready-conform-profile/scripts/run.py:
  "_run_fet000()" in references/simready-conform-profile/scripts/run.py (lines 164-216)
  vs "_run_fet001()" in references/simready-conform-profile/scripts/run.py (lines 219-256)
  vs "_run_fet004()" in references/simready-conform-profile/scripts/run.py (lines 259-299)
  vs "_run_fet005()" in references/simready-conform-profile/scripts/run.py (lines 302-367) (`references/simready-conform-profile/scripts/run.py:164`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/content-agents/scripts/content_agent_client.py and references/content-agents/scripts/run.py and references/convert-to-usd/references/mujoco-usd-converter/scripts/run.py and references/convert-to-usd/references/urdf-usd-converter/scripts/run.py and references/convert-to-usd/references/usd-convert-cad/scripts/run.py and references/convert-to-usd/references/usd-convert-gsplat/scripts/run.py and references/identify-asset-context/scripts/run.py and references/omni-asset-validate-geometry/scripts/run.py and references/omni-asset-validate-physics/scripts/run.py and references/ovrtx-render-service/scripts/run.py and references/ovrtx-render-service/scripts/turntable.py and references/simready-conform-profile/references/FET_000_CORE/scripts/run.py and references/simready-conform-profile/references/FET_001_MINIMAL/scripts/run.py and references/simready-conform-profile/references/FET_004_SIMULATE_MULTI_BODY_PHYSICS/scripts/run.py and references/simready-conform-profile/references/FET_005_SIMULATE_GRASP_PHYSICS/scripts/author_grasp_line.py and references/simready-conform-profile/scripts/run.py and references/simready-validate/scripts/run.py and shared/simready_package.py:
  "_emit_report()" in references/content-agents/scripts/content_agent_client.py (lines 1276-1277)
  vs "emit()" in references/content-agents/scripts/run.py (lines 217-230)
  vs "emit_probe()" in references/convert-to-usd/references/mujoco-usd-converter/scripts/run.py (lines 216-217)
  vs "emit_probe()" in references/convert-to-usd/references/urdf-usd-converter/scripts/run.py (lines 214-215)
  vs "emit_probe()" in references/convert-to-usd/references/usd-convert-cad/scripts/run.py (lines 554-555)
  vs "emit_probe()" in references/convert-to-usd/references/usd-convert-gsplat/scripts/run.py (lines 311-312)
  vs "_emit()" in references/identify-asset-context/scripts/run.py (lines 275-276)
  vs "emit()" in references/omni-asset-validate-geometry/scripts/run.py (lines 38-44)
  vs "emit()" in references/omni-asset-validate-physics/scripts/run.py (lines 38-44)
  vs "_emit()" in references/ovrtx-render-service/scripts/run.py (lines 358-359)
  vs "_emit()" in references/ovrtx-render-service/scripts/turntable.py (lines 227-228)
  vs "emit()" in references/simready-conform-profile/references/FET_000_CORE/scripts/run.py (lines 213-219)
  vs "emit()" in references/simready-conform-profile/references/FET_001_MINIMAL/scripts/run.py (lines 331-338)
  vs "emit()" in references/simready-conform-profile/references/FET_004_SIMULATE_MULTI_BODY_PHYSICS/scripts/run.py (lines 275-288)
  vs "write_reports()" in references/simready-conform-profile/references/FET_005_SIMULATE_GRASP_PHYSICS/scripts/author_grasp_line.py (lines 68-96)
  vs "emit()" in references/simready-conform-profile/scripts/run.py (lines 464-475)
  vs "emit()" in references/simready-validate/scripts/run.py (lines 700-706)
  vs "_emit()" in shared/simready_package.py (lines 662-663) (`references/content-agents/scripts/content_agent_client.py:1276`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/content-agents/README.md and references/content-agents/references/material-agent-client/README.md:
  "## Rate Limits" in references/content-agents/README.md (lines 125-133)
  vs "## Rate Limits" in references/content-agents/references/material-agent-client/README.md (lines 93-101) (`references/content-agents/README.md:125`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/nv-core-package-sample-validation/README.md and references/nv-core-package-sample/README.md:
  "## Upstream Reference" in references/nv-core-package-sample/README.md (lines 21-32)
  vs "## Upstream Reference" in references/nv-core-package-sample-validation/README.md (lines 9-20) (`references/nv-core-package-sample/README.md:21`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
