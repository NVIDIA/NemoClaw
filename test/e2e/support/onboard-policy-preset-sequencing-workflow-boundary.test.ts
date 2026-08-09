// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

// #6042: onboard-policy-preset-sequencing.test.ts drives the real
// interactive onboard wizard through a PTY; forcing non-interactive mode
// (as cloud-onboard and double-onboard both do) would defeat the whole
// regression. Prove the job selects the right test file today, and that
// reintroducing NEMOCLAW_NON_INTERACTIVE on this job is caught.
describe("onboard-policy-preset-sequencing workflow boundary", () => {
  // source-shape-contract: compatibility -- Every checked-in job selection must point at the live regression file it claims to run.
  it("selects onboard-policy-preset-sequencing.test.ts with interactive mode enabled", () => {
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps?: Array<Record<string, unknown>> }
      >;
    };
    const job = workflow.jobs["onboard-policy-preset-sequencing"];
    expect(job, "workflow missing onboard-policy-preset-sequencing job").toBeTruthy();
    expect(job!.env?.NEMOCLAW_NON_INTERACTIVE).toBeUndefined();
    const runStep = job!.steps?.find((step) =>
      String(step.run ?? "").includes("tools/e2e/live-vitest-invocation.mts run --test-path"),
    );
    expect(runStep, "expected a live-vitest-invocation step").toBeTruthy();
    expect(String(runStep!.run)).toContain(
      "test/e2e/live/onboard-policy-preset-sequencing.test.ts",
    );
  });

  // source-shape-contract: security -- Forcing this job non-interactive would silently defeat the whole PTY-driven regression it exists to run.
  it("rejects onboard-policy-preset-sequencing forced back into non-interactive mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { env?: Record<string, unknown> }>;
    };
    const job = workflow.jobs["onboard-policy-preset-sequencing"];
    expect(job, "workflow missing onboard-policy-preset-sequencing job").toBeTruthy();
    job!.env = { ...job!.env, NEMOCLAW_NON_INTERACTIVE: "1" };
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "onboard-policy-preset-sequencing job must not set NEMOCLAW_NON_INTERACTIVE; the test requires real interactive mode",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
