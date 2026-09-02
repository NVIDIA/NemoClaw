// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";

const root = path.resolve(import.meta.dirname, "../../..");
const source = fs.readFileSync(
  path.join(root, ".github", "workflows", "pr-review-advisor-repair-reconcile.yaml"),
  "utf8",
);
const workflow = YAML.parse(source) as Record<string, unknown>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function steps(job: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(job.steps) ? (job.steps as Array<Record<string, unknown>>) : [];
}

function namedStep(job: Record<string, unknown>, name: string): Record<string, unknown> {
  const step = steps(job).find((candidate) => candidate.name === name);
  expect(step, `Missing workflow step: ${name}`).toBeDefined();
  return step as Record<string, unknown>;
}

describe("PR Review Advisor repair reconciliation workflow boundary", () => {
  const jobs = record(workflow.jobs);
  const collect = record(jobs.collect);
  const publish = record(jobs.publish);
  const verify = record(jobs["verify-generated-head"]);

  it("is manual-only, serialized with Phase 1, and never invokes a model or Pi (#10791)", () => {
    expect(Object.keys(record(workflow.on))).toEqual(["workflow_dispatch"]);
    expect(workflow.permissions).toEqual({});
    expect(workflow.concurrency).toEqual({
      group: "pr-review-advisor-repair-phase1-${{ inputs.pr_number }}",
      "cancel-in-progress": false,
    });
    expect(Object.keys(jobs).sort()).toEqual(["collect", "publish", "verify-generated-head"]);
    expect(source).not.toMatch(/^\s+(?:push|pull_request|pull_request_target):/mu);
    expect(source).not.toContain("PR_REVIEW_ADVISOR_API_KEY");
    expect(source).not.toContain("OpenShell");
    expect(source).not.toContain("resolve.mts");
    expect(source).not.toContain("secrets.");
    expect(String(collect.if)).toContain("ADVISOR_REPAIR_PHASE1_ENABLED");
    expect(String(collect.if)).toContain("github.ref == 'refs/heads/main'");
    expect(String(publish.if)).toContain("ADVISOR_REPAIR_PHASE1_ENABLED");
    expect(
      record(
        namedStep(collect, "Verify maintainer authority and the original source-run artifact").env,
      ),
    ).toMatchObject({
      GITHUB_ACTOR: "${{ github.actor }}",
      GITHUB_TRIGGERING_ACTOR: "${{ github.triggering_actor }}",
    });
  });

  it("binds one original validation artifact and resumes only inside the protected publisher (#10791)", () => {
    expect(collect.permissions).toEqual({ actions: "read", contents: "read" });
    expect(publish.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "write",
      "pull-requests": "read",
    });
    expect(publish.environment).toBe("advisor-repair-publication");
    expect(
      record(
        namedStep(
          publish,
          "Reconcile the verified commit, atomic update, and validation dispatches",
        ).env,
      ),
    ).toMatchObject({
      ADVISOR_REPAIR_PHASE1_ENABLED: "${{ vars.ADVISOR_REPAIR_PHASE1_ENABLED }}",
    });
    expect(verify.permissions).toEqual({ actions: "read", checks: "write", contents: "read" });
    expect(JSON.stringify(verify)).not.toContain("Checkout the exact original source head");

    const collectDownload = record(
      namedStep(collect, "Download the exact original validation artifact ID").with,
    );
    expect(collectDownload).toMatchObject({
      "artifact-ids": "${{ steps.source.outputs.validation_artifact_id }}",
      repository: "NVIDIA/NemoClaw",
      "run-id": "${{ inputs.source_run_id }}",
      "merge-multiple": true,
    });
    const publishDownload = record(
      namedStep(publish, "Download the exact original validation artifact ID").with,
    );
    expect(publishDownload).toMatchObject({
      "artifact-ids": "${{ needs.collect.outputs.validation_artifact_id }}",
      repository: "NVIDIA/NemoClaw",
      "run-id": "${{ inputs.source_run_id }}",
      "merge-multiple": true,
    });
    expect(
      record(namedStep(publish, "Checkout the exact original source head").with),
    ).toMatchObject({
      ref: "${{ inputs.source_head_sha }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(
      String(
        namedStep(
          publish,
          "Reconcile the verified commit, atomic update, and validation dispatches",
        ).run,
      ),
    ).toContain("publish.mts");
  });

  it("pins every third-party action and uses credential-free trusted checkouts (#10791)", () => {
    const actionSteps = Object.values(jobs).map(record).flatMap(steps);
    const actions = actionSteps
      .map((step) => step.uses)
      .filter((uses): uses is string => typeof uses === "string");
    expect(actions.length).toBeGreaterThan(0);
    expect(
      actions.every((uses) => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(uses)),
    ).toBe(true);
    const trustedCheckouts = actionSteps.filter(
      (step) =>
        String(step.uses ?? "").startsWith("actions/checkout@") &&
        record(step.with).path === "trusted",
    );
    expect(trustedCheckouts).toHaveLength(3);
    const trustedCheckoutContract = expect.objectContaining({
      repository: "NVIDIA/NemoClaw",
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
      lfs: false,
      submodules: false,
      "sparse-checkout-cone-mode": false,
    });
    expect(trustedCheckouts.map((checkout) => record(checkout.with))).toEqual([
      trustedCheckoutContract,
      trustedCheckoutContract,
      trustedCheckoutContract,
    ]);
  });
});
