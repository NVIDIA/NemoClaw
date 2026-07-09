// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { RISK_RULES } from "../tools/advisors/risk-plan.mts";
import {
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./helpers/e2e-workflow-contract.ts";

const SHADOW_PATH = ".github/workflows/post-merge-e2e-risk-gate-shadow.yaml";
const E2E_PATH = ".github/workflows/e2e.yaml";

type TriggeredWorkflow = Workflow & {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
};

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

describe("post-merge E2E risk gate shadow workflow", () => {
  it("uses a trusted main-push controller with minimal write permissions", () => {
    const workflow = readYaml<TriggeredWorkflow>(SHADOW_PATH);
    const job = workflow.jobs.shadow;

    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
    });
    expect(workflow.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
    });
    expect(job.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(job.if).toContain("github.ref == 'refs/heads/main'");
    expect(collectStrings(workflow).some((value) => value.includes("${{ secrets."))).toBe(false);
  });

  it("builds the plan from the exact trusted push and bounds child-run waiting", () => {
    const workflow = readYaml<TriggeredWorkflow>(SHADOW_PATH);
    const job = workflow.jobs.shadow;
    const checkout = step(job, "Checkout trusted controller");
    const workspace = step(job, "Create private controller workspace");
    const start = step(job, "Build plan and dispatch exact-commit E2E");
    const wait = step(job, "Wait for correlated E2E run");
    const download = step(job, "Download correlated E2E evidence");
    const finish = step(job, "Complete exact-commit shadow check");
    const completionFallback = step(job, "Close shadow check after completion failure");
    const propagateFailure = step(job, "Propagate shadow completion failure");
    const cleanup = step(job, "Remove private controller workspace");

    expect(checkout.with).toMatchObject({
      ref: "${{ github.event.after }}",
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    expect(workspace.run).toContain('mktemp -d "${RUNNER_TEMP}/nemoclaw-e2e-risk-gate.XXXXXX"');
    expect(workspace.run).toContain('chmod 700 "$work_dir"');
    expect(start.run).toContain("post-merge-risk-gate.mts --mode start");
    expect(start.run).toContain('--base "${{ github.event.before }}"');
    expect(start.run).toContain('--commit "${{ github.event.after }}"');
    expect(start.run).toContain('--work-dir "${{ steps.workspace.outputs.work_dir }}"');
    expect(wait.run).toContain("timeout --signal=TERM --kill-after=30s 105m");
    expect(wait.env?.RUN_ID).toBe("${{ steps.start.outputs.run_id }}");
    expect(download.run).toContain('--dir "${{ steps.workspace.outputs.work_dir }}/evidence"');
    expect(download.env?.RUN_ID).toBe("${{ steps.start.outputs.run_id }}");
    expect(finish.id).toBe("finish");
    expect(finish.if).toContain("always()");
    expect(finish["continue-on-error"]).toBe(true);
    expect(finish.run).toContain("post-merge-risk-gate.mts --mode finish");
    expect(finish.run).toContain('--work-dir "${{ steps.workspace.outputs.work_dir }}"');
    expect(finish.run).toContain('--state-hash "${{ steps.start.outputs.state_hash }}"');
    expect(finish.run).toContain('--check-id "${{ steps.start.outputs.check_id }}"');
    expect(finish.run).toContain('--run-id "${{ steps.start.outputs.run_id }}"');
    expect(completionFallback.if).toContain("steps.finish.outcome == 'failure'");
    expect(completionFallback.run).toContain("post-merge-risk-gate.mts --mode abandon");
    expect(propagateFailure.if).toContain("steps.finish.outcome == 'failure'");
    expect(cleanup.if).toContain("always() && steps.workspace.outputs.work_dir != ''");
    expect(cleanup.run).toContain('rm -rf -- "${{ steps.workspace.outputs.work_dir }}"');
    expect(collectStrings(workflow).some((value) => value.includes("/tmp/"))).toBe(false);
  });

  it("binds every E2E checkout and test signal to the merged commit", () => {
    const workflow = readYaml<
      Workflow & {
        env?: Record<string, string>;
        "run-name"?: string;
        concurrency?: { group: string; "cancel-in-progress": boolean };
      }
    >(E2E_PATH);
    const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const checkouts = allSteps.filter((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    const testCommands = allSteps
      .map((candidate) => candidate.run ?? "")
      .filter((run) => run.includes("npx vitest run --project e2e-live"));

    expect(workflow["run-name"]).toContain("inputs.risk_correlation");
    expect(workflow.concurrency?.group).not.toContain("inputs.risk_correlation");
    expect(workflow.concurrency?.group).toContain("inputs.risk_shadow && github.run_id");
    expect(workflow.env).toMatchObject({
      NEMOCLAW_E2E_EXPECTED_SHA: "${{ inputs.checkout_sha }}",
      NEMOCLAW_E2E_RISK_PLAN_HASH: "${{ inputs.risk_plan_hash }}",
      NEMOCLAW_E2E_RISK_CORRELATION: "${{ inputs.risk_correlation }}",
      NEMOCLAW_E2E_RISK_SHARD: "default",
    });
    expect(checkouts.length).toBeGreaterThan(50);
    expect(
      checkouts.every(
        (checkout) => checkout.with?.ref === "${{ inputs.checkout_sha || github.sha }}",
      ),
    ).toBe(true);
    expect(testCommands.length).toBeGreaterThan(50);
    expect(
      testCommands.every((run) => run.includes("--reporter=test/e2e/risk-signal-reporter.ts")),
    ).toBe(true);
    expect(workflow.jobs["cloud-onboard"].env?.NEMOCLAW_PUBLIC_INSTALL_REF).toBe(
      "${{ inputs.checkout_sha || github.sha }}",
    );
  });

  it("keeps every deterministic risk job signal-bearing and artifact-backed", () => {
    const workflow = readYaml<Workflow>(E2E_PATH);
    const requiredJobs = [...new Set(RISK_RULES.flatMap((rule) => rule.requiredJobs))];

    for (const jobId of requiredJobs) {
      const job = workflow.jobs[jobId];
      expect(job, `missing risk-plan job ${jobId}`).toBeDefined();
      expect(
        Array.isArray(job.needs) ? job.needs : [job.needs],
        `${jobId} must wait for exact-commit validation`,
      ).toContain("generate-matrix");
      expect(job.env?.E2E_TARGET_ID, `${jobId} must identify its risk signal`).toBe(jobId);
      const liveRuns = (job.steps ?? [])
        .map((candidate) => candidate.run ?? "")
        .filter((run) => run.includes("--project e2e-live"));
      expect(liveRuns.length, `${jobId} must execute a live Vitest target`).toBeGreaterThan(0);
      expect(
        liveRuns.every((run) => run.includes("--reporter=test/e2e/risk-signal-reporter.ts")),
        `${jobId} must write risk evidence for every live Vitest invocation`,
      ).toBe(true);
      const upload = (job.steps ?? []).find((candidate) =>
        candidate.uses?.includes("/.github/actions/upload-e2e-artifacts@"),
      );
      expect(upload, `${jobId} must upload its risk signal`).toBeDefined();
      expect(upload?.if).toBe("always()");
    }

    expect(workflow.jobs["security-posture"].env?.NEMOCLAW_E2E_RISK_SHARD).toBe(
      "${{ matrix.agent }}",
    );
    expect(workflow.jobs["channels-stop-start"].env?.NEMOCLAW_E2E_RISK_SHARD).toBe(
      "${{ matrix.agent }}",
    );
  });

  it("validates shadow inputs before preparing or executing the selected workspace", () => {
    const workflow = readYaml<Workflow>(E2E_PATH);
    const steps = workflow.jobs["generate-matrix"].steps ?? [];
    const validateIndex = steps.findIndex(
      (candidate) => candidate.name === "Validate exact-commit dispatch",
    );
    const prepareIndex = steps.findIndex((candidate) => candidate.name === "Prepare E2E workspace");
    const validate = steps[validateIndex];

    expect(validateIndex).toBeGreaterThan(0);
    expect(validateIndex).toBeLessThan(prepareIndex);
    expect(validate?.if).toContain("inputs.checkout_sha != ''");
    expect(validate?.env?.WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(validate?.run).toContain('[[ "$RISK_SHADOW" == "true" ]]');
    expect(validate?.run).toContain("exact-commit inputs require risk_shadow=true");
    expect(validate?.run).toContain("checkout_sha must be a lowercase 40-character SHA");
    expect(validate?.run).toContain('[[ "$CHECKOUT_SHA" == "$WORKFLOW_SHA" ]]');
    expect(validate?.run).toContain("checkout_sha must equal the current main workflow commit");
    expect(validate?.run).toContain('"$(git rev-parse --verify HEAD)" == "$CHECKOUT_SHA"');
    expect(validate?.run).toContain('git merge-base --is-ancestor "$CHECKOUT_SHA" origin/main');
    expect(validate?.run).toContain("forbid targets/fan-out");
    expect(steps[0]?.with?.["fetch-depth"]).toBe(0);
    expect(workflow.jobs["report-to-pr"].if).toContain("!inputs.risk_shadow");
    expect(workflow.jobs.scorecard.if).toContain("!inputs.risk_shadow");
  });
});
