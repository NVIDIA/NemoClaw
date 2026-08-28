// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { readYaml, type WorkflowJob, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";

const WORKFLOW_PATH = ".github/workflows/hosted-runner-recovery.yaml";
const PLATFORM_WORKFLOW_PATH = ".github/workflows/platform-vitest-main.yaml";
const TRUSTED_CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const TRUSTED_SETUP_NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";

type RecoveryWorkflow = {
  name: string;
  "run-name": string;
  on: {
    workflow_run: {
      workflows: string[];
      types: string[];
    };
  };
  permissions: Record<string, string>;
  jobs: {
    recover: WorkflowJob;
  };
};

type SourceWorkflowIdentity = {
  name: string;
  "run-name"?: string;
};

function workflow(): RecoveryWorkflow {
  return readYaml<RecoveryWorkflow>(WORKFLOW_PATH);
}

function sourceWorkflow(path: string): SourceWorkflowIdentity {
  return readYaml<SourceWorkflowIdentity>(path);
}

function step(job: WorkflowJob, name: string): WorkflowStep {
  const match = job.steps?.find((candidate) => candidate.name === name);
  expect(match, `missing workflow step ${name}`).toBeDefined();
  return match!;
}

function collectStrings(value: unknown): string[] {
  return typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(collectStrings)
      : value && typeof value === "object"
        ? Object.values(value).flatMap(collectStrings)
        : [];
}

describe("hosted-runner recovery workflow boundary", () => {
  it("subscribes only to completed platform-evidence runs (#7140)", () => {
    const value = workflow();
    expect(value.name).toBe("Automation / Recover Platform CI Runner");
    expect(value.on).toEqual({
      workflow_run: {
        workflows: ["CI / Platform Compatibility"],
        types: ["completed"],
      },
    });
    expect(value.permissions).toEqual({});
    expect(value).not.toHaveProperty("concurrency");
    expect(value.jobs.recover.concurrency).toEqual({
      group: "hosted-runner-recovery-${{ github.event.workflow_run.workflow_id }}",
      "cancel-in-progress": false,
    });
    expect(value.jobs.recover.concurrency).not.toHaveProperty("queue");
    expect(Object.keys(value.jobs)).toEqual(["recover"]);
  });

  it.each(
    [
        "github.run_attempt == 1",
        "github.repository == 'NVIDIA/NemoClaw'",
        "github.event.workflow_run.run_attempt == 1",
        "github.event.workflow_run.status == 'completed'",
        "github.event.workflow_run.conclusion == 'failure'",
        "github.event.workflow_run.head_branch == 'main'",
        "github.event.workflow_run.head_repository.full_name == 'NVIDIA/NemoClaw'",
        "github.event.workflow_run.path == '.github/workflows/platform-vitest-main.yaml'",
      ],
  )(
    "fails closed on controller, source, repository, branch, event, and path [%s] (#7140)",
    (fragment) => {
      const guard = workflow().jobs.recover.if ?? "";

      expect(guard).toContain(fragment);

      expect(guard).not.toContain("pull_request");
    },
  );

  it("uses only the least privileges and trusted default-branch controller (#7140)", () => {
    const job = workflow().jobs.recover;
    expect(job["runs-on"]).toBe("ubuntu-latest");
    expect(job["timeout-minutes"]).toBe(15);
    expect(job.permissions).toEqual({
      actions: "write",
      checks: "read",
      contents: "read",
    });

    const checkout = step(job, "Checkout trusted recovery controller");
    expect(checkout.uses).toBe(TRUSTED_CHECKOUT);
    expect(checkout.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    const setupNode = step(job, "Setup Node.js");
    expect(setupNode.uses).toBe(TRUSTED_SETUP_NODE);
    expect(setupNode.with).toEqual({ "node-version": "22" });
    expect(
      job.steps?.filter((candidate) => candidate.uses?.startsWith("actions/checkout@")),
    ).toHaveLength(1);
    expect(collectStrings(job).some((value) => value.includes("secrets."))).toBe(false);
    expect(collectStrings(job).some((value) => value.includes("npm ci"))).toBe(false);
    expect(
      collectStrings(job).some((value) => value.includes("github.event.workflow_run.head_sha")),
    ).toBe(false);
  });

  it("runs native TypeScript with bounded metadata and no source checkout (#7140)", () => {
    const evaluate = step(workflow().jobs.recover, "Evaluate exact hosted-runner-loss evidence");
    expect(evaluate.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      SOURCE_RUN_ID: "${{ github.event.workflow_run.id }}",
    });
    expect(evaluate.run).toBe(
      "node --experimental-strip-types --no-warnings tools/e2e/hosted-runner-recovery.mts",
    );
  });

  it("writes only a static policy sentence to the job summary (#7140)", () => {
    const summary = step(workflow().jobs.recover, "Record static recovery policy");
    expect(summary.if).toBe("${{ always() }}");
    expect(summary.run).toBe(
      "printf '%s\\n' 'Hosted-runner recovery evaluated the fail-closed latest-eligible main-run policy.' >> \"$GITHUB_STEP_SUMMARY\"",
    );
    expect(summary.run).not.toContain("${{");
    expect(summary.run).not.toContain("SOURCE_RUN");
  });
});
