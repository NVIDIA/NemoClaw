// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  readYaml,
  type Workflow,
  type WorkflowJob,
  type WorkflowStep,
} from "./helpers/e2e-workflow-contract.ts";

const PR_GATE_PATH = ".github/workflows/pr-e2e-gate.yaml";
const E2E_PATH = ".github/workflows/e2e.yaml";

type CoordinatorJob = WorkflowJob & {
  concurrency?: { group: string; "cancel-in-progress": boolean };
};

type TriggeredWorkflow = Omit<Workflow, "jobs"> & {
  name: string;
  on: {
    workflow_run: { workflows: string[]; types: string[] };
    pull_request_target: { types: string[] };
  };
  permissions: Record<string, string>;
  jobs: Record<string, CoordinatorJob>;
};

type DispatchWorkflow = Workflow & {
  "run-name": string;
  on: {
    workflow_dispatch: {
      inputs: Record<string, unknown>;
    };
  };
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
  const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
  const wait = step(workflow.jobs.coordinate, "Wait for E2E run");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-wait-"));
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

function runStartStep(headBranch: string, prNumber = "42") {
  const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
  const start = step(workflow.jobs.coordinate, "Start evaluation");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-start-step-"));
  const binDir = path.join(tempDir, "bin");
  const argumentsPath = path.join(tempDir, "node-arguments");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "node"),
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\0\' "$@" > "$FAKE_NODE_ARGUMENTS"\n',
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", start.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        CI_CONCLUSION: "success",
        CI_RUN_ATTEMPT: "3",
        CI_RUN_ID: "99",
        FAKE_NODE_ARGUMENTS: argumentsPath,
        GITHUB_TOKEN: "token",
        HEAD_BRANCH: headBranch,
        HEAD_REPOSITORY: "NVIDIA/NemoClaw",
        HEAD_SHA: "a".repeat(40),
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PR_NUMBER: prNumber,
        WORKFLOW_SHA: "d".repeat(40),
        WORK_DIR: tempDir,
      },
      timeout: 5_000,
    });
    return {
      arguments: fs.readFileSync(argumentsPath, "utf8").split("\0").slice(0, -1),
      result,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function runChildValidation(currentPullSha: string) {
  const workflow = readYaml<DispatchWorkflow>(E2E_PATH);
  const validation = step(workflow.jobs["generate-matrix"], "Validate controller dispatch");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-child-"));
  const binDir = path.join(tempDir, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "git"),
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$FAKE_CHECKOUT_SHA\"\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "curl"),
    "#!/usr/bin/env bash\nset -euo pipefail\nprintf '{}\\n'\n",
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(binDir, "jq"),
    `#!/usr/bin/env bash
set -euo pipefail
case "\${2:-}" in
  .state) printf 'open\\n' ;;
  .head.repo.full_name*) printf 'NVIDIA/NemoClaw\\n' ;;
  .head.sha) printf '%s\\n' "$FAKE_PR_SHA" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  );

  try {
    return spawnSync("bash", ["-e", "-o", "pipefail", "-c", validation.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        CHECKOUT_SHA: "a".repeat(40),
        CORRELATION_ID: "12345678-1234-4123-8123-123456789abc",
        FAKE_CHECKOUT_SHA: "a".repeat(40),
        FAKE_PR_SHA: currentPullSha,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_TOKEN: "token",
        JOBS: "onboard-repair",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PLAN_HASH: "b".repeat(64),
        PR_NUMBER: "42",
        TARGETS: "",
        WORKFLOW_EVENT: "workflow_dispatch",
        WORKFLOW_REF: "refs/heads/main",
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("PR E2E gate workflow", () => {
  it("limits triggers and job permissions", () => {
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const cancel = workflow.jobs["cancel-superseded"];
    const coordinate = workflow.jobs.coordinate;

    expect(workflow.name).toBe("E2E / PR Gate");
    expect(workflow.on).toEqual({
      workflow_run: {
        workflows: ["CI / Pull Request"],
        types: ["completed"],
      },
      pull_request_target: {
        types: ["synchronize", "reopened", "closed"],
      },
    });
    expect(workflow.permissions).toEqual({});
    expect(cancel.if).toContain("github.event_name == 'pull_request_target'");
    expect(cancel.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(cancel.permissions).toEqual({ actions: "write", contents: "read" });
    expect(coordinate.if).toContain("github.event_name == 'workflow_run'");
    expect(coordinate.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(coordinate.if).toContain(
      "github.event.workflow_run.head_repository.full_name == github.repository",
    );
    expect(coordinate.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(collectStrings(workflow).some((value) => value.includes("${{ secrets."))).toBe(false);
  });

  it("pins both controller checkouts and installs without lifecycle scripts or caches", () => {
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const allSteps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);
    const checkouts = allSteps.filter((candidate) =>
      candidate.uses?.startsWith("actions/checkout@"),
    );
    const nodeSetups = allSteps.filter((candidate) =>
      candidate.uses?.startsWith("actions/setup-node@"),
    );
    const installs = allSteps.filter(
      (candidate) => candidate.name === "Install controller dependencies",
    );

    expect(checkouts).toHaveLength(2);
    expect(
      checkouts.every(
        (checkout) =>
          checkout.with?.ref === "${{ github.workflow_sha }}" &&
          checkout.with?.["persist-credentials"] === false,
      ),
    ).toBe(true);
    expect(nodeSetups).toHaveLength(2);
    expect(nodeSetups.every((setup) => setup.with?.["node-version"] === "22")).toBe(true);
    expect(nodeSetups.every((setup) => !("cache" in (setup.with ?? {})))).toBe(true);
    expect(installs).toHaveLength(2);
    expect(installs.every((install) => install.run === "npm ci --ignore-scripts")).toBe(true);
    expect(
      allSteps.some((candidate) => candidate.uses?.startsWith("actions/download-artifact@")),
    ).toBe(false);
  });

  it("cancels superseded PR runs", () => {
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const cancel = workflow.jobs["cancel-superseded"];
    const cancelStep = step(cancel, "Cancel superseded E2E runs");

    expect(cancelStep.run).toContain("tools/e2e/pr-e2e-gate.mts --mode cancel");
    expect(cancelStep.run).toContain('--pr "$PR_NUMBER"');
    expect(cancelStep.run).not.toContain("${{ github.event.");
    expect(cancelStep.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(cancelStep.env?.PR_NUMBER).toBe("${{ github.event.pull_request.number }}");
  });

  it.each([
    ["a single quote", "feature/'quoted"],
    ["a double quote", 'feature/"quoted'],
    ["command substitution", "feature/$(printf injected)"],
    ["a semicolon", "feature/branch;printf injected"],
    ["whitespace", "feature/space name"],
    ["a newline", "feature/line\nname"],
  ])("passes branch text containing $label as one inert shell argument", (_label, headBranch) => {
    const execution = runStartStep(headBranch);
    const branchFlag = execution.arguments.indexOf("--head-branch");

    expect(execution.result.status).toBe(0);
    expect(execution.result.stderr).toBe("");
    expect(execution.arguments.filter((argument) => argument === "--head-branch")).toHaveLength(1);
    expect(execution.arguments[branchFlag + 1]).toBe(headBranch);
  });

  it("passes an empty pull request association to the controller fallback", () => {
    const execution = runStartStep("feature/pr-e2e-gate", "");
    const prFlag = execution.arguments.indexOf("--pr");

    expect(execution.result.status).toBe(0);
    expect(execution.arguments[prFlag + 1]).toBe("");
  });

  it("coordinates the check around one E2E run", () => {
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const job = workflow.jobs.coordinate;
    const workspace = step(job, "Create private workspace");
    const start = step(job, "Start evaluation");
    const upload = step(job, "Upload risk plan");
    const wait = step(job, "Wait for E2E run");
    const download = step(job, "Download evidence");
    const finish = step(job, "Verify evidence");
    const fallback = step(job, "Close incomplete check");
    const cleanup = step(job, "Remove private workspace");

    expect(job.concurrency).toEqual({
      group:
        "pr-e2e-gate-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}",
      "cancel-in-progress": false,
    });
    expect(job["timeout-minutes"]).toBe(180);
    expect(workspace.run).toContain('mktemp -d "${RUNNER_TEMP}/nemoclaw-pr-e2e-gate.XXXXXX"');
    expect(workspace.run).toContain('chmod 700 "$work_dir"');
    expect(start.run).toContain("tools/e2e/pr-e2e-gate.mts --mode start");
    expect(start.run).toContain('--head "$HEAD_SHA"');
    expect(start.run).toContain('--head-repo "$HEAD_REPOSITORY"');
    expect(start.run).toContain('--head-branch "$HEAD_BRANCH"');
    expect(start.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(start.run).toContain('--ci-conclusion "$CI_CONCLUSION"');
    expect(start.run).toContain('--ci-run-attempt "$CI_RUN_ATTEMPT"');
    expect(start.run).toContain('--ci-run-id "$CI_RUN_ID"');
    expect(start.run).toContain('--pr "$PR_NUMBER"');
    expect(start.run).toContain('--work-dir "$WORK_DIR"');
    expect(start.run).not.toContain("${{ github.event.");
    expect(start.env).toMatchObject({
      CI_CONCLUSION: "${{ github.event.workflow_run.conclusion }}",
      CI_RUN_ATTEMPT: "${{ github.event.workflow_run.run_attempt }}",
      CI_RUN_ID: "${{ github.event.workflow_run.id }}",
      HEAD_BRANCH: "${{ github.event.workflow_run.head_branch }}",
      HEAD_REPOSITORY: "${{ github.event.workflow_run.head_repository.full_name }}",
      HEAD_SHA: "${{ github.event.workflow_run.head_sha }}",
      PR_NUMBER: "${{ github.event.workflow_run.pull_requests[0].number }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
      WORK_DIR: "${{ steps.workspace.outputs.work_dir }}",
    });
    expect(start.run).not.toContain("--mode initialize");
    expect(upload.if).toContain("steps.workspace.outputs.work_dir != ''");
    expect(upload.with?.name).toBe("pr-e2e-risk-plan-${{ github.event.workflow_run.head_sha }}");
    expect(upload.with?.path).toBe("${{ steps.workspace.outputs.work_dir }}/risk-plan.json");
    expect(wait.run).toContain("timeout --signal=TERM --kill-after=30s 105m");
    expect(wait.run).toContain('gh run view "$RUN_ID" --repo "$GITHUB_REPOSITORY"');
    expect(wait.run).toContain("--json status,conclusion");
    expect(wait.run).toContain('if [[ "$state" != "$last_state" ]]');
    expect(wait.run).toContain("completed:success");
    expect(wait.run).toContain("completed:failure");
    expect(wait.run).toContain("sleep 10");
    expect(wait.run).toContain('if [ "$wait_status" -eq 124 ]');
    expect(wait.run).toContain('exit "$wait_status"');
    expect(wait.run).not.toContain("gh run watch");
    expect(wait.run).not.toContain("--json jobs");
    expect(wait.run).not.toContain("2>/dev/null");
    expect(wait["continue-on-error"]).toBe(true);
    expect(download.if).toContain("always()");
    expect(download.run).toContain("timeout --signal=TERM --kill-after=30s 10m");
    expect(download.run).toContain('if [ "$download_status" -eq 124 ]');
    expect(download.run).toContain('--dir "${{ steps.workspace.outputs.work_dir }}/evidence"');
    expect(download["continue-on-error"]).toBe(true);
    expect(finish.if).toContain("always()");
    expect(finish.run).toContain("tools/e2e/pr-e2e-gate.mts --mode finish");
    expect(finish.run).toContain('--state-hash "${{ steps.start.outputs.state_hash }}"');
    expect(finish.run).toContain('--check-id "${{ steps.start.outputs.check_id }}"');
    expect(finish.run).toContain('--run-id "${{ steps.start.outputs.run_id }}"');
    expect(fallback.if).toContain("always()");
    expect(fallback.if).toContain("steps.start.outputs.check_id != ''");
    expect(fallback.if).toContain("steps.start.outputs.finalized != 'true'");
    expect(fallback.if).toContain("steps.finish.outputs.finalized != 'true'");
    expect(fallback.run).toContain("tools/e2e/pr-e2e-gate.mts --mode abandon");
    expect(fallback.run).toContain('--run-id "${{ steps.start.outputs.run_id }}"');
    expect(cleanup.if).toContain("always() && steps.workspace.outputs.work_dir != ''");
    expect(cleanup.run).toContain('rm -rf -- "${{ steps.workspace.outputs.work_dir }}"');
    expect(collectStrings(workflow).some((value) => value.includes("/tmp/"))).toBe(false);
  });

  it("uses one child dispatch protocol and one correlated run title", () => {
    const workflow = readYaml<DispatchWorkflow>(E2E_PATH);
    const inputs = workflow.on.workflow_dispatch.inputs;

    expect(inputs).toEqual(
      expect.objectContaining({
        jobs: expect.any(Object),
        pr_number: expect.any(Object),
        checkout_sha: expect.any(Object),
        plan_hash: expect.any(Object),
        correlation_id: expect.any(Object),
      }),
    );
    expect(workflow["run-name"]).toContain(
      "format('E2E PR #{0} ({1})', inputs.pr_number, inputs.correlation_id)",
    );
  });

  it("validates the E2E run against the PR head commit", () => {
    const current = runChildValidation("a".repeat(40));
    const stale = runChildValidation("c".repeat(40));

    expect(current.status).toBe(0);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("checkout_sha must match the PR head commit");
  });

  it("logs each child state once and exits after success", () => {
    const result = runWaitStep("success");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
      expect.stringContaining("status=in_progress"),
      expect.stringContaining("status=completed conclusion=success"),
    ]);
  });

  it("surfaces a terminal child failure", () => {
    const result = runWaitStep("failure");

    expect(result.status).toBe(1);
    expect(result.stdout.match(/status=in_progress/gu)).toHaveLength(1);
    expect(result.stderr).toContain("::error title=E2E run failed::");
    expect(result.stderr).toContain("completed with conclusion failure");
  });

  it("preserves GitHub CLI errors when status queries fail", () => {
    const result = runWaitStep("query-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated GitHub query failure");
    expect(result.stderr).toContain("::error title=Run status query failed::");
  });

  it("labels only the bounded wait exit as a timeout", () => {
    const result = runWaitStep("timeout");

    expect(result.status).toBe(124);
    expect(result.stderr).toContain("::error title=E2E run timed out::");
    expect(result.stderr).toContain("did not complete within 105 minutes");
  });

  it("rejects an invalid child run ID before querying GitHub", () => {
    const result = runWaitStep("success", { runId: "invalid" });

    expect(result.status).toBe(1);
    expect(result.ghCallCount).toBe(0);
    expect(result.stderr).toContain("::error title=Invalid run ID::");
  });

  it("fails closed for an unsupported child state", () => {
    const result = runWaitStep("unsupported");

    expect(result.status).toBe(1);
    expect(result.ghCallCount).toBe(1);
    expect(result.stderr).toContain("::error title=Unexpected run state::");
  });
});
