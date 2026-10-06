// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import YAML from "yaml";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_WORKFLOW_PATH = join(REPO_ROOT, ".github", "workflows", "pr-review-advisor.yaml");
const EXPECTED_GATE_CONDITION =
  "${{ github.repository == 'NVIDIA/NemoClaw' && (github.event_name == 'workflow_dispatch' || (github.event_name == 'workflow_run' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'pull_request' && github.event.workflow_run.path == '.github/workflows/pr.yaml' && endsWith(github.event.workflow_run.display_title, ' gate true'))) }}";
const EXPECTED_ENTRY_CONDITION = "${{ github.repository == 'NVIDIA/NemoClaw' }}";
const EXPECTED_FAILURE_RECEIPT_COMMAND =
  'node --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/failure-artifacts.mts"';
const EXPECTED_FAILURE_RECEIPT_ENV = {
  ADVISOR_PREPARATION_CLASSIFICATION: "${{ steps.prepare-analysis.outputs.classification }}",
  ADVISOR_DISPATCH_CHECKOUT_OUTCOME: "${{ steps.dispatch-checkout.outcome }}",
  ADVISOR_DEFAULT_WORKDIR_OUTCOME: "${{ steps.default-workdir.outcome }}",
  ADVISOR_NODE_SETUP_OUTCOME: "${{ steps.setup-node.outcome }}",
  ADVISOR_NPM_SETUP_OUTCOME: "${{ steps.setup-npm.outcome }}",
  ADVISOR_RUNTIME_IMAGE_OUTCOME: "${{ steps.runtime-image.outcome }}",
  ADVISOR_PREPARATION_OUTCOME: "${{ steps.prepare-analysis.outcome }}",
  ADVISOR_REMOVE_SYMLINKS_OUTCOME: "${{ steps.remove-symlinks.outcome }}",
  ADVISOR_RUNTIME_DOWNLOAD_OUTCOME: "${{ steps.download-runtime.outcome }}",
  ADVISOR_RUNTIME_RESTORE_OUTCOME: "${{ steps.restore-runtime.outcome }}",
  ADVISOR_CONTEXT_DOWNLOAD_OUTCOME: "${{ steps.download-context.outcome }}",
  ADVISOR_SANDBOX_INPUTS_OUTCOME: "${{ steps.sandbox-inputs.outcome }}",
  ADVISOR_OPENSHELL_INSTALL_OUTCOME: "${{ steps.install-openshell.outcome }}",
  ADVISOR_ANALYSIS_OUTCOME: "${{ steps.specialist-analysis.outcome }}",
  EXPECTED_HEAD_SHA: "${{ needs.require-green-checks.outputs.head_sha }}",
};

type WorkflowPermissions = Record<string, unknown> | string;
type WorkflowStep = {
  if?: string;
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  needs?: unknown;
  outputs?: Record<string, unknown>;
  permissions?: WorkflowPermissions;
  steps?: WorkflowStep[];
};
type AdvisorWorkflow = {
  jobs: Record<string, WorkflowJob>;
  permissions?: WorkflowPermissions;
  on?: {
    pull_request_target?: unknown;
    workflow_run?: { types?: unknown; workflows?: unknown };
  };
};

function needs(job: WorkflowJob): string[] {
  return Array.isArray(job.needs)
    ? job.needs.filter((name): name is string => typeof name === "string")
    : typeof job.needs === "string"
      ? [job.needs]
      : [];
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  const sorted = (values: readonly string[]) => [...values].sort((a, b) => a.localeCompare(b));
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function permissionMap(permissions: WorkflowPermissions | undefined): Record<string, unknown> {
  return permissions !== null && typeof permissions === "object" ? permissions : {};
}

export function validatePrReviewAdvisorWorkflow(workflowPath = DEFAULT_WORKFLOW_PATH): string[] {
  const errors: string[] = [];
  const source = readFileSync(workflowPath, "utf8");
  const advisor = YAML.parse(source) as AdvisorWorkflow;
  const permissionBlocks = [
    advisor.permissions,
    ...Object.values(advisor.jobs ?? {}).map((job) => job.permissions),
  ];
  if (
    permissionBlocks.some(
      (permissions) =>
        permissions === "write-all" || permissionMap(permissions).actions === "write",
    )
  ) {
    errors.push("Unified advisor must not hold actions: write");
  }
  if (/createWorkflowDispatch|workflow_dispatches/u.test(source)) {
    errors.push("Unified advisor must not auto-dispatch workflows");
  }
  if (
    advisor.on?.pull_request_target !== undefined ||
    !isDeepStrictEqual(advisor.on?.workflow_run?.workflows, ["CI / Pull Request"]) ||
    !isDeepStrictEqual(advisor.on?.workflow_run?.types, ["completed"]) ||
    !source.includes("format('Advisor after {0}', github.event.workflow_run.display_title)")
  ) {
    errors.push("Unified advisor must retain completed CI / Pull Request identity");
  }
  const gate = advisor.jobs?.["require-green-checks"] ?? {};
  const entryJobs = ["discover-specialists", "build-advisor-runtime", "review-specialists"];
  if (
    !sameMembers(needs(advisor.jobs?.["discover-specialists"] ?? {}), ["require-green-checks"]) ||
    !sameMembers(needs(advisor.jobs?.["build-advisor-runtime"] ?? {}), ["require-green-checks"]) ||
    !needs(advisor.jobs?.["review-specialists"] ?? {}).includes("require-green-checks") ||
    !needs(advisor.jobs?.publish ?? {}).includes("require-green-checks")
  ) {
    errors.push("Unified advisor entry jobs must depend on the green checks gate");
  }
  if (entryJobs.some((name) => advisor.jobs?.[name]?.if !== EXPECTED_ENTRY_CONDITION)) {
    errors.push("Unified advisor entry jobs must retain fail-closed conditions");
  }
  if (gate.if !== EXPECTED_GATE_CONDITION) {
    errors.push("Unified advisor green checks gate must require the exact successful CI condition");
  }
  if (
    !isDeepStrictEqual(permissionMap(gate.permissions), {
      contents: "read",
      "pull-requests": "read",
    }) ||
    JSON.stringify(gate).includes("PR_REVIEW_ADVISOR_API_KEY")
  ) {
    errors.push("Unified advisor green checks gate must retain read-only source permissions");
  }
  if (
    !isDeepStrictEqual(gate.outputs, {
      pr_number: "${{ steps.target.outputs.pr_number || steps.manual-target.outputs.pr_number }}",
      head_sha: "${{ steps.target.outputs.head_sha || steps.manual-target.outputs.head_sha }}",
      base_sha: "${{ steps.target.outputs.base_sha || steps.manual-target.outputs.base_sha }}",
    })
  ) {
    errors.push("Unified advisor green checks gate must expose the checked PR revision");
  }
  const targetStep = (gate.steps ?? []).find((step) => step.name === "Resolve checked PR revision");
  for (const fragment of [
    'gh api --method GET "repos/$GITHUB_REPOSITORY/pulls"',
    '-f state=open -f "head=${head_owner}:${RUN_HEAD_BRANCH}" -f per_page=100',
    ".head.repo.full_name == $repo",
    ".head.ref == $branch",
    ".head.sha == $sha",
    ".base.repo.full_name == $base",
    ".base.sha == $base_sha",
    'if length == 1 then .[0] else error("CI run must identify one open PR") end',
    'run_base_sha="${RUN_BASE_SHA:-}"',
    "sed -En 's/^.* base ([0-9a-f]{40}) gate true$/\\1/p'",
    '"pr_number=\\(.number)\\nhead_sha=\\(.head.sha)\\nbase_sha=\\($base_sha)"',
  ]) {
    if (!String(targetStep?.run ?? "").includes(fragment)) {
      errors.push(`Unified advisor green checks gate must retain ${fragment}`);
    }
  }
  if (
    targetStep?.env?.GH_TOKEN !== "${{ github.token }}" ||
    targetStep.env?.RUN_HEAD_BRANCH !== "${{ github.event.workflow_run.head_branch }}" ||
    targetStep.env?.RUN_HEAD_REPOSITORY !==
      "${{ github.event.workflow_run.head_repository.full_name }}" ||
    targetStep.env?.RUN_HEAD_SHA !== "${{ github.event.workflow_run.head_sha }}" ||
    targetStep.env?.RUN_BASE_SHA !== "${{ github.event.workflow_run.pull_requests[0].base.sha }}" ||
    targetStep.env?.RUN_DISPLAY_TITLE !== "${{ github.event.workflow_run.display_title }}"
  ) {
    errors.push("Unified advisor green checks gate must resolve the source run PR");
  }
  const manualTarget = (gate.steps ?? []).find(
    (step) => step.name === "Resolve manual review revision",
  );
  if (
    manualTarget?.env?.GH_TOKEN !== "${{ github.token }}" ||
    manualTarget.env?.INPUT_BASE_REF !== "${{ inputs.base_ref }}" ||
    manualTarget.env?.INPUT_HEAD_REF !== "${{ inputs.head_ref }}" ||
    manualTarget.env?.TARGET_BASE !== "${{ inputs.target_base }}" ||
    manualTarget.env?.TARGET_PR !== "${{ inputs.target_pr }}" ||
    manualTarget.env?.TARGET_REPO !== "${{ inputs.target_repo }}" ||
    manualTarget.env?.WORKFLOW_SHA !== "${{ github.sha }}"
  ) {
    errors.push("Unified advisor manual dispatch must bind the selected review revision");
  }
  for (const fragment of [
    'pull="$(gh api --method GET "repos/$TARGET_REPO/pulls/$TARGET_PR")"',
    '.state == "open" and .base.repo.full_name == $repo and .base.ref == $base',
    'head_sha="$(jq -r \'.head.sha\' <<< "$pull")"',
    'base_sha="$(jq -r \'.base.sha\' <<< "$pull")"',
    '[[ "$INPUT_HEAD_REF" == "HEAD" ]] && head_sha="$WORKFLOW_SHA"',
    '-f "sha=${INPUT_HEAD_REF#origin/}" -f per_page=1',
    '-f "sha=${INPUT_BASE_REF#origin/}" -f per_page=1',
    '[[ "$head_sha" =~ ^[0-9a-f]{40}$ && "$base_sha" =~ ^[0-9a-f]{40}$ ]]',
    "pr_number=%s\\nhead_sha=%s\\nbase_sha=%s\\n",
  ]) {
    if (!String(manualTarget?.run ?? "").includes(fragment)) {
      errors.push(`Unified advisor manual dispatch must retain ${fragment}`);
    }
  }
  const specialist = advisor.jobs?.["review-specialists"] ?? {};
  const specialistSteps = specialist.steps ?? [];
  const dispatchCheckout = specialistSteps.find(
    (step) => step.name === "Checkout dispatch workspace (read-only data)",
  );
  const targetPreparation = specialistSteps.find(
    (step) => step.name === "Prepare isolated analysis workspace",
  );
  const sandboxPreparation = specialistSteps.find(
    (step) => step.name === "Prepare advisor sandbox inputs",
  );
  if (dispatchCheckout?.with?.ref !== "${{ needs.require-green-checks.outputs.head_sha }}") {
    errors.push("Unified advisor ref dispatch must check out the resolved head SHA");
  }
  if (
    targetPreparation?.env?.TARGET_REPO !==
      "${{ github.event_name == 'workflow_run' && github.repository || inputs.target_repo }}" ||
    targetPreparation.env?.TARGET_PR !==
      "${{ github.event_name == 'workflow_run' && needs.require-green-checks.outputs.pr_number || inputs.target_pr }}" ||
    targetPreparation.env?.TARGET_BASE !==
      "${{ github.event_name == 'workflow_run' && 'main' || inputs.target_base }}" ||
    targetPreparation.env?.PR_BASE_SHA !==
      "${{ needs.require-green-checks.outputs.pr_number != '' && needs.require-green-checks.outputs.base_sha || '' }}" ||
    targetPreparation.env?.EXPECTED_HEAD_SHA !==
      "${{ needs.require-green-checks.outputs.pr_number != '' && needs.require-green-checks.outputs.head_sha || '' }}"
  ) {
    errors.push("Unified advisor must prepare the resolved PR revision");
  }
  const specialistEnv = specialist.env ?? {};
  const resolvedBaseRef =
    "${{ needs.require-green-checks.outputs.pr_number != '' && 'target/base' || needs.require-green-checks.outputs.base_sha }}";
  const resolvedHeadRef =
    "${{ needs.require-green-checks.outputs.pr_number != '' && 'HEAD' || needs.require-green-checks.outputs.head_sha }}";
  if (
    specialistEnv.BASE_REF !== resolvedBaseRef ||
    specialistEnv.HEAD_REF !== resolvedHeadRef ||
    sandboxPreparation?.env?.BASE_REF !== resolvedBaseRef ||
    sandboxPreparation.env?.HEAD_REF !== resolvedHeadRef
  ) {
    errors.push("Unified advisor specialists must analyze the resolved revisions");
  }
  const discoverySteps = advisor.jobs?.["discover-specialists"]?.steps ?? [];
  const contextUpload = discoverySteps.find((step) => step.name === "Upload GitHub review context");
  const contextDownload = specialistSteps.find(
    (step) => step.name === "Download GitHub review context",
  );
  const specialistUpload = specialistSteps.find((step) => step.name === "Upload specialist review");
  const failureReceipt = specialistSteps.find(
    (step) => step.name === "Preserve specialist failure status",
  );
  if (
    !failureReceipt ||
    failureReceipt.if !== "${{ failure() }}" ||
    failureReceipt.run !== EXPECTED_FAILURE_RECEIPT_COMMAND ||
    !isDeepStrictEqual(failureReceipt.env, EXPECTED_FAILURE_RECEIPT_ENV) ||
    specialistUpload?.if !== "${{ always() && matrix.advisor.interest != '' }}" ||
    specialistSteps.indexOf(specialistUpload) <= specialistSteps.indexOf(failureReceipt)
  ) {
    errors.push("Unified advisor failure receipt must run before upload after a failed step");
  }
  const contextArtifactName = "pr-review-advisor-context-${{ github.run_id }}";
  if (
    contextUpload?.with?.name !== contextArtifactName ||
    contextDownload?.with?.name !== contextArtifactName ||
    contextUpload?.with?.overwrite !== true
  ) {
    errors.push("Unified advisor context artifact must survive failed-job and full reruns");
  }
  if (
    specialistUpload?.with?.name !== "${{ matrix.advisor.artifact_name }}-${{ github.run_attempt }}"
  ) {
    errors.push("Unified advisor specialist artifacts must be unique per rerun attempt");
  }
  const blockerGate = advisor.jobs?.["advisor-blockers"] ?? {};
  const blockerGateSteps = blockerGate.steps ?? [];
  const blockerDownload = blockerGateSteps.find(
    (step) => step.name === "Download specialist reviews",
  );
  const blockerEvaluation = blockerGateSteps.find(
    (step) => step.name === "Require clear specialist evidence",
  );
  if (
    blockerGate.name !== "Require no Advisor blockers" ||
    !sameMembers(needs(blockerGate), [
      "require-green-checks",
      "build-advisor-runtime",
      "review-specialists",
    ]) ||
    blockerGate.if !==
      "${{ always() && github.repository == 'NVIDIA/NemoClaw' && needs.build-advisor-runtime.result == 'success' && needs.review-specialists.result == 'success' }}" ||
    !isDeepStrictEqual(permissionMap(blockerGate.permissions), {
      actions: "read",
      contents: "read",
    })
  ) {
    errors.push("Unified advisor blocker gate must fail closed after every specialist");
  }
  if (
    blockerDownload?.with?.pattern !== "pr-review-specialist-*-${{ github.run_attempt }}" ||
    blockerEvaluation?.env?.PR_REVIEW_ADVISOR_ARTIFACTS !==
      "${{ runner.temp }}/pr-review-specialists" ||
    blockerEvaluation.run !==
      'node --no-warnings "$ADVISOR_DIR/tools/pr-review-advisor/blocker-gate.mts" --attempt "$GITHUB_RUN_ATTEMPT"' ||
    blockerGate.env?.EXPECTED_HEAD_SHA !== "${{ needs.require-green-checks.outputs.head_sha }}" ||
    blockerGate.env?.EXPECTED_BASE_SHA !== "${{ needs.require-green-checks.outputs.base_sha }}"
  ) {
    errors.push("Unified advisor blocker gate must validate exact-attempt specialist evidence");
  }
  const coordinator = advisor.jobs?.["coordinator-shadow"] ?? {};
  const coordinatorSteps = coordinator.steps ?? [];
  const coordinatorContext = coordinatorSteps.find(
    (step) => step.name === "Download GitHub review context",
  );
  const coordinatorArtifacts = coordinatorSteps.find(
    (step) => step.name === "Download specialist reviews",
  );
  const coordinatorEvaluation = coordinatorSteps.find(
    (step) => step.name === "Evaluate read-only coordinator decision",
  );
  const coordinatorUpload = coordinatorSteps.find(
    (step) => step.name === "Upload coordinator shadow decision",
  );
  const coordinatorCondition =
    "${{ always() && github.repository == 'NVIDIA/NemoClaw' && needs.require-green-checks.outputs.pr_number != '' && needs.build-advisor-runtime.result == 'success' && needs.review-specialists.result == 'success' }}";
  if (
    coordinator.name !== "Evaluate review coordinator shadow" ||
    !sameMembers(needs(coordinator), [
      "require-green-checks",
      "build-advisor-runtime",
      "review-specialists",
      "advisor-blockers",
    ]) ||
    coordinator.if !== coordinatorCondition ||
    !isDeepStrictEqual(permissionMap(coordinator.permissions), {
      actions: "read",
      contents: "read",
    })
  ) {
    errors.push("Unified advisor coordinator shadow must remain read-only and exact-head bound");
  }
  if (
    coordinatorContext?.with?.name !== contextArtifactName ||
    coordinatorArtifacts?.with?.pattern !== "pr-review-specialist-*-${{ github.run_attempt }}" ||
    coordinatorEvaluation?.env?.PR_REVIEW_ADVISOR_ARTIFACTS !==
      "${{ runner.temp }}/pr-review-specialists" ||
    coordinatorEvaluation.env?.PR_REVIEW_ADVISOR_GITHUB_CONTEXT_PATH !==
      "${{ runner.temp }}/pr-review-context/github-context.json" ||
    coordinatorEvaluation.run !==
      'node --no-warnings "$ADVISOR_DIR/tools/pr-review-coordinator/shadow.mts"' ||
    coordinator.env?.EXPECTED_HEAD_SHA !== "${{ needs.require-green-checks.outputs.head_sha }}" ||
    coordinator.env?.EXPECTED_BASE_SHA !== "${{ needs.require-green-checks.outputs.base_sha }}" ||
    coordinator.env?.PR_NUMBER !== "${{ needs.require-green-checks.outputs.pr_number }}"
  ) {
    errors.push("Unified advisor coordinator shadow must consume exact-attempt trusted evidence");
  }
  if (
    coordinatorUpload?.uses !==
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a" ||
    coordinatorUpload.with?.name !== "pr-review-coordinator-shadow-${{ github.run_attempt }}" ||
    coordinatorUpload.with?.path !== "artifacts/pr-review-coordinator-shadow/decision.json" ||
    coordinatorUpload.with?.["if-no-files-found"] !== "error"
  ) {
    errors.push("Unified advisor coordinator shadow must retain its decision artifact");
  }
  const publisher = advisor.jobs?.publish ?? {};
  if (
    !needs(publisher).includes("advisor-blockers") ||
    !needs(publisher).includes("coordinator-shadow") ||
    publisher.if !==
      "${{ always() && github.event_name == 'workflow_run' && needs.review-specialists.result == 'success' }}"
  ) {
    errors.push("Unified advisor publisher must run after a red blocker gate");
  }
  return errors;
}
