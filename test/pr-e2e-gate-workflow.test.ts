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
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);

type CoordinatorJob = WorkflowJob & {
  concurrency?: { group: string; "cancel-in-progress": boolean };
};

type TriggeredWorkflow = Omit<Workflow, "jobs"> & {
  name: string;
  on: {
    workflow_run: { workflows: string[]; types: string[] };
    pull_request_target: { types: string[] };
    workflow_dispatch: { inputs: Record<string, unknown> };
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
        CI_DISPLAY_TITLE: `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
        CI_RUN_ATTEMPT: "3",
        CI_RUN_ID: "99",
        FAKE_NODE_ARGUMENTS: argumentsPath,
        GATE_RUN_ID: "101",
        GITHUB_TOKEN: "token",
        HEAD_BRANCH: headBranch,
        HEAD_REPOSITORY: "NVIDIA/NemoClaw",
        HEAD_SHA,
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

function runApprovedExceptionStep(exceptionMode: string) {
  const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
  const approve = step(workflow.jobs["approve-exception"], "Record approved E2E exception");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-approve-"));
  const binDir = path.join(tempDir, "bin");
  const argumentsPath = path.join(tempDir, "node-arguments");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "node"),
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\0\' "$@" > "$FAKE_NODE_ARGUMENTS"\n',
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", approve.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        APPROVAL_RUN_ATTEMPT: "1",
        APPROVAL_RUN_ID: "101",
        EXCEPTION_MODE: exceptionMode,
        EXPECTED_BASE_SHA: BASE_SHA,
        EXPECTED_HEAD_SHA: HEAD_SHA,
        FAKE_NODE_ARGUMENTS: argumentsPath,
        GITHUB_TOKEN: "token",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PR_NUMBER: "42",
        WORKFLOW_SHA,
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

function runCancelStep(prNumber: string) {
  const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
  const cancel = step(workflow.jobs["cancel-superseded"], "Cancel superseded E2E runs");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-cancel-step-"));
  const binDir = path.join(tempDir, "bin");
  const argumentsPath = path.join(tempDir, "node-arguments");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "node"),
    '#!/usr/bin/env bash\nset -euo pipefail\nprintf \'%s\\0\' "$@" > "$FAKE_NODE_ARGUMENTS"\n',
    { mode: 0o755 },
  );

  try {
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", cancel.run!], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_NODE_ARGUMENTS: argumentsPath,
        GITHUB_TOKEN: "token",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PR_NUMBER: prNumber,
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

function runChildValidation(
  currentPullSha: string,
  currentPullBase = BASE_SHA,
  currentWorkflowSha = WORKFLOW_SHA,
) {
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
  .base.sha) printf '%s\\n' "$FAKE_PR_BASE_SHA" ;;
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
        BASE_SHA,
        CHECKOUT_SHA: HEAD_SHA,
        CORRELATION_ID: "12345678-1234-4123-8123-123456789abc",
        EXPECTED_WORKFLOW_SHA: WORKFLOW_SHA,
        FAKE_CHECKOUT_SHA: HEAD_SHA,
        FAKE_PR_BASE_SHA: currentPullBase,
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
        WORKFLOW_SHA: currentWorkflowSha,
      },
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("PR E2E gate workflow", () => {
  // source-shape-contract: security -- Trusted metadata triggers and least privilege bound the write-capable controller
  it("limits triggers and job permissions", () => {
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const initialize = workflow.jobs.initialize;
    const cancel = workflow.jobs["cancel-superseded"];
    const coordinate = workflow.jobs.coordinate;
    const approveException = workflow.jobs["approve-exception"];
    const resolveException = workflow.jobs["resolve-exception"];

    expect(workflow.name).toBe("E2E / PR Gate Controller");
    expect(workflow.on).toEqual({
      workflow_run: {
        workflows: ["CI / Pull Request"],
        types: ["completed"],
      },
      pull_request_target: {
        types: ["opened", "synchronize", "reopened", "ready_for_review", "edited", "closed"],
      },
      workflow_dispatch: {
        inputs: {
          operation: {
            description: "Exact-diff exception type to record.",
            required: true,
            default: "resolve-fork",
            type: "choice",
            options: ["resolve-fork", "resolve-control-plane"],
          },
          pr_number: {
            description: "Pull request number to resolve.",
            required: true,
            type: "string",
          },
          expected_head_sha: {
            description: "Exact 40-character PR head SHA reviewed by the maintainer.",
            required: true,
            type: "string",
          },
          expected_base_sha: {
            description: "Exact 40-character PR base SHA reviewed by the maintainer.",
            required: true,
            type: "string",
          },
          waiver_reason: {
            description: "Why credentialed E2E cannot be run safely for this revision.",
            required: true,
            type: "string",
          },
          evidence_url: {
            description:
              "Optional Actions run URL, for example https://github.com/NVIDIA/NemoClaw/actions/runs/123. Leave blank if none.",
            required: false,
            default: "",
            type: "string",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({});
    expect(initialize.if).toContain("github.event_name == 'pull_request_target'");
    expect(initialize.if).toContain("github.event.action != 'closed'");
    expect(initialize.if).toContain("github.event.action != 'edited'");
    expect(initialize.if).toContain("github.event.changes.base != null");
    expect(initialize.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(initialize.concurrency?.group).toBe(
      "pr-e2e-gate-${{ github.event.pull_request.head.repo.full_name }}-${{ github.event.pull_request.head.ref }}",
    );
    expect(cancel.if).toContain("github.event_name == 'pull_request_target'");
    expect(cancel.if).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(cancel.if).toContain("github.event.action != 'edited'");
    expect(cancel.if).toContain("github.event.changes.base != null");
    expect(cancel.permissions).toEqual({ actions: "write", contents: "read" });
    expect(coordinate.if).toContain("github.event_name == 'workflow_run'");
    expect(coordinate.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(coordinate.if).toContain(
      "github.event.workflow_run.path == '.github/workflows/pr.yaml'",
    );
    expect(coordinate.if).toContain(
      "endsWith(github.event.workflow_run.display_title, ' gate true')",
    );
    expect(coordinate.if).not.toContain("head_repository.full_name == github.repository");
    expect(coordinate.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(coordinate.concurrency?.group).toBe(
      "pr-e2e-gate-${{ github.event.workflow_run.head_repository.full_name }}-${{ github.event.workflow_run.head_branch }}",
    );
    expect(coordinate.outputs).toEqual({
      exception_mode: "${{ steps.start.outputs.exception_mode }}",
      exception_pr_number: "${{ steps.start.outputs.exception_pr_number }}",
      exception_head_sha: "${{ steps.start.outputs.exception_head_sha }}",
      exception_base_sha: "${{ steps.start.outputs.exception_base_sha }}",
    });
    expect(approveException.name).toBe("Approve no-secret E2E exception");
    expect(approveException.needs).toBe("coordinate");
    expect(approveException.if).toBe(
      "${{ needs.coordinate.result == 'success' && needs.coordinate.outputs.exception_mode != '' && github.run_attempt == 1 }}",
    );
    expect(approveException.environment).toEqual({
      name: "e2e-no-secret-exception",
      deployment: false,
    });
    expect(approveException.permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(approveException.concurrency).toEqual({
      group: "pr-e2e-gate-approve-${{ needs.coordinate.outputs.exception_pr_number }}",
      "cancel-in-progress": true,
    });
    expect(approveException.secrets).toBeUndefined();
    expect(resolveException.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(resolveException.if).toContain("github.ref == 'refs/heads/main'");
    expect(resolveException.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(collectStrings(initialize).some((value) => value.includes("--mode seed"))).toBe(true);
    expect(
      collectStrings(resolveException).some((value) => value.includes('--mode "$OPERATION"')),
    ).toBe(true);
    expect(step(initialize, "Reserve exact-diff gate").run).toContain('--head "$HEAD_SHA"');
    expect(step(initialize, "Reserve exact-diff gate").env?.BASE_SHA).toBe(
      "${{ github.event.pull_request.base.sha }}",
    );
    expect(step(initialize, "Reserve exact-diff gate").run).toContain('--base "$BASE_SHA"');
    const start = step(coordinate, "Start evaluation");
    expect(start.env?.CI_DISPLAY_TITLE).toBe("${{ github.event.workflow_run.display_title }}");
    expect(start.env?.GATE_RUN_ID).toBe("${{ github.run_id }}");
    expect(start.run).toContain('--ci-display-title "$CI_DISPLAY_TITLE"');
    expect(start.run).toContain('--gate-run-id "$GATE_RUN_ID"');
    const finish = step(coordinate, "Verify evidence");
    expect(finish.run).toContain('--evidence-outcome "${{ steps.evidence.outcome }}"');
    const approval = step(approveException, "Record approved E2E exception");
    expect(approval.env).toEqual({
      APPROVAL_RUN_ATTEMPT: "${{ github.run_attempt }}",
      APPROVAL_RUN_ID: "${{ github.run_id }}",
      EXCEPTION_MODE: "${{ needs.coordinate.outputs.exception_mode }}",
      EXPECTED_BASE_SHA: "${{ needs.coordinate.outputs.exception_base_sha }}",
      EXPECTED_HEAD_SHA: "${{ needs.coordinate.outputs.exception_head_sha }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ needs.coordinate.outputs.exception_pr_number }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(approval.run).toContain("--mode resolve-approved");
    expect(approval.run).toContain('--exception-mode "$EXCEPTION_MODE"');
    expect(approval.run).toContain('--pr "$PR_NUMBER"');
    expect(approval.run).toContain('--head "$EXPECTED_HEAD_SHA"');
    expect(approval.run).toContain('--base "$EXPECTED_BASE_SHA"');
    expect(approval.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(approval.run).toContain('--approval-run-id "$APPROVAL_RUN_ID"');
    expect(approval.run).toContain('--approval-run-attempt "$APPROVAL_RUN_ATTEMPT"');
    const resolution = step(resolveException, "Record E2E exception");
    expect(resolution.env?.OPERATION).toBe("${{ inputs.operation }}");
    expect(resolution.env?.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expect(resolution.env?.MAINTAINER).toBe("${{ github.triggering_actor }}");
    expect(resolution.env?.MAINTAINER).not.toBe("${{ github.actor }}");
    expect(resolution.env?.EXPECTED_BASE_SHA).toBe("${{ inputs.expected_base_sha }}");
    expect(resolution.run).toContain('--head "$EXPECTED_HEAD_SHA"');
    expect(resolution.run).toContain('--base "$EXPECTED_BASE_SHA"');
    expect(resolution.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(resolution.run).toContain('--reason "$WAIVER_REASON"');
    expect(resolution.run).toContain('--evidence-url "$EVIDENCE_URL"');
    expect(collectStrings(workflow).some((value) => value.includes("${{ secrets."))).toBe(false);
  });

  // source-shape-contract: security -- Controller checkouts and dependency installs must not execute mutable contributor hooks
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

    expect(checkouts).toHaveLength(5);
    expect(
      checkouts.every(
        (checkout) =>
          checkout.with?.ref === "${{ github.workflow_sha }}" &&
          checkout.with?.["persist-credentials"] === false,
      ),
    ).toBe(true);
    expect(nodeSetups).toHaveLength(5);
    expect(nodeSetups.every((setup) => setup.with?.["node-version"] === "22")).toBe(true);
    expect(nodeSetups.every((setup) => !("cache" in (setup.with ?? {})))).toBe(true);
    expect(installs).toHaveLength(5);
    expect(
      installs.every((install) => install.run === "npm ci --ignore-scripts --no-audit --no-fund"),
    ).toBe(true);
    expect(
      allSteps.some((candidate) => candidate.uses?.startsWith("actions/download-artifact@")),
    ).toBe(false);
  });

  it("cancels superseded PR runs", () => {
    const execution = runCancelStep("42");

    expect(execution.result.status).toBe(0);
    expect(execution.result.stderr).toBe("");
    expect(execution.arguments).toEqual([
      "--experimental-strip-types",
      "tools/e2e/pr-e2e-gate.mts",
      "--mode",
      "cancel",
      "--pr",
      "42",
    ]);
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

  it("passes the approved exception identity as inert exact arguments", () => {
    const exceptionMode = "resolve-fork;printf injected";
    const execution = runApprovedExceptionStep(exceptionMode);

    expect(execution.result.status).toBe(0);
    expect(execution.result.stderr).toBe("");
    expect(execution.arguments).toEqual([
      "--experimental-strip-types",
      "tools/e2e/pr-e2e-gate.mts",
      "--mode",
      "resolve-approved",
      "--exception-mode",
      exceptionMode,
      "--pr",
      "42",
      "--head",
      HEAD_SHA,
      "--base",
      BASE_SHA,
      "--workflow-sha",
      WORKFLOW_SHA,
      "--approval-run-id",
      "101",
      "--approval-run-attempt",
      "1",
    ]);
  });

  it("validates the E2E run against the PR head, base, and trusted workflow commits", () => {
    const current = runChildValidation(HEAD_SHA);
    const stale = runChildValidation("c".repeat(40));
    const retargeted = runChildValidation(HEAD_SHA, "d".repeat(40));
    const racedWorkflow = runChildValidation(HEAD_SHA, BASE_SHA, "e".repeat(40));

    expect(current.status).toBe(0);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("checkout_sha must match the PR head commit");
    expect(retargeted.status).toBe(1);
    expect(retargeted.stdout).toContain("base_sha must match the PR base commit");
    expect(racedWorkflow.status).toBe(1);
    expect(racedWorkflow.stdout).toContain("workflow_sha must match the trusted workflow commit");
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

  it("leaves terminal child failures for finalization to report", () => {
    const result = runWaitStep("failure");

    expect(result.status).toBe(0);
    expect(result.stdout.match(/status=in_progress/gu)).toHaveLength(1);
    expect(result.stdout).toContain("status=completed conclusion=failure");
    expect(result.stderr).toBe("");
  });

  it("preserves GitHub CLI errors when status queries fail", () => {
    const result = runWaitStep("query-failure");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("simulated GitHub query failure");
    expect(result.stderr).toContain("::error title=Run status query failed::");
  });

  it("leaves bounded wait timeouts for finalization to cancel and report", () => {
    const result = runWaitStep("timeout");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("did not complete within 105 minutes");
    expect(result.stderr).toBe("");
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
