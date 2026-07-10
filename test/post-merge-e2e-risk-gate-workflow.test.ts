// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function runWaitStep(
  scenario: "success" | "failure" | "query-failure" | "timeout" | "unsupported",
  options: { runId?: string } = {},
) {
  const workflow = readYaml<TriggeredWorkflow>(SHADOW_PATH);
  const wait = step(workflow.jobs.shadow, "Wait for correlated E2E run");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-shadow-wait-"));
  const binDir = path.join(tempDir, "bin");
  const callCountPath = path.join(tempDir, "gh-call-count");
  fs.mkdirSync(binDir);
  fs.writeFileSync(callCountPath, "0\n");
  fs.writeFileSync(
    path.join(binDir, "gh"),
    `#!/usr/bin/env bash
set -euo pipefail
count="$(cat "$FAKE_GH_CALL_COUNT")"
count=$((count + 1))
printf '%s\n' "$count" > "$FAKE_GH_CALL_COUNT"
case "$FAKE_GH_SCENARIO:$count" in
  success:1 | success:2 | failure:1) printf 'in_progress:none\n' ;;
  success:*) printf 'completed:success\n' ;;
  failure:*) printf 'completed:failure\n' ;;
  query-failure:*) printf 'simulated GitHub query failure\n' >&2; exit 1 ;;
  unsupported:*) printf 'completed:unknown\n' ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(binDir, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "$FAKE_GH_SCENARIO" = "timeout" ]; then
  exit 124
fi
shift 3
exec "$@"
`,
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", wait.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_CALL_COUNT: callCountPath,
        FAKE_GH_SCENARIO: scenario,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RUN_ID: options.runId ?? "29110351531",
      },
      timeout: 5_000,
    });
    return {
      ...result,
      ghCallCount: Number(fs.readFileSync(callCountPath, "utf8").trim()),
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
    const startupFallback = step(job, "Close shadow check after controller startup failure");
    const wait = step(job, "Wait for correlated E2E run");
    const download = step(job, "Download correlated E2E evidence");
    const finish = step(job, "Complete exact-commit shadow check");
    const completionFallback = step(job, "Close shadow check after completion failure");
    const summary = step(job, "Summarize shadow controller");
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
    expect(start["continue-on-error"]).not.toBe(true);
    expect(startupFallback.if).toContain("always()");
    expect(startupFallback.if).toContain("steps.start.outputs.check_id != ''");
    expect(startupFallback.if).toContain("steps.start.outputs.dispatched != 'true'");
    expect(startupFallback.if).toContain("steps.start.outputs.finalized != 'true'");
    expect(startupFallback.run).toContain("post-merge-risk-gate.mts --mode abandon");
    expect(wait.run).toContain("timeout --signal=TERM --kill-after=30s 105m");
    expect(wait.run).toContain('gh run view "$RUN_ID" --repo "$GITHUB_REPOSITORY"');
    expect(wait.run).toContain("--json status,conclusion");
    expect(wait.run).toContain('if [[ "$state" != "$last_state" ]]');
    expect(wait.run).toContain('case "$state" in');
    expect(wait.run).toContain("completed:success");
    expect(wait.run).toContain("completed:failure");
    expect(wait.run).toContain("sleep 10");
    expect(wait.run).toContain('if [ "$wait_status" -eq 124 ]');
    expect(wait.run).toContain('exit "$wait_status"');
    expect(wait.run).not.toContain("gh run watch");
    expect(wait.run).not.toContain("--json jobs");
    expect(wait.run).not.toContain("2>/dev/null");
    expect(wait["continue-on-error"]).toBe(true);
    expect(wait.env?.RUN_ID).toBe("${{ steps.start.outputs.run_id }}");
    expect(download.run).toContain('--dir "${{ steps.workspace.outputs.work_dir }}/evidence"');
    expect(download["continue-on-error"]).toBe(true);
    expect(download.env?.RUN_ID).toBe("${{ steps.start.outputs.run_id }}");
    expect(finish.id).toBe("finish");
    expect(finish.if).toContain("always()");
    expect(finish["continue-on-error"]).not.toBe(true);
    expect(finish.run).toContain("post-merge-risk-gate.mts --mode finish");
    expect(finish.run).toContain('--work-dir "${{ steps.workspace.outputs.work_dir }}"');
    expect(finish.run).toContain('--state-hash "${{ steps.start.outputs.state_hash }}"');
    expect(finish.run).toContain('--check-id "${{ steps.start.outputs.check_id }}"');
    expect(finish.run).toContain('--run-id "${{ steps.start.outputs.run_id }}"');
    expect(completionFallback.if).toContain("always()");
    expect(completionFallback.if).toContain("steps.finish.outcome == 'failure'");
    expect(completionFallback.if).toContain("steps.finish.outputs.finalized != 'true'");
    expect(completionFallback.run).toContain("post-merge-risk-gate.mts --mode abandon");
    expect(job.steps?.some((candidate) => candidate.name?.startsWith("Propagate "))).toBe(false);
    expect(summary.if).toContain("always()");
    expect(summary.run).toContain("GITHUB_STEP_SUMMARY");
    expect(summary.run).toContain("Controller run");
    expect(summary.run).toContain("Selected jobs");
    expect(summary.run).toContain("Correlated E2E");
    expect(summary.run).toContain("Child conclusion");
    expect(summary.run).toContain("Failure phase");
    expect(cleanup.if).toContain("always() && steps.workspace.outputs.work_dir != ''");
    expect(cleanup.run).toContain('rm -rf -- "${{ steps.workspace.outputs.work_dir }}"');
    expect(collectStrings(workflow).some((value) => value.includes("/tmp/"))).toBe(false);
  });

  it("logs each child-run state once and exits after success", () => {
    const result = runWaitStep("success");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
      expect.stringContaining("status=in_progress"),
      expect.stringContaining("status=completed conclusion=success"),
    ]);
    expect(result.stdout).not.toContain("JOBS");
  });

  it("surfaces a terminal child-run failure", () => {
    const result = runWaitStep("failure");

    expect(result.status).toBe(1);
    expect(result.stdout.match(/status=in_progress/gu)).toHaveLength(1);
    expect(result.stderr).toContain("::error title=Correlated E2E run did not succeed::");
    expect(result.stderr).toContain("completed with conclusion failure");
  });

  it("preserves GitHub CLI errors when status queries fail", () => {
    const result = runWaitStep("query-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated GitHub query failure");
    expect(result.stderr).toContain("::error title=Correlated E2E status query failed::");
  });

  it("labels only the bounded wait exit as a timeout", () => {
    const result = runWaitStep("timeout");

    expect(result.status).toBe(124);
    expect(result.stderr).toContain("::error title=Correlated E2E wait timed out::");
    expect(result.stderr).toContain("did not complete within 105 minutes");
  });

  it("rejects an invalid child-run ID before querying GitHub", () => {
    const result = runWaitStep("success", { runId: "invalid" });

    expect(result.status).toBe(1);
    expect(result.ghCallCount).toBe(0);
    expect(result.stderr).toContain("::error title=Invalid correlated E2E run ID::");
  });

  it("fails closed for an unsupported child-run state", () => {
    const result = runWaitStep("unsupported");

    expect(result.status).toBe(1);
    expect(result.ghCallCount).toBe(1);
    expect(result.stderr).toContain("::error title=Unexpected correlated E2E state::");
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
