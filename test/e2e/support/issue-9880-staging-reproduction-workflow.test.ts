// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS,
  ISSUE_9880_STAGING_LAUNCHABLE_ONBOARD_TIMEOUT_MS,
  ISSUE_9880_STAGING_LAUNCHABLE_SCENARIO_TIMEOUT_MS,
  ISSUE_9880_STAGING_LAUNCHABLE_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/staging-launchable-timeout-contract.mts";
import {
  DEFAULT_BREV_EXEC_READY_TIMEOUT_MS,
  DEFAULT_BREV_IDENTITY_TIMEOUT_MS,
  DEFAULT_BREV_STAGING_HANDOFF_TIMEOUT_MS,
  DEFAULT_BREV_WORKSPACE_CREATE_TIMEOUT_MS,
  DEFAULT_BREV_WORKSPACE_DELETE_TIMEOUT_MS,
  DEFAULT_BREV_WORKSPACE_READY_TIMEOUT_MS,
} from "../fixtures/brev-launchable.ts";
import {
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract.ts";

const MINUTE_MS = 60_000;
const CHECKOUT_ACTION = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const UPLOAD_ACTION =
  "NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@7768e15eb90d3ee2d33432f481dfe8747e4f6d57";

type StagingWorkflow = Workflow & {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  permissions?: Record<string, string>;
};

type WorkflowContract = {
  checkout: string;
  inferenceCredential: string;
  job: string;
  prepare: string;
  scenario: string;
  upload: string;
  workflow: string;
};

type TimeoutContract = {
  cleanupTimeoutMs: number;
  testTimeoutMs: number;
};

const contract = {
  workflow: ".github/workflows/issue-9880-staging-reproduction.yaml",
  job: "reproduce",
  checkout: "Check out trusted reproduction lane",
  prepare: "Prepare Brev CLI and evidence directory",
  scenario: "Reproduce issue 9880 on the staging Launchable",
  upload: "Upload issue 9880 evidence",
  inferenceCredential: "NVIDIA_API_KEY",
} as const satisfies WorkflowContract;

const timeoutContract: TimeoutContract = {
  cleanupTimeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS,
  testTimeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_TEST_TIMEOUT_MS,
};

const PREPARATION_STEP_NAMES = [
  contract.checkout,
  "Authorize maintainer dispatch",
  "Set up Node",
  "Install dependencies",
  contract.prepare,
] as const;
const POST_SCENARIO_STEP_NAMES = [
  "Verify workflow-owned workspace cleanup",
  "Remove Brev credentials",
  contract.upload,
] as const;

const CONTROLLER_OPERATION_TIMEOUT_MS =
  DEFAULT_BREV_STAGING_HANDOFF_TIMEOUT_MS +
  DEFAULT_BREV_WORKSPACE_CREATE_TIMEOUT_MS +
  DEFAULT_BREV_WORKSPACE_READY_TIMEOUT_MS +
  DEFAULT_BREV_EXEC_READY_TIMEOUT_MS +
  DEFAULT_BREV_IDENTITY_TIMEOUT_MS +
  ISSUE_9880_STAGING_LAUNCHABLE_ONBOARD_TIMEOUT_MS +
  ISSUE_9880_STAGING_LAUNCHABLE_SCENARIO_TIMEOUT_MS;

const mutations: ReadonlyArray<
  readonly [
    string,
    (workflow: StagingWorkflow, contract: WorkflowContract, timeouts: TimeoutContract) => void,
    string,
  ]
> = [
  [
    "an untrusted checkout reference",
    (workflow, contract) => {
      step(workflow, contract, contract.checkout).with!.ref = "${{ github.sha }}";
    },
    "checkout must use trusted workflow code without persisted credentials",
  ],
  [
    "missing maintainer authorization",
    (workflow, contract) => {
      step(workflow, contract, "Authorize maintainer dispatch").run = "true";
    },
    "workflow must authorize both dispatch actors as maintainers",
  ],
  [
    "widened workflow permission",
    (workflow) => {
      workflow.permissions = { contents: "write" };
    },
    "workflow permissions must remain read-only",
  ],
  [
    "missing Brev CLI checksum verification",
    (workflow, contract) => {
      const prepare = step(workflow, contract, contract.prepare);
      prepare.run = String(prepare.run).replace("sha256sum -c -", "true");
    },
    "Brev CLI download must retain checksum verification",
  ],
  [
    "conditional workspace cleanup",
    (workflow, contract) => {
      step(workflow, contract, "Verify workflow-owned workspace cleanup").if = "success()";
    },
    "workflow must always reconcile its owned Brev workspace before removing credentials",
  ],
  [
    "conditional credential cleanup",
    (workflow, contract) => {
      step(workflow, contract, "Remove Brev credentials").if = "success()";
    },
    "workflow must always remove and verify its Brev credential directory",
  ],
  [
    "a test timeout shorter than the controller lifecycle",
    (_workflow, _contract, timeouts) => {
      timeouts.testTimeoutMs = CONTROLLER_OPERATION_TIMEOUT_MS - 1;
    },
    "test timeout must contain every sequential controller operation",
  ],
  [
    "a cleanup timeout that cannot contain Brev deletion",
    (_workflow, _contract, timeouts) => {
      timeouts.cleanupTimeoutMs = DEFAULT_BREV_WORKSPACE_DELETE_TIMEOUT_MS;
    },
    "cleanup timeout must exceed the Brev deletion budget",
  ],
  [
    "a scenario step timeout without cleanup time",
    (workflow, contract, timeouts) => {
      step(workflow, contract, contract.scenario)["timeout-minutes"] =
        (timeouts.testTimeoutMs + timeouts.cleanupTimeoutMs) / MINUTE_MS - 1;
    },
    "scenario timeout must contain the live test and cleanup budgets",
  ],
  [
    "an unbounded preparation step",
    (workflow, contract) => {
      delete step(workflow, contract, contract.prepare)["timeout-minutes"];
    },
    "workflow preparation and finalization steps must have positive timeouts",
  ],
  [
    "a job timeout without preparation and finalization time",
    (workflow, contract, timeouts) => {
      const job = workflow.jobs[contract.job]!;
      const reservedStepMs = [...PREPARATION_STEP_NAMES, ...POST_SCENARIO_STEP_NAMES].reduce(
        (total, name) =>
          total + Number(step(workflow, contract, name)["timeout-minutes"]) * MINUTE_MS,
        0,
      );
      job["timeout-minutes"] =
        (reservedStepMs + timeouts.testTimeoutMs + timeouts.cleanupTimeoutMs) / MINUTE_MS - 1;
    },
    "job timeout must contain preparation, scenario, cleanup, and finalization budgets",
  ],
];

describe("rejects unsafe changes to the staging Launchable workflow for issue 9880", () => {
  it.each(mutations)("rejects %s", (_case, mutate, expected) => {
    const workflow = readStagingWorkflow();
    const timeouts = structuredClone(timeoutContract);
    expect(validateWorkflow(workflow, timeouts)).not.toContain(expected);
    mutate(workflow, contract, timeouts);

    expect(validateWorkflow(workflow, timeouts)).toContain(expected);
  });
});

function readStagingWorkflow(): StagingWorkflow {
  return structuredClone(readYaml<StagingWorkflow>(contract.workflow));
}

function step(
  workflow: StagingWorkflow,
  contract: WorkflowContract,
  name: string,
): WorkflowStep & { "timeout-minutes"?: number } {
  return workflow.jobs[contract.job]!.steps!.find((entry) => entry.name === name)!;
}

function validateWorkflow(workflow: StagingWorkflow, timeouts: TimeoutContract): string[] {
  const errors: string[] = [];
  const job = workflow.jobs[contract.job] ?? {};

  recordValidation(
    errors,
    timeouts.testTimeoutMs >= CONTROLLER_OPERATION_TIMEOUT_MS,
    "test timeout must contain every sequential controller operation",
  );
  recordValidation(
    errors,
    timeouts.cleanupTimeoutMs > DEFAULT_BREV_WORKSPACE_DELETE_TIMEOUT_MS,
    "cleanup timeout must exceed the Brev deletion budget",
  );

  recordValidation(
    errors,
    JSON.stringify(workflow.permissions) === JSON.stringify({ contents: "read" }),
    "workflow permissions must remain read-only",
  );
  recordValidation(
    errors,
    workflow.concurrency?.["cancel-in-progress"] === false &&
      workflow.concurrency.group === "issue-9880-staging-launchable",
    "workflow must retain its non-cancelling staging concurrency group",
  );
  recordValidation(
    errors,
    job.if ===
      "${{ github.repository == 'NVIDIA/NemoClaw' && github.ref == 'refs/heads/main' && github.event_name == 'workflow_dispatch' }}",
    "workflow job must remain manual and trusted-main-only",
  );
  recordValidation(
    errors,
    job["runs-on"] === "ubuntu-latest",
    "workflow job must remain on a GitHub-hosted runner",
  );

  validateCheckout(errors, job, contract);
  validateAuthorization(errors, job);
  validatePreparation(errors, job, contract);
  validateScenario(errors, job, contract, timeouts);
  validateWorkspaceCleanup(errors, job, contract, timeouts);
  validateCredentialCleanup(errors, job, contract);
  validateEvidenceUpload(errors, job, contract);
  return errors;
}

function validateCheckout(errors: string[], job: WorkflowJob, contract: WorkflowContract): void {
  const checkout = namedStep(job, contract.checkout);
  recordValidation(
    errors,
    checkout?.uses === CHECKOUT_ACTION &&
      checkout.env === undefined &&
      checkout.with?.ref === "${{ github.workflow_sha }}" &&
      checkout.with?.["persist-credentials"] === false,
    "checkout must use trusted workflow code without persisted credentials",
  );
}

function validateAuthorization(errors: string[], job: WorkflowJob): void {
  const authorize = namedStep(job, "Authorize maintainer dispatch");
  const run = String(authorize?.run ?? "");
  recordValidation(
    errors,
    authorize?.env?.ACTOR === "${{ github.actor }}" &&
      authorize.env.GITHUB_TOKEN === "${{ github.token }}" &&
      authorize.env.TRIGGERING_ACTOR === "${{ github.triggering_actor }}" &&
      run.includes('for actor in "$ACTOR" "$TRIGGERING_ACTOR"') &&
      run.includes("maintain|admin") &&
      run.includes("/collaborators/${actor}/permission"),
    "workflow must authorize both dispatch actors as maintainers",
  );
}

function validatePreparation(errors: string[], job: WorkflowJob, contract: WorkflowContract): void {
  const prepare = namedStep(job, contract.prepare);
  const run = String(prepare?.run ?? "");
  recordValidation(
    errors,
    /^[0-9a-f]{64}$/u.test(String(prepare?.env?.BREV_CLI_SHA256 ?? "")) &&
      /^\d+[.]\d+[.]\d+$/u.test(String(prepare?.env?.BREV_CLI_VERSION ?? "")) &&
      run.includes("sha256sum -c -") &&
      run.includes('brev login --api-key "$BREV_API_KEY" --org-id "$BREV_ORG_ID"'),
    "Brev CLI download must retain checksum verification",
  );
  recordValidation(
    errors,
    prepare?.env?.BREV_API_KEY === "${{ secrets.BREV_API_KEY }}" &&
      prepare.env.BREV_ORG_ID === "${{ secrets.BREV_ORG_ID }}" &&
      prepare.env[contract.inferenceCredential] === undefined &&
      prepare.env.NEMOCLAW_IMAGE_DISPATCH_TOKEN === undefined,
    "workflow credentials must remain scoped to their owning steps",
  );
}

function validateScenario(
  errors: string[],
  job: WorkflowJob,
  contract: WorkflowContract,
  timeouts: TimeoutContract,
): void {
  const scenario = namedStep(job, contract.scenario) as
    | (WorkflowStep & { "timeout-minutes"?: number })
    | undefined;
  const scenarioTimeoutMs = Number(scenario?.["timeout-minutes"]) * MINUTE_MS;
  recordValidation(
    errors,
    Number.isSafeInteger(scenarioTimeoutMs) &&
      scenarioTimeoutMs >= timeouts.testTimeoutMs + timeouts.cleanupTimeoutMs,
    "scenario timeout must contain the live test and cleanup budgets",
  );
  const boundedWorkflowStepNames = [...PREPARATION_STEP_NAMES, ...POST_SCENARIO_STEP_NAMES];
  const boundedWorkflowSteps = boundedWorkflowStepNames.map(
    (name) => namedStep(job, name) as (WorkflowStep & { "timeout-minutes"?: number }) | undefined,
  );
  recordValidation(
    errors,
    boundedWorkflowSteps.every((workflowStep) => Number(workflowStep?.["timeout-minutes"]) > 0),
    "workflow preparation and finalization steps must have positive timeouts",
  );
  const reservedWorkflowStepMs = boundedWorkflowSteps.reduce(
    (total, workflowStep) => total + Number(workflowStep?.["timeout-minutes"] ?? 0) * MINUTE_MS,
    0,
  );
  const jobTimeoutMs = Number(job["timeout-minutes"]) * MINUTE_MS;
  recordValidation(
    errors,
    Number.isSafeInteger(jobTimeoutMs) &&
      jobTimeoutMs >= reservedWorkflowStepMs + timeouts.testTimeoutMs + timeouts.cleanupTimeoutMs,
    "job timeout must contain preparation, scenario, cleanup, and finalization budgets",
  );
  recordValidation(
    errors,
    scenario?.env?.BREV_LAUNCHABLE_ID === "${{ vars.NEMOCLAW_STAGING_LAUNCHABLE_ID }}" &&
      scenario.env.NEMOCLAW_IMAGE_DISPATCH_TOKEN ===
        "${{ secrets.NEMOCLAW_IMAGE_DISPATCH_TOKEN }}" &&
      scenario.env[contract.inferenceCredential] ===
        `\${{ secrets.${contract.inferenceCredential} }}` &&
      scenario.env.BREV_API_KEY === undefined &&
      scenario.env.BREV_ORG_ID === undefined &&
      scenario.env.PATH === "/usr/local/bin:/usr/bin:/bin",
    "workflow credentials must remain scoped to their owning steps",
  );
}

function validateWorkspaceCleanup(
  errors: string[],
  job: WorkflowJob,
  contract: WorkflowContract,
  timeouts: TimeoutContract,
): void {
  const prepare = namedStep(job, contract.prepare);
  const scenario = namedStep(job, contract.scenario);
  const cleanup = namedStep(job, "Verify workflow-owned workspace cleanup") as
    | (WorkflowStep & { "timeout-minutes"?: number })
    | undefined;
  const cleanupCommand = String(cleanup?.run).trim();
  recordValidation(
    errors,
    cleanup?.if === "${{ always() && steps.prepare.outputs.work_dir != '' }}" &&
      cleanup.env?.BREV_WORKSPACE_OWNERSHIP_FILE ===
        scenario?.env?.BREV_WORKSPACE_OWNERSHIP_FILE &&
      cleanup.env?.HOME === prepare?.env?.HOME &&
      cleanup.env?.NEMOCLAW_RUN_LIVE_E2E === "1" &&
      cleanup.env?.PATH === "/usr/local/bin:/usr/bin:/bin" &&
      cleanupCommand ===
        "./node_modules/.bin/vitest run --project e2e-live test/e2e/live/brev-workspace-cleanup.test.ts --silent=false --reporter=default" &&
      Number(cleanup["timeout-minutes"]) * MINUTE_MS >= timeouts.cleanupTimeoutMs,
    "workflow must always reconcile its owned Brev workspace before removing credentials",
  );
}

function validateCredentialCleanup(
  errors: string[],
  job: WorkflowJob,
  contract: WorkflowContract,
): void {
  const prepare = namedStep(job, contract.prepare);
  const cleanup = namedStep(job, "Remove Brev credentials");
  const run = String(cleanup?.run ?? "");
  recordValidation(
    errors,
    cleanup?.if === "always()" &&
      cleanup.env?.HOME === prepare?.env?.HOME &&
      run.includes('rm -rf -- "$HOME"') &&
      run.includes('test ! -e "$HOME"'),
    "workflow must always remove and verify its Brev credential directory",
  );
}

function validateEvidenceUpload(
  errors: string[],
  job: WorkflowJob,
  contract: WorkflowContract,
): void {
  const upload = namedStep(job, contract.upload);
  recordValidation(
    errors,
    upload?.uses === UPLOAD_ACTION &&
      upload.if === "${{ always() && steps.prepare.outputs.work_dir != '' }}",
    "workflow must always upload evidence through the pinned repository action",
  );
}

function namedStep(job: WorkflowJob, name: string): WorkflowStep | undefined {
  return job.steps?.find((entry) => entry.name === name);
}

function recordValidation(errors: string[], valid: boolean, message: string): void {
  errors.push(...(valid ? [] : [message]));
}
