// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  readYaml,
  type WorkflowJob,
  type WorkflowStep,
} from "../../helpers/e2e-workflow-contract.ts";

const WORKFLOW_PATH = ".github/workflows/pr-review-coordinator-shadow-sample.yaml";

type SampleWorkflow = {
  name: string;
  on: {
    workflow_run: {
      workflows: string[];
      types: string[];
    };
  };
  permissions: Record<string, string>;
  jobs: { collect: WorkflowJob };
};

function workflow(): SampleWorkflow {
  return readYaml<SampleWorkflow>(WORKFLOW_PATH);
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

describe("coordinator shadow sample workflow boundary", () => {
  it("is triggered only by completed Advisor runs", () => {
    const value = workflow();
    expect(value.name).toBe("Automation / PR Review Coordinator Shadow Sample");
    expect(value.on).toEqual({
      workflow_run: {
        workflows: ["Automation / PR Review Advisor"],
        types: ["completed"],
      },
    });
    expect(value.permissions).toEqual({});
    expect(Object.keys(value.jobs)).toEqual(["collect"]);
  });

  // source-shape-contract: security -- Exact event provenance keeps untrusted pull request runs from entering the trusted sample collector
  it.each([
    "github.repository == 'NVIDIA/NemoClaw'",
    "github.event.workflow_run.status == 'completed'",
    "github.event.workflow_run.conclusion == 'success' ||",
    "github.event.workflow_run.conclusion == 'failure'",
    "github.event.workflow_run.event == 'workflow_run'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == 'NVIDIA/NemoClaw'",
    "github.event.workflow_run.path == '.github/workflows/pr-review-advisor.yaml'",
  ])("fails closed on exact automatic Advisor evidence [%s]", (fragment) => {
    expect(workflow().jobs.collect.if).toContain(fragment);
  });

  it("serializes collection with read-only permissions and trusted code", () => {
    const job = workflow().jobs.collect;
    expect(job.concurrency).toEqual({
      group: "pr-review-coordinator-shadow-sample",
      "cancel-in-progress": false,
    });
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    expect(job["runs-on"]).toBe("ubuntu-24.04");
    expect(job["timeout-minutes"]).toBe(5);
    const checkout = step(job, "Checkout trusted sample collector");
    expect(checkout.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout.with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      lfs: false,
      submodules: false,
    });
    expect(collectStrings(job).some((value) => value.includes("secrets."))).toBe(false);
  });

  it("collects one event-bound sample and retains it without repository writes", () => {
    const job = workflow().jobs.collect;
    const collect = step(job, "Collect distinct read-only decision");
    expect(collect.env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      SOURCE_RUN_ID: "${{ github.event.workflow_run.id }}",
    });
    expect(collect.run).toBe("node --no-warnings tools/pr-review-coordinator/shadow-sample.mts");
    const upload = step(job, "Retain shadow sample");
    expect(upload.if).toBe("${{ steps.collect.outputs.sampled == 'true' }}");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toEqual({
      name: "pr-review-coordinator-shadow-sample",
      path: "artifacts/pr-review-coordinator-shadow-sample/sample.json",
      "if-no-files-found": "error",
      "retention-days": 90,
    });
    expect(
      collectStrings(job).some((value) => /pulls\/.+\/reviews|issues\/.+\/comments/u.test(value)),
    ).toBe(false);
  });
});
