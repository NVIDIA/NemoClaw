# Evaluation Report

Evaluation of the `omniverse-usd-performance-tuning` skill before publication through NVSkills-Eval.

This benchmark summarizes 3-Tier Evaluation from NVSkills-Eval results for the skill. The goal is to document whether the skill is safe, discoverable, effective, and useful for agents before it is published for broader workflow use.

## Evaluation Summary

- Skill: `omniverse-usd-performance-tuning`
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

Tier 1 validation passed with observations. NVSkills-Eval ran 9 checks and found 10 total findings.

Top findings:

- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/operations/decimateMeshes.md:22`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/profile-stage/README.md:162`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/usd-structure-assessment/references/asset-structure-principles.md:704`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/usd-structure-assessment/references/asset-structure-principles.md:709`)
- MEDIUM PII/gps_coordinates: GPS coordinates (location information) (`references/usd-structure-assessment/references/asset-structure-principles.md:851`)

## Tier 2: Deduplication Summary

Tier 2 validation reported findings. NVSkills-Eval ran 2 checks and found 17 total findings.

Top findings:

- HIGH DUPLICATE/duplicate: Duplicate content found across references/cad-conversion/README.md and references/compare-profiles.md and references/operations/CLASSIFICATION.md and references/operations/EXECUTION.md and references/operations/_template.md and references/operations/boxClip.md and references/operations/computeExtents.md and references/operations/countVertices.md and references/operations/decimateMeshes.md and references/operations/deduplicateGeometry.md and references/operations/deduplicateHierarchies.md and references/operations/deleteHiddenPrims.md and references/operations/deletePrims.md and references/operations/diceMeshes.md and references/operations/editStageMetrics.md and references/operations/findCoincidingGeometry.md and references/operations/findFlatHierarchies.md and references/operations/findOccludedMeshes.md and references/operations/findOverlappingMeshes.md and references/operations/fitPrimitives.md and references/operations/flattenHierarchy.md and references/operations/generateAtlasUVs.md and references/operations/generateNormals.md and references/operations/generateProjectionUVs.md and references/operations/generateScene.md and references/operations/manifoldMeshes.md and references/operations/merge.md and references/operations/mergeVertices.md and references/operations/meshCleanup.md and references/operations/optimizeMaterials.md and references/operations/optimizePrimvars.md and references/operations/optimizeSkelRoots.md and references/operations/optimizeTimeSamples.md and references/operations/organizePrototypes.md and references/operations/pivot.md and references/operations/primitivesToMeshes.md and references/operations/printStats.md and references/operations/pruneLeaves.md and references/operations/pythonScript.md and references/operations/remeshMeshes.md and references/operations/removeAttributes.md and references/operations/removePrims.md and references/operations/removeSmallGeometry.md and references/operations/removeUntypedPrims.md and references/operations/removeUnusedUVs.md and references/operations/rtxMeshCount.md and references/operations/shrinkwrap.md and references/operations/sparseMeshes.md and references/operations/splitMeshes.md and references/operations/subdivideMeshes.md and references/operations/triangulateMeshes.md and references/operations/utilityFunction.md and references/optimization-report/references/optimization-report-template.md and references/output-workspace.md and references/report-templates/README.md and references/runtime-artifact-token-budget.md and references/setup-usd-performance-tuning/references/kit-discovery.md and references/setup-usd-performance-tuning/references/runtime-context-header.md and references/setup-usd-performance-tuning/references/runtime-probe.md and references/setup-usd-performance-tuning/references/standalone-runtime.md and references/skill-map.md and references/so-run-operations/README.md and references/so-run-operations/references/batch-mode.md and references/so-run-operations/references/config-from-evidence.md and references/so-run-operations/references/invocation.md and references/so-run-operations/references/operation-safety.md and references/so-run-operations/references/pipelines.md and references/so-run-operations/references/so-create-proxy/README.md and references/so-run-operations/references/so-create-proxy/references/bounding-box-proxy-modes.md and references/so-run-operations/references/so-create-proxy/references/decimate-step-recipes.md and references/so-run-operations/references/so-create-proxy/references/decimation-tuning.md and references/so-run-operations/references/so-create-proxy/references/proxy-config-recipes.md and references/so-run-operations/references/units-and-tolerances.md and references/upstreams/usd-optimize.md and references/usd-structure-assessment/references/apply-restructure/references/hierarchy-dedupe-rewrite-tool-spec.md and references/usd-structure-assessment/references/apply-restructure/references/ref-remap-mode.md and references/usd-structure-assessment/references/apply-restructure/references/restructure-mode.md and references/usd-structure-assessment/references/asset-structure-principles.md and references/usd-structure-assessment/references/composition-audit.md and references/usd-structure-assessment/references/factory-level-structuring.md and references/usd-structure-assessment/references/instancing-readiness/references/instancing-guide.md and references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md and references/usd-structure-assessment/references/layer-health.md and references/usd-structure-assessment/references/optimization-tradeoffs.md and references/usd-structure-assessment/references/usd-edit-target-planner/references/output-saving.md and references/usd-structure-assessment/references/usd-edit-target-planner/references/variants-payloads.md and references/usd-structure-assessment/references/usd-hierarchy-dedupe-candidates/references/instance-candidate-finder-spec.md and references/usd-validation-runner/references/so-interpret-validators/README.md and references/usd-validation-runner/references/so-interpret-validators/references/follow-up-queries.md and references/usd-validation-runner/references/so-interpret-validators/references/rule-reference.md and references/usd-validation-runner/references/so-run-validators/README.md and references/usd-validation-runner/references/so-run-validators/references/infrastructure.md and references/usd-validation-runner/references/validate-usd-asset-validator.md and references/workflow.md:
  "(preamble)" in references/cad-conversion/README.md (lines 1-3)
  vs "(preamble)" in references/compare-profiles.md (lines 1-3)
  vs "(preamble)" in references/operations/CLASSIFICATION.md (lines 1-3)
  vs "(preamble)" in references/operations/EXECUTION.md (lines 1-3)
  vs "(preamble)" in references/operations/_template.md (lines 1-3)
  vs "(preamble)" in references/operations/boxClip.md (lines 1-3)
  vs "(preamble)" in references/operations/computeExtents.md (lines 1-3)
  vs "(preamble)" in references/operations/countVertices.md (lines 1-3)
  vs "(preamble)" in references/operations/decimateMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/deduplicateGeometry.md (lines 1-3)
  vs "(preamble)" in references/operations/deduplicateHierarchies.md (lines 1-3)
  vs "(preamble)" in references/operations/deleteHiddenPrims.md (lines 1-3)
  vs "(preamble)" in references/operations/deletePrims.md (lines 1-3)
  vs "(preamble)" in references/operations/diceMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/editStageMetrics.md (lines 1-3)
  vs "(preamble)" in references/operations/findCoincidingGeometry.md (lines 1-3)
  vs "(preamble)" in references/operations/findFlatHierarchies.md (lines 1-3)
  vs "(preamble)" in references/operations/findOccludedMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/findOverlappingMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/fitPrimitives.md (lines 1-3)
  vs "(preamble)" in references/operations/flattenHierarchy.md (lines 1-3)
  vs "(preamble)" in references/operations/generateAtlasUVs.md (lines 1-3)
  vs "(preamble)" in references/operations/generateNormals.md (lines 1-3)
  vs "(preamble)" in references/operations/generateProjectionUVs.md (lines 1-3)
  vs "(preamble)" in references/operations/generateScene.md (lines 1-3)
  vs "(preamble)" in references/operations/manifoldMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/merge.md (lines 1-3)
  vs "(preamble)" in references/operations/mergeVertices.md (lines 1-3)
  vs "(preamble)" in references/operations/meshCleanup.md (lines 1-3)
  vs "(preamble)" in references/operations/optimizeMaterials.md (lines 1-3)
  vs "(preamble)" in references/operations/optimizePrimvars.md (lines 1-3)
  vs "(preamble)" in references/operations/optimizeSkelRoots.md (lines 1-3)
  vs "(preamble)" in references/operations/optimizeTimeSamples.md (lines 1-3)
  vs "(preamble)" in references/operations/organizePrototypes.md (lines 1-3)
  vs "(preamble)" in references/operations/pivot.md (lines 1-3)
  vs "(preamble)" in references/operations/primitivesToMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/printStats.md (lines 1-3)
  vs "(preamble)" in references/operations/pruneLeaves.md (lines 1-3)
  vs "(preamble)" in references/operations/pythonScript.md (lines 1-3)
  vs "(preamble)" in references/operations/remeshMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/removeAttributes.md (lines 1-3)
  vs "(preamble)" in references/operations/removePrims.md (lines 1-3)
  vs "(preamble)" in references/operations/removeSmallGeometry.md (lines 1-3)
  vs "(preamble)" in references/operations/removeUntypedPrims.md (lines 1-3)
  vs "(preamble)" in references/operations/removeUnusedUVs.md (lines 1-3)
  vs "(preamble)" in references/operations/rtxMeshCount.md (lines 1-3)
  vs "(preamble)" in references/operations/shrinkwrap.md (lines 1-3)
  vs "(preamble)" in references/operations/sparseMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/splitMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/subdivideMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/triangulateMeshes.md (lines 1-3)
  vs "(preamble)" in references/operations/utilityFunction.md (lines 1-3)
  vs "(preamble)" in references/optimization-report/references/optimization-report-template.md (lines 1-3)
  vs "(preamble)" in references/output-workspace.md (lines 1-3)
  vs "(preamble)" in references/report-templates/README.md (lines 1-3)
  vs "(preamble)" in references/runtime-artifact-token-budget.md (lines 1-3)
  vs "(preamble)" in references/setup-usd-performance-tuning/references/kit-discovery.md (lines 1-3)
  vs "(preamble)" in references/setup-usd-performance-tuning/references/runtime-context-header.md (lines 1-3)
  vs "(preamble)" in references/setup-usd-performance-tuning/references/runtime-probe.md (lines 1-3)
  vs "(preamble)" in references/setup-usd-performance-tuning/references/standalone-runtime.md (lines 1-3)
  vs "(preamble)" in references/skill-map.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/README.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/batch-mode.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/config-from-evidence.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/invocation.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/operation-safety.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/pipelines.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/so-create-proxy/README.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/so-create-proxy/references/bounding-box-proxy-modes.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/so-create-proxy/references/decimate-step-recipes.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/so-create-proxy/references/decimation-tuning.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/so-create-proxy/references/proxy-config-recipes.md (lines 1-3)
  vs "(preamble)" in references/so-run-operations/references/units-and-tolerances.md (lines 1-3)
  vs "(preamble)" in references/upstreams/usd-optimize.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/apply-restructure/references/hierarchy-dedupe-rewrite-tool-spec.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/apply-restructure/references/ref-remap-mode.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/apply-restructure/references/restructure-mode.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/asset-structure-principles.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/composition-audit.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/factory-level-structuring.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/instancing-readiness/references/instancing-guide.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/instancing-readiness/references/instancing-tradeoffs.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/layer-health.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/optimization-tradeoffs.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/usd-edit-target-planner/references/output-saving.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/usd-edit-target-planner/references/variants-payloads.md (lines 1-3)
  vs "(preamble)" in references/usd-structure-assessment/references/usd-hierarchy-dedupe-candidates/references/instance-candidate-finder-spec.md (lines 1-3)
  vs "(preamble)" in references/usd-validation-runner/references/so-interpret-validators/README.md (lines 1-3)
  vs "(preamble)" in references/usd-validation-runner/references/so-interpret-validators/references/follow-up-queries.md (lines 1-3)
  vs "(preamble)" in references/usd-validation-runner/references/so-interpret-validators/references/rule-reference.md (lines 1-3)
  vs "(preamble)" in references/usd-validation-runner/references/so-run-validators/README.md (lines 1-3)
  vs "(preamble)" in references/usd-validation-runner/references/so-run-validators/references/infrastructure.md (lines 1-3)
  vs "(preamble)" in references/usd-validation-runner/references/validate-usd-asset-validator.md (lines 1-3)
  vs "(preamble)" in references/workflow.md (lines 1-3) (`references/cad-conversion/README.md:1`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/usd-structure-assessment/references/apply-restructure/references/ref-remap-mode.md and references/usd-structure-assessment/references/apply-restructure/references/restructure-mode.md:
  "## Output Validation" in references/usd-structure-assessment/references/apply-restructure/references/ref-remap-mode.md (lines 73-76)
  vs "## Output Validation" in references/usd-structure-assessment/references/apply-restructure/references/restructure-mode.md (lines 179-183) (`references/usd-structure-assessment/references/apply-restructure/references/ref-remap-mode.md:73`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/compare-profiles/README.md and references/omniverse-authentication/README.md and references/optimization-report/README.md and references/profile-stage/README.md and references/setup-usd-performance-tuning/references/install-kit/README.md and references/setup-usd-performance-tuning/references/install-so-standalone/README.md and references/setup-usd-performance-tuning/references/install-so-via-kit/README.md and references/usd-structure-assessment/README.md and references/usd-structure-assessment/references/apply-restructure/README.md and references/usd-structure-assessment/references/instancing-readiness/README.md and references/usd-structure-assessment/references/restructure-decision/README.md and references/usd-structure-assessment/references/usd-edit-target-planner/README.md and references/usd-structure-assessment/references/usd-hierarchy-dedupe-candidates/README.md:
  "## Instructions" in references/compare-profiles/README.md (lines 10-17)
  vs "## Instructions" in references/omniverse-authentication/README.md (lines 10-16)
  vs "## Instructions" in references/optimization-report/README.md (lines 10-21)
  vs "## Instructions" in references/profile-stage/README.md (lines 10-17)
  vs "## Instructions" in references/setup-usd-performance-tuning/references/install-kit/README.md (lines 10-16)
  vs "## Instructions" in references/setup-usd-performance-tuning/references/install-so-standalone/README.md (lines 10-16)
  vs "## Instructions" in references/setup-usd-performance-tuning/references/install-so-via-kit/README.md (lines 10-16)
  vs "## Instructions" in references/usd-structure-assessment/README.md (lines 10-16)
  vs "## Instructions" in references/usd-structure-assessment/references/apply-restructure/README.md (lines 10-16)
  vs "## Instructions" in references/usd-structure-assessment/references/instancing-readiness/README.md (lines 10-16)
  vs "## Instructions" in references/usd-structure-assessment/references/restructure-decision/README.md (lines 10-17)
  vs "## Instructions" in references/usd-structure-assessment/references/usd-edit-target-planner/README.md (lines 10-16)
  vs "## Instructions" in references/usd-structure-assessment/references/usd-hierarchy-dedupe-candidates/README.md (lines 10-16) (`references/compare-profiles/README.md:10`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/compare-profiles/README.md and references/omniverse-authentication/README.md and references/profile-stage/README.md and references/setup-usd-performance-tuning/references/install-kit/README.md and references/setup-usd-performance-tuning/references/install-so-standalone/README.md and references/setup-usd-performance-tuning/references/install-so-via-kit/README.md and references/usd-structure-assessment/README.md and references/usd-structure-assessment/references/apply-restructure/README.md and references/usd-structure-assessment/references/instancing-readiness/README.md and references/usd-structure-assessment/references/restructure-decision/README.md and references/usd-structure-assessment/references/usd-edit-target-planner/README.md and references/usd-structure-assessment/references/usd-hierarchy-dedupe-candidates/README.md and references/usd-validation-runner/references/so-run-validators/README.md:
  "## Output Format" in references/compare-profiles/README.md (lines 26-33)
  vs "## Output Format" in references/omniverse-authentication/README.md (lines 17-20)
  vs "## Output Format" in references/profile-stage/README.md (lines 28-34)
  vs "## Output Format" in references/setup-usd-performance-tuning/references/install-kit/README.md (lines 17-20)
  vs "## Output Format" in references/setup-usd-performance-tuning/references/install-so-standalone/README.md (lines 17-20)
  vs "## Output Format" in references/setup-usd-performance-tuning/references/install-so-via-kit/README.md (lines 17-20)
  vs "## Output Format" in references/usd-structure-assessment/README.md (lines 17-20)
  vs "## Output Format" in references/usd-structure-assessment/references/apply-restructure/README.md (lines 17-24)
  vs "## Output Format" in references/usd-structure-assessment/references/instancing-readiness/README.md (lines 17-20)
  vs "## Output Format" in references/usd-structure-assessment/references/restructure-decision/README.md (lines 27-30)
  vs "## Output Format" in references/usd-structure-assessment/references/usd-edit-target-planner/README.md (lines 17-20)
  vs "## Output Format" in references/usd-structure-assessment/references/usd-hierarchy-dedupe-candidates/README.md (lines 17-24)
  vs "## Output Format" in references/usd-validation-runner/references/so-run-validators/README.md (lines 29-33) (`references/compare-profiles/README.md:26`)
- HIGH DUPLICATE/duplicate: Duplicate content found across references/usd-structure-assessment/references/asset-structure-principles.md and references/usd-structure-assessment/references/instancing-readiness/references/instancing-guide.md:
  "#### Asset Parameterization" in references/usd-structure-assessment/references/asset-structure-principles.md (lines 259-286)
  vs "### By parameterization" in references/usd-structure-assessment/references/instancing-readiness/references/instancing-guide.md (lines 153-188) (`references/usd-structure-assessment/references/asset-structure-principles.md:259`)

## Publication Recommendation

The skill should be reviewed before NVSkills-Eval publication. Skill owners should address the findings above and rerun NVSkills-Eval to refresh this benchmark.
