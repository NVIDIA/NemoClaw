// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { PREPARE_E2E_ACTION } from "../../../tools/e2e/prepare-e2e-workflow-boundary.mts";
import { UPLOAD_E2E_ARTIFACTS_ACTION } from "../../../tools/e2e/upload-e2e-artifacts-workflow-boundary.mts";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

const JOB_ID = "openclaw-plugin-runtime-exdev";
const CHECKOUT_ACTION = "actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10";
const RELEASE_BUILDER_IMAGE =
  "node:22-trixie-slim@sha256:2d9f5c76c8f4dd36e8f253bee5d828a83a6c09f36188f0b0414325232e0b175d";
const SELECTOR_CONDITION =
  "${{ (github.event_name != 'workflow_dispatch' || (inputs.jobs == '' && inputs.targets == '')) || contains(format(',{0},', inputs.jobs), ',openclaw-plugin-runtime-exdev,') || contains(format(',{0},', inputs.targets), ',openclaw-plugin-runtime-exdev,') }}";

type WorkflowStep = Record<string, unknown> & {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = Record<string, unknown> & {
  env?: Record<string, unknown>;
  needs?: string | string[];
  permissions?: Record<string, unknown>;
  steps?: WorkflowStep[];
};

type Workflow = {
  on: {
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: Record<string, unknown>;
  };
  jobs: Record<string, WorkflowJob>;
};

function canonicalWorkflow(): Workflow {
  return readWorkflow() as unknown as Workflow;
}

describe("OpenClaw plugin runtime EXDEV workflow boundary", () => {
  it("keeps the full-runtime plugin proof in the canonical scheduled lane", () => {
    const workflow = canonicalWorkflow();
    const job = workflow.jobs[JOB_ID];
    expect(workflow.on.schedule).toContainEqual({ cron: "0 0 * * *" });
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(job).toBeDefined();
    expect(job.needs).toBe("generate-matrix");
    expect(job.if).toBe(SELECTOR_CONDITION);
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job.permissions).toEqual({ contents: "read" });
    expect(job["timeout-minutes"]).toBe(130);
    expect(job.env).toMatchObject({
      E2E_JOB: "1",
      E2E_TARGET_ID: JOB_ID,
      E2E_ARTIFACT_DIR: "${{ github.workspace }}/e2e-artifacts/live/openclaw-plugin-runtime-exdev",
      NEMOCLAW_CLI_BIN: "${{ github.workspace }}/bin/nemoclaw.js",
      NEMOCLAW_RUN_LIVE_E2E: "1",
      NEMOCLAW_NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
      NEMOCLAW_SANDBOX_NAME: "e2e-openclaw-plugin-exdev",
      OPENSHELL_GATEWAY: "nemoclaw",
    });
    expect(job.env).not.toHaveProperty("E2E_DEFAULT_ENABLED");
    expect(job.env).not.toHaveProperty("NVIDIA_INFERENCE_API_KEY");

    const steps = job.steps ?? [];
    expect(steps).toHaveLength(8);
    expect(steps[0]).toEqual({
      uses: CHECKOUT_ACTION,
      with: {
        ref: "${{ inputs.checkout_sha || github.sha }}",
        "persist-credentials": false,
      },
    });
    expect(steps[1]?.name).toBe("Authenticate to Docker Hub");
    expect(steps[2]).toEqual({
      name: "Pre-pull release-matched Docker Hub builder image",
      shell: "bash",
      run: `set -euo pipefail\ndocker pull ${RELEASE_BUILDER_IMAGE}\n`,
    });
    expect(steps[3]).toEqual({
      name: "Remove Docker auth before release-pinned fixture",
      if: "always()",
      shell: "bash",
      run: "set -euo pipefail\n" + "bash .github/scripts/docker-auth-cleanup.sh\n",
    });
    expect(steps[4]).toEqual({
      name: "Prepare E2E workspace",
      uses: PREPARE_E2E_ACTION,
    });
    expect(steps[5]?.name).toBe(
      "Run OpenClaw custom-plugin lifecycle and runtime-deps EXDEV live test",
    );
    expect(steps[5]?.run).toContain('test -n "${DOCKER_CONFIG:-}"');
    expect(steps[5]?.run).toContain('test ! -e "${DOCKER_CONFIG}"');
    expect(steps[5]?.run).toContain('test -z "${DOCKERHUB_USERNAME:-}"');
    expect(steps[5]?.run).toContain('test -z "${DOCKERHUB_TOKEN:-}"');
    expect(steps[5]?.run).toContain(
      "env -u DOCKER_CONFIG -u DOCKERHUB_USERNAME -u DOCKERHUB_TOKEN",
    );
    expect(steps[5]?.run).toContain("npx vitest run --project e2e-live");
    expect(steps[5]?.run).toContain("test/e2e/live/openclaw-plugin-runtime-exdev.test.ts");
    expect(steps[5]).not.toHaveProperty("env");
    expect(JSON.stringify(steps[5])).not.toContain("secrets.");
    expect(steps[6]).toEqual({
      name: "Upload OpenClaw plugin runtime-deps EXDEV artifacts",
      if: "always()",
      uses: UPLOAD_E2E_ARTIFACTS_ACTION,
    });
    expect(steps[7]).toEqual({
      name: "Clean up Docker auth",
      if: "always()",
      shell: "bash",
      run: "bash .github/scripts/docker-auth-cleanup.sh",
    });

    expect(workflow.jobs["report-to-pr"]?.needs).toContain(JOB_ID);
    expect(workflow.jobs.scorecard?.needs).toContain(JOB_ID);
  });

  it("keeps job and target selectors mapped to the default-enabled canonical job", () => {
    const inventory = readFreeStandingJobsInventory();
    expect(inventory.allowedJobs).toContain(JOB_ID);
    expect(inventory.explicitOnlyJobs).not.toContain(JOB_ID);
    expect(inventory.targetToJob.get(JOB_ID)).toBe(JOB_ID);
    expect(evaluateE2eWorkflowDispatchSelectors({ jobs: JOB_ID })).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: [JOB_ID],
      registryTargets: [],
    });
    expect(evaluateE2eWorkflowDispatchSelectors({ targets: JOB_ID })).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: [JOB_ID],
      registryTargets: [],
    });
  });
});
