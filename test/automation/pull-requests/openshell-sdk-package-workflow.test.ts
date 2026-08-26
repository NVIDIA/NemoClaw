// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob } from "../../helpers/e2e-workflow-contract";

type Workflow = Readonly<{
  concurrency?: Readonly<Record<string, unknown>>;
  jobs: Readonly<Record<string, WorkflowJob>>;
  on?: Readonly<Record<string, unknown>>;
  permissions?: Readonly<Record<string, string>>;
}>;

const workflow = readYaml<Workflow>(".github/workflows/openshell-sdk-package-pr.yaml");
const job = workflow.jobs["package-openshell-sdk"];

function step(name: string) {
  const value = job.steps?.find((candidate) => candidate.name === name);
  expect(value, `Missing package workflow step: ${name}`).toBeDefined();
  return value as NonNullable<typeof value>;
}

describe("base-controlled OpenShell SDK package workflow", () => {
  // source-shape-contract: security -- The package credential must remain in a base-loaded workflow that uploads only the verified SDK archive
  it("keeps package access out of pull request controlled execution", () => {
    expect(workflow.on).toEqual({
      pull_request_target: { types: ["opened", "synchronize", "reopened"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", packages: "read" });
    expect(job["timeout-minutes"]).toBe(5);

    const checkout = step("Checkout base-controlled package verifier");
    expect(checkout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout.with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      "persist-credentials": false,
    });
    expect(String(checkout.with?.["sparse-checkout"])).not.toContain("pull_request.head");

    const fetch = step("Download and verify exact OpenShell SDK package");
    expect(fetch.env).toEqual({
      NEMOCLAW_OPEN_SHELL_SDK_OUTPUT_DIRECTORY: "${{ runner.temp }}/openshell-sdk",
      NODE_AUTH_TOKEN: "${{ github.token }}",
    });
    expect(fetch.run).toBe(
      "node --experimental-strip-types scripts/checks/package-openshell-sdk-for-pr.mts",
    );
    expect(
      (job.steps ?? [])
        .filter((candidate) => candidate.name !== fetch.name)
        .map((candidate) => candidate.env?.NODE_AUTH_TOKEN),
    ).toEqual(
      (job.steps ?? []).filter((candidate) => candidate.name !== fetch.name).map(() => undefined),
    );

    const upload = step("Upload verified OpenShell SDK archive");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      name: "openshell-sdk-${{ github.event.pull_request.head.sha }}",
      path: "${{ runner.temp }}/openshell-sdk/nvidia-openshell-sdk-0.0.106.tgz",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
  });
});
