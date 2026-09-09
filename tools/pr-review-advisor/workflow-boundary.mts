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

type WorkflowPermissions = Record<string, unknown> | string;
type WorkflowStep = {
  env?: Record<string, unknown>;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
};
type WorkflowJob = {
  env?: Record<string, unknown>;
  if?: string;
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
    !isDeepStrictEqual(permissionMap(gate.permissions), { "pull-requests": "read" }) ||
    JSON.stringify(gate).includes("PR_REVIEW_ADVISOR_API_KEY")
  ) {
    errors.push("Unified advisor green checks gate must only read pull requests");
  }
  if (
    !isDeepStrictEqual(gate.outputs, {
      pr_number: "${{ steps.target.outputs.pr_number }}",
      head_sha: "${{ steps.target.outputs.head_sha }}",
      base_sha: "${{ steps.target.outputs.base_sha }}",
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
  const specialist = advisor.jobs?.["review-specialists"] ?? {};
  const specialistSteps = specialist.steps ?? [];
  const targetPreparation = specialistSteps.find(
    (step) => step.name === "Prepare isolated analysis workspace",
  );
  if (
    targetPreparation?.env?.TARGET_REPO !==
      "${{ github.event_name == 'workflow_run' && github.repository || inputs.target_repo }}" ||
    targetPreparation.env?.TARGET_PR !==
      "${{ github.event_name == 'workflow_run' && needs.require-green-checks.outputs.pr_number || inputs.target_pr }}" ||
    targetPreparation.env?.TARGET_BASE !==
      "${{ github.event_name == 'workflow_run' && 'main' || inputs.target_base }}" ||
    targetPreparation.env?.PR_BASE_SHA !==
      "${{ github.event_name == 'workflow_run' && needs.require-green-checks.outputs.base_sha || '' }}" ||
    targetPreparation.env?.EXPECTED_HEAD_SHA !==
      "${{ github.event_name == 'workflow_run' && needs.require-green-checks.outputs.head_sha || '' }}"
  ) {
    errors.push("Unified advisor must prepare the PR revision from the successful checks run");
  }
  const specialistEnv = specialist.env ?? {};
  if (
    specialistEnv.BASE_REF !==
      "${{ github.event_name == 'workflow_run' && 'target/base' || (github.event_name == 'workflow_dispatch' && inputs.target_repo != '' && inputs.target_pr != '' && 'target/base' || inputs.base_ref) }}" ||
    specialistEnv.HEAD_REF !==
      "${{ github.event_name == 'workflow_run' && 'HEAD' || (github.event_name == 'workflow_dispatch' && inputs.target_repo != '' && inputs.target_pr != '' && 'HEAD' || inputs.head_ref) }}"
  ) {
    errors.push("Unified advisor specialists must retain target refs through execution");
  }
  const discoverySteps = advisor.jobs?.["discover-specialists"]?.steps ?? [];
  const contextUpload = discoverySteps.find((step) => step.name === "Upload GitHub review context");
  const contextDownload = specialistSteps.find(
    (step) => step.name === "Download GitHub review context",
  );
  const specialistUpload = specialistSteps.find((step) => step.name === "Upload specialist review");
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
  return errors;
}
