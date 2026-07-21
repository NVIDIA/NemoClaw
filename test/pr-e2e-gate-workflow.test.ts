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

function runControlPlaneStartStep(reviewReason: string) {
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

function runApprovedForkSkipStep() {
  const workflow = readYaml<TriggeredWorkflow>(PR_GATE_PATH);
  const approve = step(
    workflow.jobs["approve-fork-e2e-skip"],
    "Record approved credentialed E2E skip",
  );
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
    const required = workflow.jobs.required;
    const cancel = workflow.jobs["cancel-superseded"];
    const coordinate = workflow.jobs.coordinate;
    const approveForkSkip = workflow.jobs["approve-fork-e2e-skip"];
    const recordForkSkip = workflow.jobs["record-fork-e2e-skip"];

    expect(workflow.name).toBe("E2E / PR Gate Controller");
    expect(workflow["run-name"]).toContain("E2E Gate PR #{0} head {1} base {2} gate {3}");
    expect(workflow["run-name"]).toContain("github.event.pull_request.number");
    expect(workflow["run-name"]).toContain("github.event.pull_request.head.sha");
    expect(workflow["run-name"]).toContain("github.event.pull_request.base.sha");
    expect(workflow["run-name"]).toContain("github.event.changes.base != null");
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
            default: "approve-fork-e2e-skip",
            type: "choice",
            options: ["approve-fork-e2e-skip", "run-control-plane"],
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
            description:
              "Why this fork PR may skip credentialed E2E or this internal PR may run control-plane E2E.",
            required: true,
            type: "string",
          },
          evidence_url: {
            description:
              "Fork credentialed-E2E skip only; optional Actions run URL. Ignored by run-control-plane, whose evidence comes from the dispatched jobs.",
            required: false,
            default: "",
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
    expect(required.name).toBe("E2E / PR Gate");
    expect(required.if).toContain("github.event_name == 'pull_request_target'");
    expect(required.if).toContain("github.event.action != 'closed'");
    expect(required.if).toContain("github.event.action != 'edited'");
    expect(required.if).toContain("github.event.changes.base != null");
    expect(required.permissions).toEqual({
      checks: "read",
      contents: "read",
      "pull-requests": "read",
    });
    expect(required.concurrency).toEqual({
      group: "pr-e2e-required-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    expect(required["timeout-minutes"]).toBe(170);
    expect(required.secrets).toBeUndefined();
    expect(step(required, "Checkout observer").with).toEqual({
      ref: "${{ github.workflow_sha }}",
      "persist-credentials": false,
    });
    const observer = step(required, "Wait for trusted PR/base SHA verdict");
    expect(observer.env).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      GITHUB_TOKEN: "${{ github.token }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
    });
    expect(observer.run).toContain("tools/e2e/pr-e2e-required.mts");
    expect(observer.run).toContain('--head "$HEAD_SHA"');
    expect(observer.run).toContain('--base "$BASE_SHA"');
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
    expect(coordinate.if).toContain("inputs.operation == 'run-control-plane'");
    expect(coordinate.if).toContain("github.ref == 'refs/heads/main'");
    expect(coordinate.if).toContain("github.run_attempt == 1");
    expect(coordinate.if).not.toContain("head_repository.full_name == github.repository");
    expect(coordinate.permissions).toEqual({
      actions: "write",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(coordinate.concurrency?.group).toBe(
      "pr-e2e-gate-${{ github.repository }}-${{ github.event_name == 'workflow_run' && github.event.workflow_run.head_sha || inputs.expected_head_sha }}",
    );
    expect(coordinate.outputs).toEqual({
      fork_skip_mode: "${{ steps.start.outputs.fork_skip_mode }}",
      fork_skip_pr_number: "${{ steps.start.outputs.fork_skip_pr_number }}",
      fork_skip_head_sha: "${{ steps.start.outputs.fork_skip_head_sha }}",
      fork_skip_base_sha: "${{ steps.start.outputs.fork_skip_base_sha }}",
    });
    expect(approveForkSkip.name).toBe("Approve credentialed E2E skip for fork PR");
    expect(approveForkSkip.needs).toBe("coordinate");
    expect(approveForkSkip.if).toBe(
      "${{ needs.coordinate.result == 'success' && needs.coordinate.outputs.fork_skip_mode != '' && github.run_attempt == 1 }}",
    );
    expect(approveForkSkip.environment).toEqual({
      name: "approve-credentialed-e2e-skip-for-fork-pr",
      deployment: false,
    });
    expect(approveForkSkip.permissions).toEqual({
      actions: "read",
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(approveForkSkip.concurrency).toEqual({
      group: "pr-e2e-gate-approve-fork-skip-${{ needs.coordinate.outputs.fork_skip_pr_number }}",
      "cancel-in-progress": true,
    });
    expect(approveForkSkip.secrets).toBeUndefined();
    expect(recordForkSkip.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(recordForkSkip.if).toContain("github.ref == 'refs/heads/main'");
    expect(recordForkSkip.name).toBe("Record credentialed E2E skip for fork PR");
    expect(recordForkSkip.if).toContain("inputs.operation == 'approve-fork-e2e-skip'");
    expect(recordForkSkip.permissions).toEqual({
      checks: "write",
      contents: "read",
      "pull-requests": "read",
    });
    expect(collectStrings(initialize).some((value) => value.includes("--mode seed"))).toBe(true);
    expect(
      collectStrings(recordForkSkip).some((value) => value.includes("--mode record-fork-e2e-skip")),
    ).toBe(true);
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
    expect(start.run).toContain("--mode start-control-plane");
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
    const approval = step(approveForkSkip, "Record approved credentialed E2E skip");
    expect(approval.env).toEqual({
      APPROVAL_RUN_ATTEMPT: "${{ github.run_attempt }}",
      APPROVAL_RUN_ID: "${{ github.run_id }}",
      EXPECTED_BASE_SHA: "${{ needs.coordinate.outputs.fork_skip_base_sha }}",
      EXPECTED_HEAD_SHA: "${{ needs.coordinate.outputs.fork_skip_head_sha }}",
      GITHUB_TOKEN: "${{ github.token }}",
      PR_NUMBER: "${{ needs.coordinate.outputs.fork_skip_pr_number }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(approval.run).toContain("--mode record-approved-fork-e2e-skip");
    expect(approval.run).not.toContain("--fork-skip-mode");
    expect(approval.run).toContain('--pr "$PR_NUMBER"');
    expect(approval.run).toContain('--head "$EXPECTED_HEAD_SHA"');
    expect(approval.run).toContain('--base "$EXPECTED_BASE_SHA"');
    expect(approval.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(approval.run).toContain('--approval-run-id "$APPROVAL_RUN_ID"');
    expect(approval.run).toContain('--approval-run-attempt "$APPROVAL_RUN_ATTEMPT"');
    const resolution = step(recordForkSkip, "Record credentialed E2E skip");
    expect(resolution.env?.WORKFLOW_SHA).toBe("${{ github.workflow_sha }}");
    expect(resolution.env?.MAINTAINER).toBe("${{ github.triggering_actor }}");
    expect(resolution.env?.MAINTAINER).not.toBe("${{ github.actor }}");
    expect(resolution.env?.EXPECTED_BASE_SHA).toBe("${{ inputs.expected_base_sha }}");
    expect(resolution.env?.REVIEW_REASON).toBe("${{ inputs.review_reason }}");
    expect(resolution.run).toContain("--mode record-fork-e2e-skip");
    expect(resolution.run).toContain('--head "$EXPECTED_HEAD_SHA"');
    expect(resolution.run).toContain('--base "$EXPECTED_BASE_SHA"');
    expect(resolution.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(resolution.run).toContain('--reason "$REVIEW_REASON"');
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

    expect(checkouts).toHaveLength(6);
    expect(
      checkouts.every(
        (checkout) =>
          checkout.with?.ref === "${{ github.workflow_sha }}" &&
          checkout.with?.["persist-credentials"] === false,
      ),
    ).toBe(true);
    expect(nodeSetups).toHaveLength(6);
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

  it("passes the approved fork skip identity as inert arguments", () => {
    const execution = runApprovedForkSkipStep();

    expect(execution.result.status).toBe(0);
    expect(execution.result.stderr).toBe("");
    expect(execution.arguments).toEqual([
      "--experimental-strip-types",
      "tools/e2e/pr-e2e-gate.mts",
      "--mode",
      "record-approved-fork-e2e-skip",
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

  it("passes the control-plane review reason as one inert argument", () => {
    const reason = "Reviewed PR/base SHA pair; $(printf injected)";
    const execution = runControlPlaneStartStep(reason);
    const reasonFlag = execution.arguments.indexOf("--reason");

    expect(execution.result.status).toBe(0);
    expect(execution.result.stderr).toBe("");
    expect(execution.arguments).toContain("start-control-plane");
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
      jobs: "cloud-onboard,credential-sanitization,security-posture",
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
