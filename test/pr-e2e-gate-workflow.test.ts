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
const TRUSTED_SETUP_NODE_ACTION = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const PR_GATE_RUN_NAME = [
  "${{ github.event_name == 'pull_request_target' &&",
  "format('E2E Gate PR #{0} head {1} base {2} gate {3}',",
  "github.event.pull_request.number, github.event.pull_request.head.sha,",
  "github.event.pull_request.base.sha, github.event.action != 'closed') ||",
  "github.event_name == 'workflow_run' &&",
  "format('E2E Gate coordinate from {0}', github.event.workflow_run.display_title) ||",
  "format('E2E Gate approve PR #{0} head {1} base {2}',",
  "inputs.pr_number, inputs.expected_head_sha, inputs.expected_base_sha) }}",
].join(" ");

type CoordinatorJob = WorkflowJob & {
  concurrency?: { group: string; queue?: "max"; "cancel-in-progress": boolean };
};

type TriggeredWorkflow = Omit<Workflow, "jobs"> & {
  name: string;
  "run-name": string;
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
        EVENT_NAME: "workflow_run",
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

function runApprovalStartStep(reviewReason: string) {
  const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
  const start = step(workflow.jobs.coordinate, "Start evaluation");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-authorize-"));
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
        EVENT_NAME: "workflow_dispatch",
        FAKE_NODE_ARGUMENTS: argumentsPath,
        GATE_RUN_ID: "101",
        GITHUB_TOKEN: "token",
        MAINTAINER: "maintainer",
        MANUAL_BASE_SHA: BASE_SHA,
        MANUAL_HEAD_SHA: HEAD_SHA,
        MANUAL_PR_NUMBER: "42",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        REVIEW_REASON: reviewReason,
        WORKFLOW_RUN_ATTEMPT: "1",
        WORKFLOW_SHA,
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
        HEAD_SHA,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PR_NUMBER: prNumber,
        SUPERSEDED_HEAD_SHA: "c".repeat(40),
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
  selectors: { jobs?: string; targets?: string } = {},
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
        CHECKOUT_REPOSITORY: "NVIDIA/NemoClaw",
        CHECKOUT_SHA: HEAD_SHA,
        CORRELATION_ID: "12345678-1234-4123-8123-123456789abc",
        EXPECTED_WORKFLOW_SHA: WORKFLOW_SHA,
        FAKE_CHECKOUT_SHA: HEAD_SHA,
        FAKE_PR_BASE_SHA: currentPullBase,
        FAKE_PR_SHA: currentPullSha,
        GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
        GITHUB_TOKEN: "token",
        JOBS: selectors.jobs ?? "onboard-repair",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        PLAN_HASH: "b".repeat(64),
        PR_NUMBER: "42",
        TARGETS: selectors.targets ?? "",
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
    const ciWorkflow = readYaml<Workflow>(".github/workflows/pr.yaml");
    const ciRequired =
      "${{ github.event.action != 'edited' || github.event.changes.base != null }}";
    const ciVerification = step(ciWorkflow.jobs.checks, "Verify required PR checks");
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const initialize = workflow.jobs.initialize;
    const cancel = workflow.jobs["cancel-superseded"];
    const coordinate = workflow.jobs.coordinate;
    const longestSelectedE2eMinutes = 130;
    const controllerWaitMinutes = 140;
    const evidenceAndKillGraceMinutes = 10.5;
    const twoAttemptMinimum = 2 * (controllerWaitMinutes + evidenceAndKillGraceMinutes);
    const controllerSetupReserveMinutes = 25;

    expect(workflow.name).toBe("E2E / PR Gate Controller");
    expect(workflow["run-name"]).toBe(PR_GATE_RUN_NAME);
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
            description: "E2E gate action to perform.",
            required: true,
            default: "approve-e2e",
            type: "choice",
            options: ["approve-e2e"],
          },
          pr_number: {
            description: "Pull request number for the selected E2E gate action.",
            required: true,
            type: "string",
          },
          expected_head_sha: {
            description: "Current 40-character PR head SHA reviewed by the maintainer.",
            required: true,
            type: "string",
          },
          expected_base_sha: {
            description: "Current 40-character PR base SHA reviewed by the maintainer.",
            required: true,
            type: "string",
          },
          review_reason: {
            description: "Why this PR may run credentialed E2E.",
            required: true,
            type: "string",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({});
    expect(ciWorkflow.jobs.changes.if).toBe(ciRequired);
    expect(ciWorkflow.jobs.checks.if).toBe("always()");
    expect(ciVerification.env?.CI_REQUIRED).toBe(ciRequired);
    expect(ciVerification.run).toContain('if [ "$CI_REQUIRED" != "true" ]; then');
    expect(ciVerification.run).toContain("Metadata-only PR edit");
    const metadataOnlyGate = spawnSync("bash", ["-c", ciVerification.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...ciVerification.env,
        CHANGES_RESULT: "skipped",
        CI_REQUIRED: "false",
        STATIC_RESULT: "failure",
      },
    });
    expect(metadataOnlyGate.status, metadataOnlyGate.stderr).toBe(0);
    expect(metadataOnlyGate.stdout).toContain("Metadata-only PR edit");
    expect(initialize.if).toContain("github.event_name == 'pull_request_target'");
    expect(initialize.if).toContain("github.run_attempt == 1");
    expect(initialize.if).toContain("github.event.action != 'closed'");
    expect(initialize.if).toContain("github.event.action != 'edited'");
    expect(initialize.if).toContain("github.event.changes.base != null");
    expect(initialize.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(initialize.concurrency?.group).toBe(
      "pr-e2e-gate-${{ github.repository }}-${{ github.event.pull_request.number }}-${{ github.event.pull_request.head.sha }}-${{ github.event.pull_request.base.sha }}",
    );
    expect(initialize.concurrency?.queue).toBe("max");
    expect(initialize.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(workflow.jobs.required).toBeUndefined();
    expect(cancel.if).toContain("github.event_name == 'pull_request_target'");
    expect(cancel.if).toContain("github.run_attempt == 1");
    expect(cancel.if).not.toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(cancel.if).toContain("github.event.action != 'edited'");
    expect(cancel.if).toContain("github.event.changes.base != null");
    expect(cancel.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(coordinate.if).toContain("github.event_name == 'workflow_run'");
    expect(coordinate.if).toContain("github.event.workflow_run.event == 'pull_request'");
    expect(coordinate.if).toContain(
      "github.event.workflow_run.path == '.github/workflows/pr.yaml'",
    );
    expect(coordinate.if).toContain(
      "endsWith(github.event.workflow_run.display_title, ' gate true')",
    );
    expect(coordinate.if).toContain("inputs.operation == 'approve-e2e'");
    expect(coordinate.if).toContain("github.ref == 'refs/heads/main'");
    expect(coordinate.if).toContain("github.run_attempt == 1");
    expect(coordinate.if).not.toContain("head_repository.full_name == github.repository");
    expect(coordinate.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
      statuses: "write",
    });
    expect(coordinate.concurrency?.group).toBe(
      "pr-e2e-gate-${{ github.repository }}-${{ github.event_name == 'workflow_run' && github.event.workflow_run.pull_requests[0].number || inputs.pr_number }}-${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.expected_head_sha }}-${{ github.event_name == 'workflow_run' && github.event.workflow_run.pull_requests[0].base.sha || inputs.expected_base_sha }}",
    );
    expect(coordinate.concurrency?.queue).toBe("max");
    expect(coordinate.concurrency?.["cancel-in-progress"]).toBe(false);
    expect(coordinate["timeout-minutes"]).toBe(330);
    expect(coordinate.outputs).toBeUndefined();
    expect(workflow.jobs["approve-e2e"]).toBeUndefined();
    expect(controllerWaitMinutes).toBeGreaterThan(longestSelectedE2eMinutes);
    expect(coordinate["timeout-minutes"]).toBeGreaterThanOrEqual(
      twoAttemptMinimum + controllerSetupReserveMinutes,
    );
    expect(collectStrings(initialize).some((value) => value.includes("--mode seed"))).toBe(true);
    expect(step(initialize, "Reserve PR/base SHA gate").run).toContain('--head "$HEAD_SHA"');
    expect(step(initialize, "Reserve PR/base SHA gate").env?.BASE_SHA).toBe(
      "${{ github.event.pull_request.base.sha }}",
    );
    expect(step(initialize, "Reserve PR/base SHA gate").run).toContain('--base "$BASE_SHA"');
    const start = step(coordinate, "Start evaluation");
    expect(start.env?.CI_DISPLAY_TITLE).toBe("${{ github.event.workflow_run.display_title }}");
    expect(start.env?.GATE_RUN_ID).toBe("${{ github.run_id }}");
    expect(start.env?.MAINTAINER).toBe("${{ github.triggering_actor }}");
    expect(start.env?.MANUAL_HEAD_SHA).toBe("${{ inputs.expected_head_sha }}");
    expect(start.env?.MANUAL_BASE_SHA).toBe("${{ inputs.expected_base_sha }}");
    expect(start.run).toContain("--mode approve-e2e");
    expect(start.run).toContain('--ci-display-title "$CI_DISPLAY_TITLE"');
    expect(start.run).toContain('--gate-run-id "$GATE_RUN_ID"');
    const wait = step(coordinate, "Wait for E2E run");
    expect(wait.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(wait.run).toContain("--mode wait");
    expect(wait.run).toContain('--run-id "${{ steps.start.outputs.run_id }}"');
    const evidence = step(coordinate, "Download evidence");
    expect(evidence.env?.GH_TOKEN).toBe("${{ github.token }}");
    expect(evidence.env?.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(evidence.run).toContain("--mode download");
    expect(evidence.run).toContain('--work-dir "${{ steps.workspace.outputs.work_dir }}"');
    expect(evidence.run).toContain('--run-id "${{ steps.start.outputs.run_id }}"');
    const finish = step(coordinate, "Verify evidence");
    expect(finish.run).toContain('--evidence-outcome "${{ steps.evidence.outcome }}"');
    const retry = step(coordinate, "Retry after hosted runner loss");
    expect(retry.if).toContain("steps.finish.outputs.runner_loss_retry_authorized == 'true'");
    expect(retry.if).toContain("github.run_attempt == 1");
    expect(retry.run).toContain("--mode retry-runner-loss");
    expect(retry.run).toContain('--workflow-run-attempt "${{ github.run_attempt }}"');
    const retryEvidence = step(coordinate, "Download retry evidence");
    expect(retryEvidence.if).toContain("always()");
    expect(retryEvidence.run).toContain("--slot runner-loss-retry");
    const retryFinish = step(coordinate, "Verify retry evidence");
    expect(retryFinish.if).toContain("always()");
    expect(retryFinish.run).toContain('--state-hash "${{ steps.retry.outputs.state_hash }}"');
    expect(retryFinish.run).toContain('--evidence-outcome "${{ steps.retry_evidence.outcome }}"');
    const interruptedRetry = step(coordinate, "Terminalize interrupted retry setup");
    expect(interruptedRetry.if).toContain("steps.retry.outcome != 'success'");
    expect(interruptedRetry.if).not.toContain("steps.retry.outcome == 'failure'");
    expect(interruptedRetry.if).toContain("steps.retry.outputs.check_id == ''");
    expect(interruptedRetry.run).toContain("--mode abandon-runner-loss-retry");
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

    expect(checkouts).toHaveLength(3);
    expect(
      checkouts.every(
        (checkout) =>
          checkout.with?.ref === "${{ github.workflow_sha }}" &&
          checkout.with?.["persist-credentials"] === false,
      ),
    ).toBe(true);
    expect(nodeSetups).toHaveLength(3);
    expect(nodeSetups.every((setup) => setup.uses === TRUSTED_SETUP_NODE_ACTION)).toBe(true);
    expect(nodeSetups.every((setup) => setup.with?.["node-version"] === "22")).toBe(true);
    expect(nodeSetups.every((setup) => !("cache" in (setup.with ?? {})))).toBe(true);
    expect(installs).toHaveLength(3);
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
      "--head",
      HEAD_SHA,
      "--superseded-head",
      "c".repeat(40),
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

  it("passes the maintainer review reason as one inert argument", () => {
    const reason = "Reviewed PR/base SHA pair; $(printf injected)";
    const execution = runApprovalStartStep(reason);
    const reasonFlag = execution.arguments.indexOf("--reason");

    expect(execution.result.status).toBe(0);
    expect(execution.result.stderr).toBe("");
    expect(execution.arguments).toContain("approve-e2e");
    expect(execution.arguments[reasonFlag + 1]).toBe(reason);
    expect(execution.arguments).toContain(HEAD_SHA);
    expect(execution.arguments).toContain(BASE_SHA);
  });

  it("validates the E2E run against the PR head, base, and trusted workflow commits", () => {
    const current = runChildValidation(HEAD_SHA);
    const stale = runChildValidation("c".repeat(40));
    const retargeted = runChildValidation(HEAD_SHA, "d".repeat(40));
    const racedWorkflow = runChildValidation(HEAD_SHA, BASE_SHA, "e".repeat(40));
    const combined = runChildValidation(HEAD_SHA, BASE_SHA, WORKFLOW_SHA, {
      jobs: "cloud-inference,cloud-onboard,security-posture",
      targets: "ubuntu-repo-cloud-langchain-deepagents-code",
    });
    const unapprovedTarget = runChildValidation(HEAD_SHA, BASE_SHA, WORKFLOW_SHA, {
      jobs: "onboard-repair",
      targets: "ubuntu-repo-cloud-openclaw",
    });
    const empty = runChildValidation(HEAD_SHA, BASE_SHA, WORKFLOW_SHA, {
      jobs: "",
      targets: "",
    });

    expect(current.status).toBe(0);
    expect(combined.status).toBe(0);
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("checkout_sha must match the PR SHA");
    expect(retargeted.status).toBe(1);
    expect(retargeted.stdout).toContain("base_sha must match the PR base commit");
    expect(racedWorkflow.status).toBe(1);
    expect(racedWorkflow.stdout).toContain("workflow_sha must match the trusted workflow commit");
    expect(unapprovedTarget.status).toBe(1);
    expect(unapprovedTarget.stdout).toContain(
      "PR E2E target is not approved by the trusted controller",
    );
    expect(empty.status).toBe(1);
    expect(empty.stdout).toContain("PR E2E runs require controller-selected jobs or targets");
  });

  // source-shape-contract: security -- Always-run finalization and private-workspace cleanup must survive every coordinate failure path
  it("orders the coordinate steps and always finalizes through the controller", () => {
    const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
    const coordinate = workflow.jobs.coordinate;

    expect((coordinate.steps ?? []).map((candidate) => candidate.name)).toEqual([
      "Checkout controller",
      "Setup Node",
      "Install controller dependencies",
      "Create private workspace",
      "Start evaluation",
      "Upload risk plan",
      "Wait for E2E run",
      "Download evidence",
      "Verify evidence",
      "Retry after hosted runner loss",
      "Wait for retry E2E run",
      "Download retry evidence",
      "Verify retry evidence",
      "Close incomplete retry check",
      "Terminalize interrupted retry setup",
      "Close incomplete check",
      "Remove private workspace",
    ]);

    const evidence = step(coordinate, "Download evidence");
    expect(evidence.if).toContain("always()");
    const finish = step(coordinate, "Verify evidence");
    expect(finish.if).toContain("always()");
    const abandon = step(coordinate, "Close incomplete check");
    expect(abandon.if).toContain("always()");
    const cleanup = step(coordinate, "Remove private workspace");
    expect(cleanup.if).toContain("always()");
    expect(cleanup.if).toContain("steps.workspace.outputs.work_dir");
    expect(cleanup.run).toBe('rm -rf -- "${{ steps.workspace.outputs.work_dir }}"');
  });
});
