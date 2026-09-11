// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract";

type SdkPackageWorkflow = {
  concurrency?: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
};

function requiredStep(job: WorkflowJob, name: string): WorkflowStep {
  const selected = job.steps?.find((candidate) => candidate.name === name);
  expect(selected).toBeDefined();
  return selected as WorkflowStep;
}

describe("OpenShell SDK package credential boundary", () => {
  const workflow = readYaml<SdkPackageWorkflow>(".github/workflows/openshell-sdk-package-pr.yaml");
  const job = workflow.jobs["package-openshell-sdk"];

  // source-shape-contract: security -- The package credential must remain in a base-loaded workflow that uploads only the verified SDK archive
  it("keeps package access out of pull request controlled execution", () => {
    expect(workflow.on).toEqual(
      expect.objectContaining({
        pull_request_target: { types: ["opened", "synchronize", "reopened", "edited"] },
        workflow_dispatch: expect.any(Object),
      }),
    );
    expect(workflow.concurrency).toEqual({
      group:
        "openshell-sdk-package-${{ inputs.repair_attempt_key || github.event.pull_request.number }}-${{ github.event.action != 'edited' || github.event.changes.base != null }}",
      "cancel-in-progress": "${{ github.event_name != 'workflow_dispatch' }}",
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({
      contents: "read",
      packages: "read",
      "pull-requests": "read",
    });
    expect(job.if).toBe(
      "${{ github.event_name == 'workflow_dispatch' || (github.event.pull_request.head.repo.full_name == github.repository && (github.event.action != 'edited' || github.event.changes.base != null)) }}",
    );
    expect(job["timeout-minutes"]).toBe(5);

    const checkout = requiredStep(job, "Checkout base-controlled package verifier");
    expect(checkout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout.with).toMatchObject({
      ref: "${{ inputs.repair_attempt_key != '' && inputs.repair_base_sha || github.event.pull_request.base.sha }}",
      "persist-credentials": false,
    });
    expect(String(checkout.with?.["sparse-checkout"])).not.toContain("pull_request.head");

    const fetch = requiredStep(job, "Download and verify exact OpenShell SDK package");
    expect(fetch.env).toEqual({
      NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY: "${{ runner.temp }}/openshell-sdk",
      NODE_AUTH_TOKEN: "${{ github.token }}",
    });
    expect(fetch.run).toContain("node scripts/checks/package-openshell-sdk-for-pr.mts");
    expect(fetch.run).toContain("artifact_path=");
    expect(
      (job.steps ?? [])
        .filter((candidate) => candidate.name !== fetch.name)
        .map((candidate) => candidate.env?.NODE_AUTH_TOKEN),
    ).toEqual(
      (job.steps ?? []).filter((candidate) => candidate.name !== fetch.name).map(() => undefined),
    );

    const upload = requiredStep(job, "Upload verified OpenShell SDK archive");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      name: "openshell-sdk-${{ inputs.repair_attempt_key != '' && inputs.repair_head_sha || github.event.pull_request.head.sha }}",
      path: "${{ steps.package.outputs.artifact_path }}",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
  });
});
