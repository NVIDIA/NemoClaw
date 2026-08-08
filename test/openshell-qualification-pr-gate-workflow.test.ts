// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowJob, type WorkflowStep } from "./helpers/e2e-workflow-contract";

type QualificationWorkflow = {
  name: string;
  "run-name": string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
};

const workflow = readYaml<QualificationWorkflow>(
  ".github/workflows/openshell-0.0.101-pr-gate.yaml",
);

function job(name: string): WorkflowJob {
  const value = workflow.jobs[name];
  assert(value, `missing workflow job ${name}`);
  return value;
}

function step(owner: WorkflowJob, name: string): WorkflowStep {
  const value = owner.steps?.find((candidate) => candidate.name === name);
  assert(value, `missing workflow step ${name}`);
  return value;
}

describe("OpenShell qualification PR gate workflow", () => {
  it("checks out candidate data only after trusted applicability classification (#8600)", () => {
    const classify = job("classify");
    const receipt = job("qualification-receipt");
    const candidateCheckout = step(receipt, "Checkout candidate qualification data");

    expect(classify.steps?.some((candidate) => candidate.name?.includes("candidate"))).toBe(false);
    expect(receipt.needs).toBe("classify");
    expect(receipt.if).toMatch(/outputs\.required == 'true'/u);
    expect(receipt.if).toMatch(/outputs\.same-repository == 'true'/u);
    expect(candidateCheckout.uses).toBe(
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    );
    expect(candidateCheckout.with).toMatchObject({
      repository: "${{ github.event.pull_request.head.repo.full_name }}",
      ref: "${{ github.event.pull_request.head.sha }}",
      path: ".candidate-openshell-qualification",
      "allow-unsafe-pr-checkout": true,
      "persist-credentials": false,
      "sparse-checkout-cone-mode": false,
    });
    expect(candidateCheckout.with?.["sparse-checkout"]).toBe(
      "ci/openshell-0.0.101-qualification-v1.json\nnemoclaw-blueprint/blueprint.yaml\n",
    );
    expect(
      receipt.steps?.every((candidate) => JSON.stringify(candidate).includes("secrets.") === false),
    ).toBe(true);
  });

  it("authenticates effective rules without an organization administrator credential (#8600)", () => {
    const authority = job("qualification-authority");
    const authorityStep = step(authority, "Authenticate effective required-workflow authority");

    expect(authority.needs).toEqual(["classify", "qualification-receipt"]);
    expect(authority.steps?.some((candidate) => candidate.name?.includes("candidate"))).toBe(false);
    expect(authorityStep.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
  });

  it("always reports one stable required context and fails closed around skipped prerequisites (#8600)", () => {
    const reporter = job("openshell-qualification");
    const report = step(reporter, "Report qualification decision");

    expect(reporter.name).toBe("openshell-qualification");
    expect(reporter.if).toBe("always()");
    expect(reporter.needs).toEqual([
      "classify",
      "qualification-receipt",
      "qualification-authority",
    ]);
    expect(report.env).toEqual({
      AUTHORITY_REQUIRED: "${{ needs.qualification-receipt.outputs.authority-required }}",
      AUTHORITY_RESULT: "${{ needs.qualification-authority.result }}",
      CLASSIFY_RESULT: "${{ needs.classify.result }}",
      RECEIPT_RESULT: "${{ needs.qualification-receipt.result }}",
      RECEIPT_REQUIRED: "${{ needs.qualification-receipt.outputs.receipt-required }}",
      REQUIRED: "${{ needs.classify.outputs.required }}",
      SAME_REPOSITORY: "${{ needs.classify.outputs.same-repository }}",
    });
    expect(report.run).toMatch(/CLASSIFY_RESULT.*success/su);
    expect(report.run).toMatch(/REQUIRED.*true/su);
    expect(report.run).toMatch(/SAME_REPOSITORY.*true/su);
    expect(report.run).toMatch(/RECEIPT_RESULT.*success/su);
    expect(report.run).toMatch(/AUTHORITY_RESULT.*success/su);
  });

  it.each([
    {
      disposition: "non-sensitive fork fast-pass",
      env: {
        AUTHORITY_REQUIRED: "",
        AUTHORITY_RESULT: "skipped",
        CLASSIFY_RESULT: "success",
        RECEIPT_RESULT: "skipped",
        RECEIPT_REQUIRED: "",
        REQUIRED: "false",
        SAME_REPOSITORY: "false",
      },
      expectedStatus: 0,
    },
    {
      disposition: "sensitive fork fail-closed",
      env: {
        AUTHORITY_REQUIRED: "",
        AUTHORITY_RESULT: "skipped",
        CLASSIFY_RESULT: "success",
        RECEIPT_RESULT: "skipped",
        RECEIPT_REQUIRED: "",
        REQUIRED: "true",
        SAME_REPOSITORY: "false",
      },
      expectedStatus: 1,
    },
  ])("enforces $disposition behavior (#8600)", ({ env, expectedStatus }) => {
    const report = step(job("openshell-qualification"), "Report qualification decision");
    assert(report.run);
    const result = spawnSync("bash", ["-c", report.run], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });

    expect(result.status).toBe(expectedStatus);
  });
});
