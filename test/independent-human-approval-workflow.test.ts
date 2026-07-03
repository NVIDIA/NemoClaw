// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import YAML from "yaml";
import { describe, expect, it } from "vitest";

interface WorkflowStep {
  name?: string;
  uses?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface WorkflowJob {
  name?: string;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
}

interface Workflow {
  on: Record<string, { types?: string[]; workflows?: string[] }>;
  permissions: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
}

const root = path.resolve(import.meta.dirname, "..");
const reconcilerPath = path.join(root, ".github", "workflows", "independent-human-approval.yaml");
const signalPath = path.join(
  root,
  ".github",
  "workflows",
  "independent-human-approval-review-signal.yaml",
);
const reconcilerSource = fs.readFileSync(reconcilerPath, "utf-8");
const signalSource = fs.readFileSync(signalPath, "utf-8");
const reconciler = YAML.parse(reconcilerSource) as Workflow;
const signal = YAML.parse(signalSource) as Workflow;
const reconcilerSteps = Object.values(reconciler.jobs).flatMap((job) => job.steps ?? []);
const signalSteps = Object.values(signal.jobs).flatMap((job) => job.steps ?? []);
const checkoutSteps = reconcilerSteps.filter((step) => step.uses?.startsWith("actions/checkout@"));

describe("independent human approval workflow boundary", () => {
  it("routes review changes through an unprivileged non-required signal (#6222)", () => {
    expect(signal.on.pull_request_review.types).toEqual(["submitted", "edited", "dismissed"]);
    expect(signal.permissions).toEqual({});
    expect(Object.values(signal.jobs).map((job) => job.name)).not.toContain(
      "independent-human-approval",
    );
    expect(signalSteps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(signalSource).not.toContain("secrets.");
    expect(signalSource).not.toContain("checks: write");
  });

  it("uses only trusted events to publish or reconcile the exact-head check (#6222)", () => {
    expect(reconciler.on.pull_request_target.types).toEqual(["opened", "synchronize"]);
    expect(reconciler.on.workflow_run).toMatchObject({
      workflows: ["Policy / Independent Approval Review Signal"],
      types: ["completed"],
    });
    expect(reconciler.on).toHaveProperty("schedule");
    expect(reconciler.on).not.toHaveProperty("pull_request_review");
    expect(reconcilerSource).toContain("github.mts publish");
    expect(reconcilerSource).toContain("github.mts reconcile-open");
  });

  it("never exposes the required context as a conditionally skipped job (#6222)", () => {
    expect(Object.values(reconciler.jobs).map((job) => job.name)).not.toContain(
      "independent-human-approval",
    );
    expect(reconciler.permissions).toEqual({});
    expect(reconciler.jobs["record-contributors"].permissions).not.toHaveProperty("checks");
    expect(reconciler.jobs["reconcile-event-pr"].permissions).toMatchObject({
      checks: "write",
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
  });

  it("executes only pinned trusted-main policy code (#6222)", () => {
    expect(checkoutSteps).toHaveLength(3);
    expect(
      checkoutSteps.every(
        (step) =>
          step.with?.repository === "NVIDIA/NemoClaw" &&
          step.with?.ref === "main" &&
          step.with?.path === "trusted-policy" &&
          step.with?.["persist-credentials"] === false,
      ),
    ).toBe(true);
    expect(
      reconcilerSteps
        .filter((step) => step.uses)
        .every((step) => /@[0-9a-f]{40}$/u.test(step.uses ?? "")),
    ).toBe(true);
    expect(reconcilerSource).not.toContain("secrets.");
    expect(reconcilerSource).not.toContain("pull_request.head.repo");
  });

  it("binds contributor observations to the event head and an idempotency key (#6222)", () => {
    expect(reconcilerSource).toContain("EXPECTED_HEAD_SHA");
    expect(reconcilerSource).toContain("github.event.pull_request.head.sha");
    expect(reconcilerSource).toContain("EVENT_ID");
    expect(reconcilerSource).toContain("github.run_id");
    expect(reconcilerSource).toContain("BEFORE_SHA");
    expect(reconcilerSource).not.toContain("dismiss-review");
  });
});
