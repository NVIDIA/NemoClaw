// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  readE2eOperationsWorkflow,
  validateE2eOperationsWorkflow,
  validateE2eOperationsWorkflowBoundary,
} from "../../../tools/e2e/operations-workflow-boundary.mts";

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;

function workflowScript(jobName: string, stepName: string): string {
  const workflow = readE2eOperationsWorkflow();
  const step = workflow.jobs[jobName]?.steps?.find((candidate) => candidate.name === stepName);
  expect(step?.with?.script).toEqual(expect.any(String));
  return step?.with?.script as string;
}

describe("E2E operations workflow boundary", () => {
  it("accepts the checked-in workflow and rejects aggregation, permission, and secret-scope drift", () => {
    expect(validateE2eOperationsWorkflowBoundary()).toEqual([]);

    const workflow = readE2eOperationsWorkflow();
    workflow.jobs.scorecard.needs = [...(workflow.jobs.scorecard.needs as string[])];
    (workflow.jobs.scorecard.needs as string[]).pop();
    workflow.jobs.scorecard.permissions = {
      actions: "read",
      contents: "read",
      issues: "write",
    };
    workflow.jobs.scorecard.env = {
      SLACK_WEBHOOK_URL_DAILY: "${{ secrets.SLACK_WEBHOOK_URL_DAILY }}",
    };

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "scorecard needs must exactly match report-to-pr needs",
        "scorecard permissions must be actions: read and contents: read",
        "scorecard must not expose credentials at job scope",
      ]),
    );
  });

  it("keeps PR reporting and scorecards disabled for PR E2E runs", () => {
    const workflow = readE2eOperationsWorkflow();
    workflow.jobs["report-to-pr"].if =
      "${{ always() && github.event_name == 'workflow_dispatch' }}";
    workflow.jobs.scorecard.if =
      "${{ always() && (github.event_name == 'workflow_dispatch' && inputs.checkout_sha == '') }}";

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "report-to-pr must run only for manual workflow dispatches",
        "scorecard must run after push and direct-main manual E2E executions",
      ]),
    );
  });

  it("rejects missing NEEDS_JSON environment data (#6952)", () => {
    const workflow = readE2eOperationsWorkflow();
    const report = workflow.jobs["report-to-pr"].steps!.find(
      (step) => step.name === "Post E2E target results to PR",
    )!;
    delete report.env?.NEEDS_JSON;

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "report-to-pr must pass needs as environment data without script interpolation",
    );
  });

  it("rejects malformed NEEDS_JSON environment data (#6952)", () => {
    const workflow = readE2eOperationsWorkflow();
    const scorecard = workflow.jobs.scorecard.steps!.find(
      (step) => step.name === "Generate E2E scorecard",
    )!;
    scorecard.env!.NEEDS_JSON = "${{ toJSON(needs.generate-matrix) }}";

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "scorecard generator must pass needs as environment data without script interpolation",
    );
  });

  it("rejects needs interpolation in GitHub Script source (#6952)", () => {
    const workflow = readE2eOperationsWorkflow();
    const report = workflow.jobs["report-to-pr"].steps!.find(
      (step) => step.name === "Post E2E target results to PR",
    )!;
    report.with!.script = `${String(report.with!.script)}
const interpolatedNeeds = \${{   toJSON ( needs )   }};
`;

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "report-to-pr must pass needs as environment data without script interpolation",
    );
  });

  it("rejects a commented NEEDS_JSON assignment (#6952)", () => {
    const workflow = readE2eOperationsWorkflow();
    const report = workflow.jobs["report-to-pr"].steps!.find(
      (step) => step.name === "Post E2E target results to PR",
    )!;
    report.with!.script = String(report.with!.script).replace(
      "const needs = JSON.parse(process.env.NEEDS_JSON || '{}');",
      "// const needs = JSON.parse(process.env.NEEDS_JSON || '{}');\nconst needs = {};",
    );

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "report-to-pr must pass needs as environment data without script interpolation",
    );
  });

  it("rejects NEEDS_JSON parsing assigned to an unrelated variable (#6952)", () => {
    const workflow = readE2eOperationsWorkflow();
    const scorecard = workflow.jobs.scorecard.steps!.find(
      (step) => step.name === "Generate E2E scorecard",
    )!;
    scorecard.with!.script = String(scorecard.with!.script).replace(
      "const needs = JSON.parse(process.env.NEEDS_JSON || '{}');",
      "const scorecardNeeds = JSON.parse(process.env.NEEDS_JSON || '{}');",
    );

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "scorecard generator must pass needs as environment data without script interpolation",
    );
  });

  it("rejects a lookalike NEEDS_JSON variable (#6952)", () => {
    const workflow = readE2eOperationsWorkflow();
    const report = workflow.jobs["report-to-pr"].steps!.find(
      (step) => step.name === "Post E2E target results to PR",
    )!;
    report.with!.script = String(report.with!.script).replace(
      "process.env.NEEDS_JSON",
      "process.env.NEEDS_JSON_BAD",
    );

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "report-to-pr must pass needs as environment data without script interpolation",
    );
  });

  it("pins the scorecard's current-run progress artifact action", () => {
    const workflow = readE2eOperationsWorkflow();
    const download = workflow.jobs.scorecard.steps!.find(
      (step) => step.name === "Download E2E progress artifacts",
    )!;
    download.uses = "actions/download-artifact@0000000000000000000000000000000000000000";

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "scorecard must download this run's E2E artifacts into the runtime audit directory",
    );
  });

  it("limits the scorecard artifact download to E2E progress sources", () => {
    const workflow = readE2eOperationsWorkflow();
    const download = workflow.jobs.scorecard.steps!.find(
      (step) => step.name === "Download E2E progress artifacts",
    )!;
    download.with!.pattern = "*";

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "scorecard must download this run's E2E artifacts into the runtime audit directory",
    );
  });

  it("rejects manual PR authorization and checkout validation drift", () => {
    const workflow = readE2eOperationsWorkflow();
    delete workflow.on?.workflow_dispatch?.inputs?.review_reason;
    const authentication = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Authenticate manual PR dispatch",
    )!;
    authentication.run = "echo unchecked";
    const validation = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Validate manual PR checkout",
    )!;
    validation.run = "echo unchecked";

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "workflow_dispatch review_reason must be an optional string with an empty default",
        'Manual PR authentication must retain "$WORKFLOW_EVENT" == "workflow_dispatch"',
        'Manual PR authentication must retain "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$',
        'Manual PR checkout validation must retain "$(git rev-parse --verify HEAD)" == "$CHECKOUT_SHA"',
      ]),
    );
  });

  it("limits manual PR runs to the default suite or protected managed-runtime qualification", () => {
    const workflow = readE2eOperationsWorkflow();
    const authentication = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Authenticate manual PR dispatch",
    )!;
    authentication.run = authentication.run!.replace(
      "Manual PR E2E accepts only the default suite or managed-image-protected-runtime",
      "Manual PR E2E accepts arbitrary selectors",
    );

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "Manual PR authentication must retain Manual PR E2E accepts only the default suite or managed-image-protected-runtime",
    );
  });

  it.each([
    ["maintain", "", 0, ""],
    ["maintain", "managed-image-protected-runtime", 0, ""],
    ["maintain", "gpu-e2e", 1, "accepts only the default suite or managed-image-protected-runtime"],
    ["write", "", 1, "requires a repository maintainer or administrator"],
  ])("requires a maintainer role and bounded selector before manual PR E2E for %s with %s", (role, jobs, expectedStatus, expectedStderr) => {
    const workflow = readE2eOperationsWorkflow();
    const authentication = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Authenticate manual PR dispatch",
    )!;
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const workflowSha = "c".repeat(40);
    const prefix = [
      "curl() {",
      '  case "${@: -1}" in',
      `    *collaborators*) printf '%s' '{"role_name":"${role}"}' ;;`,
      `    *pulls/42) printf '%s' '{"state":"open","head":{"repo":{"full_name":"contributor/NemoClaw"},"sha":"${headSha}"},"base":{"sha":"${baseSha}"}}' ;;`,
      "    *) return 1 ;;",
      "  esac",
      "}",
    ].join("\n");
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", `${prefix}\n${authentication.run}`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ACTOR: "maintainer",
          BASE_SHA: baseSha,
          CHECKOUT_REPOSITORY: "contributor/NemoClaw",
          CHECKOUT_SHA: headSha,
          EXPECTED_WORKFLOW_SHA: workflowSha,
          GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
          GITHUB_TOKEN: "token",
          INCLUDE_LAUNCHABLE: "false",
          JOBS: jobs,
          PR_NUMBER: "42",
          REVIEW_REASON: "Reviewed exact PR revision",
          RUN_ATTEMPT: "1",
          TARGETS: "",
          TRIGGERING_ACTOR: "maintainer",
          WORKFLOW_EVENT: "workflow_dispatch",
          WORKFLOW_REF: "refs/heads/main",
          WORKFLOW_SHA: workflowSha,
        },
      },
    );

    expect(result.status, result.stderr).toBe(expectedStatus);
    expect(result.stderr).toContain(expectedStderr);
  });

  it("uses central maintainer authorization for protected managed-image qualification", () => {
    const workflow = readE2eOperationsWorkflow();
    const guards = [
      ["managed-image-multiarch-startup", "Validate protected exact-head dispatch"],
      ["managed-image-protected-runtime", "Validate protected runtime exact-head dispatch"],
    ].map(
      ([jobName, stepName]) =>
        workflow.jobs[jobName].steps!.find((step) => step.name === stepName)!,
    );

    for (const guard of guards) {
      expect(guard.env).not.toHaveProperty("ACTOR");
      expect(guard.run).not.toContain("github-actions[bot]");
      expect(guard.run).toContain('"$WORKFLOW_SHA" == "$EXPECTED_WORKFLOW_SHA"');
      expect(guard.run).toContain('"$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$');
    }
  });

  it("accepts the default target matrix for an exact-revision manual PR run", () => {
    const workflow = readE2eOperationsWorkflow();
    const generateMatrix = workflow.jobs["generate-matrix"];
    const controller = generateMatrix.steps!.find(
      (step) => step.name === "Build trusted controller target matrix",
    )!;
    const planner = generateMatrix.steps!.find(
      (step) => step.name === "Generate E2E target matrix",
    )!;
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-manual-pr-matrix-"));
    const output = join(directory, "output");
    const summary = join(directory, "summary");

    try {
      writeFileSync(output, "");
      writeFileSync(summary, "");
      const controllerResult = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", controller.run!],
        {
          encoding: "utf8",
          env: { ...process.env, GITHUB_OUTPUT: output, JOBS: "", TARGETS: "" },
        },
      );
      expect(controllerResult.status, controllerResult.stderr).toBe(0);
      const controllerMatrix = readFileSync(output, "utf8")
        .trim()
        .replace(/^matrix=/u, "");

      writeFileSync(output, "");
      const plannerResult = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", planner.run!],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CHECKOUT_SHA: "a".repeat(40),
            CONTROLLER_MATRIX: controllerMatrix,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "mock",
            JOBS: "",
            TARGETS: "",
          },
        },
      );
      expect(plannerResult.status, plannerResult.stderr).toBe(0);
      const matrixLine = readFileSync(output, "utf8")
        .split("\n")
        .find((line) => line.startsWith("matrix="))!;
      const actualMatrix = JSON.parse(matrixLine.slice("matrix=".length));
      expect(
        actualMatrix.map(({ id, runner }: { id: string; runner: string }) => ({ id, runner })),
      ).toEqual(JSON.parse(controllerMatrix));
      expect(actualMatrix).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "ubuntu-policy-custom-missing-presets-negative" }),
          expect.objectContaining({ id: "ubuntu-repo-cloud-openclaw" }),
        ]),
      );
      expect(
        (generateMatrix as unknown as { outputs: Record<string, string> }).outputs.matrix,
      ).toBe("${{ steps.matrix.outputs.matrix }}");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("selects no shared targets for protected managed-runtime qualification", () => {
    const workflow = readE2eOperationsWorkflow();
    const controller = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Build trusted controller target matrix",
    )!;
    const planner = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Generate E2E target matrix",
    )!;
    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-protected-matrix-"));
    const output = join(directory, "output");
    const summary = join(directory, "summary");

    try {
      writeFileSync(output, "");
      writeFileSync(summary, "");
      const result = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", controller.run!],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GITHUB_OUTPUT: output,
            JOBS: "managed-image-protected-runtime",
            TARGETS: "",
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toBe("matrix=[]\n");

      writeFileSync(output, "");
      const plannerResult = spawnSync(
        "bash",
        ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", planner.run!],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            CHECKOUT_SHA: "a".repeat(40),
            CONTROLLER_MATRIX: "[]",
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            INFERENCE_MODE: "mock",
            JOBS: "managed-image-protected-runtime",
            TARGETS: "",
          },
        },
      );
      expect(plannerResult.status, plannerResult.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toContain("matrix=[]\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps every planned job wired to bound evidence", () => {
    const workflow = readE2eOperationsWorkflow();
    const job = workflow.jobs["cloud-onboard"];
    job.env!.E2E_TARGET_ID = "different-job";
    const run = job.steps!.find((step) =>
      String(step.run ?? "").includes("tools/e2e/live-vitest-invocation.mts run --test-path"),
    )!;
    run.run = run.run!.replace(
      "tools/e2e/live-vitest-invocation.mts run --test-path",
      "tools/e2e/live-vitest-invocation.mts runx --test-path",
    );
    const upload = job.steps!.find((step) =>
      step.uses?.startsWith("NVIDIA/NemoClaw/.github/actions/upload-e2e-artifacts@"),
    )!;
    upload.if = "success()";

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "cloud-onboard must expose matching E2E job identity",
        "cloud-onboard must attach the risk-signal reporter to every Vitest invocation",
        "cloud-onboard must always upload one evidence artifact",
      ]),
    );
  });

  it("rejects restoration of scheduled issue routing or broad issue-write access", () => {
    const workflow = readE2eOperationsWorkflow();
    workflow.permissions = "write-all";
    workflow.jobs["notify-on-failure"] = {
      permissions: { issues: "write" },
      steps: [{ run: "await github.rest.issues.create({});" }],
    };
    workflow.jobs.scorecard.permissions = { issues: "write" };
    workflow.jobs.scorecard.steps!.push({
      run: "await github.rest.issues.createComment({});",
    });
    workflow.jobs["cloud-onboard"].permissions = "write-all";
    workflow.jobs["report-to-pr"].permissions = "write-all";
    workflow.jobs["report-to-pr"].if = "${{ always() && github.event_name == 'schedule' }}";
    workflow.jobs["report-to-pr"].steps!.push({
      run: "await github.rest.issues.create({});",
    });

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "notify-on-failure must remain retired",
        "E2E workflow must not grant top-level issues: write",
        "E2E workflow must not grant top-level pull-requests: write",
        "notify-on-failure must not hold issues: write",
        "notify-on-failure must not mutate GitHub issues",
        "scorecard must not hold issues: write",
        "scorecard must not mutate GitHub issues",
        "cloud-onboard must not hold issues: write",
        "cloud-onboard must not hold pull-requests: write",
        "report-to-pr must not hold issues: write",
        "report-to-pr must hold only actions: read, contents: read, and pull-requests: write",
        "report-to-pr must run only for manual workflow dispatches",
        "report-to-pr must first check out the trusted workflow revision, then post its PR comment",
        "report-to-pr must not use issue mutations or generic GitHub write surfaces",
      ]),
    );
  });

  it("ties the remaining issue-comment permission to the validated PR", () => {
    const workflow = readE2eOperationsWorkflow();
    const report = workflow.jobs["report-to-pr"].steps!.find(
      (step) => step.name === "Post E2E target results to PR",
    )!;
    report.with!.script = String(report.with!.script)
      .replace(
        "issue_number: prNumber,",
        "issue_number: 5093,\n              // issue_number: prNumber,",
      )
      .concat(
        '\nawait github.request("POST /repos/{owner}/{repo}/issues", {});',
        "\nconst createIssue = github.rest.issues.create; await createIssue({});",
      );

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "report-to-pr must limit issue mutation to one validated PR-scoped createComment call",
        "report-to-pr must not use issue mutations or generic GitHub write surfaces",
      ]),
    );
  });

  it("requires prNumber and report to originate from the trusted resolveReportPr and renderE2eReport calls", () => {
    const workflow = readE2eOperationsWorkflow();
    const report = workflow.jobs["report-to-pr"].steps!.find(
      (step) => step.name === "Post E2E target results to PR",
    )!;
    report.with!.script = String(report.with!.script)
      .replace(
        "const prNumber = await resolveReportPr({ github, context, core, env: process.env });",
        "const prNumber = 5093;",
      )
      .replace(
        /const report = renderE2eReport\([^;]*\);/,
        "const report = { body: 'fake', warnings: [] };",
      );

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "report-to-pr must derive prNumber from the trusted resolveReportPr call",
        "report-to-pr must derive report from the trusted renderE2eReport call",
      ]),
    );
  });

  it.each([
    ["an aliased issue API", "const issues = github.rest.issues; await issues.create({});"],
    ["a bracketed issue API", 'await github.rest.issues["create"]({});'],
    ["a generic REST request", 'await github.request("POST /repos/{owner}/{repo}/issues", {});'],
    [
      "a GraphQL mutation",
      "await github.graphql(`mutation { createIssue(input: {}) { issue { id } } }`);",
    ],
  ])("rejects %s outside the PR reporter", (_label, mutation) => {
    const workflow = readE2eOperationsWorkflow();
    workflow.jobs.scorecard.steps!.push({ run: mutation });

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "scorecard must not mutate GitHub issues",
    );
  });

  it.each([
    [
      "an aliased generic REST request",
      'const request = github.request; await request("POST /repos/{owner}/{repo}/issues/1/comments", {});',
    ],
    [
      "a destructured generic REST request",
      'const { request: callApi } = github; await callApi("POST /repos/{owner}/{repo}/issues/1/comments", {});',
    ],
    [
      "an indirect GitHub alias",
      'const client = github; await client.request("POST /repos/{owner}/{repo}/issues/1/comments", {});',
    ],
    [
      "a nested destructured request",
      'const { request } = github.rest; await request("POST /repos/{owner}/{repo}/issues/1/comments", {});',
    ],
    [
      "an optional-chained request",
      'await github?.request("POST /repos/{owner}/{repo}/issues/1/comments", {});',
    ],
    [
      "a fetch call",
      "await fetch('https://api.github.com/repos/NVIDIA/NemoClaw/issues/1/comments', { method: 'POST' });",
    ],
    [
      "an aliased fetch call",
      "const send = fetch; await send('https://api.github.com/repos/NVIDIA/NemoClaw/issues/1/comments', { method: 'POST' });",
    ],
    ["a gh api call", "gh api repos/NVIDIA/NemoClaw/issues/1/comments -f body=failed"],
  ])("rejects %s outside the PR reporter", (_label, mutation) => {
    const workflow = readE2eOperationsWorkflow();
    workflow.jobs.scorecard.steps!.push({ run: mutation });

    expect(validateE2eOperationsWorkflow(workflow)).toContain(
      "scorecard must not use unvalidated generic write surfaces",
    );
  });

  it("reserves pull-request write permission for the validated PR reporter", () => {
    const workflow = readE2eOperationsWorkflow();
    workflow.permissions = { "pull-requests": "write" };
    workflow.jobs.scorecard.permissions = {
      actions: "read",
      contents: "read",
      "pull-requests": "write",
    };

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "E2E workflow must not grant top-level pull-requests: write",
        "scorecard must not hold pull-requests: write",
      ]),
    );
  });

  it("pins the Node 24 helper runtime and separate always-on raw trace cleanup", () => {
    const workflow = readE2eOperationsWorkflow();
    workflow.jobs["cloud-onboard"].env!.NEMOCLAW_TRACE_DIR =
      "${{ runner.temp }}/nemoclaw-cloud-onboard-traces";
    const scorecard = workflow.jobs.scorecard.steps!.find(
      (step) => step.name === "Generate E2E scorecard",
    )!;
    scorecard.uses = "actions/github-script@0000000000000000000000000000000000000000";
    const cleanup = workflow.jobs["cloud-onboard"].steps!.find(
      (step) => step.name === "Delete raw cloud-onboard traces",
    )!;
    cleanup.if = "success()";
    const slack = workflow.jobs.scorecard.steps!.find(
      (step) => step.name === "Post scorecard to Slack",
    )!;
    slack.if = "${{ steps.scorecard.outputs.slackData != '' }}";
    slack.with!.script = `${String(slack.with!.script)}\nrequire(process.env.GITHUB_WORKSPACE);`;

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "cloud-onboard trace directory must not use unavailable job-level contexts",
        "scorecard generator must use the pinned Node 24 github-script runtime",
        "cloud-onboard raw trace cleanup must always run",
        "scorecard Slack publisher must expose webhook secrets only on main",
        "scorecard Slack publisher must not execute workflow-ref code via GITHUB_WORKSPACE",
        "scorecard Slack publisher must not execute workflow-ref code via require(",
      ]),
    );
  });

  it("executes the scorecard workflow body and emits advisory budget warnings", async () => {
    const script = workflowScript("scorecard", "Generate E2E scorecard");
    const warning = vi.fn();
    const setOutput = vi.fn();
    const summary = {
      addRaw: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
    };
    summary.addRaw.mockReturnValue(summary);
    const traceTiming = {
      buildTraceTimingResult: vi.fn().mockResolvedValue({
        budgetWarningMessage: "Cloud onboard advisory performance budget exceeded",
        traceSummaryLines: [
          "",
          "### Onboard Performance Budget",
          "",
          "Status: **Advisory warning**",
        ],
        traceTimingLine: "Trace: cloud-onboard total 7m 0.0s",
      }),
    };
    const scorecardJobs = {
      loadWorkflowRunJobs: vi.fn().mockResolvedValue([]),
    };
    const coordinator = {
      buildScorecard: vi.fn().mockReturnValue({
        scorecardData: { ran: 0, runMode: "Main push", total: 0 },
        slackData: { channel: "daily", payload: { attachments: [], text: "scorecard fallback" } },
        summaryMarkdown: "## 🌅 NemoClaw E2E Scorecard\n\n### Onboard Performance Budget",
      }),
    };
    const runtimeAudit = {
      auditTestRuntime: vi.fn().mockReturnValue([{ target: "full-e2e" }]),
      collectRuntimeHistorySamples: vi.fn().mockReturnValue([{ target: "full-e2e" }]),
      formatRuntimeAuditSummary: vi
        .fn()
        .mockReturnValue("## E2E Test Phase Runtime\n\n| Target | Slowest observed phase |"),
    };
    const runtimeHistory = {
      buildRuntimeHistory: vi
        .fn()
        .mockResolvedValue("## E2E Push Runtime Trend\n\n| Target | Prior median |"),
      loadPriorPushSummaries: vi.fn(),
    };
    const firstTurnLatency = {
      readCurrentFirstTurnLatencySample: vi.fn().mockReturnValue(null),
    };
    const runtimeModules = new Map<string, unknown>([
      ["path", { join: (...parts: string[]) => parts.join("/") }],
      ["/workspace/scripts/audit-test-runtime.mts", runtimeAudit],
      ["/workspace/scripts/scorecard/analyze-first-turn-latency.mts", firstTurnLatency],
      ["/workspace/scripts/scorecard/analyze-runtime-history.mts", runtimeHistory],
      ["/workspace/scripts/scorecard/coordinate-scorecard.mts", coordinator],
      ["/workspace/scripts/scorecard/analyze-trace-timing.mts", traceTiming],
      ["/workspace/scripts/scorecard/summarize-jobs.mts", scorecardJobs],
    ]);
    const runtimeRequire = (specifier: string) => {
      const runtimeModule = runtimeModules.get(specifier);
      expect(runtimeModule, `Unexpected scorecard require: ${specifier}`).toBeDefined();
      return runtimeModule;
    };
    const processMock = {
      env: {
        EXPLICIT_ONLY_JOBS: "",
        GITHUB_WORKSPACE: "/workspace",
        JOBS: "",
        NEEDS_JSON: JSON.stringify({ "generate-matrix": { result: "success" } }),
        RUNTIME_ARTIFACTS: "/runner/e2e-runtime-audit",
        RUNTIME_SUMMARY_FILE: "/runner/e2e-runtime-summary.json",
        TARGETS: "",
      },
    };
    const context = {
      actor: "scorecard-test",
      eventName: "push",
      repo: { owner: "NVIDIA", repo: "NemoClaw" },
      runId: 123,
      serverUrl: "https://github.com",
    };
    const core = { setOutput, summary, warning };

    await new AsyncFunction("require", "process", "github", "context", "core", script)(
      runtimeRequire,
      processMock,
      {},
      context,
      core,
    );

    expect(traceTiming.buildTraceTimingResult).toHaveBeenCalledWith({ github: {}, context, core });
    expect(runtimeAudit.auditTestRuntime).toHaveBeenCalledWith(["/runner/e2e-runtime-audit"]);
    expect(runtimeAudit.collectRuntimeHistorySamples).toHaveBeenCalledWith([
      "/runner/e2e-runtime-audit",
    ]);
    expect(runtimeHistory.buildRuntimeHistory).toHaveBeenCalledWith(
      { github: {}, context, core },
      [{ target: "full-e2e" }],
      "/runner/e2e-runtime-summary.json",
      {
        currentFirstTurnLatency: null,
        loadPriorPushSummaries: runtimeHistory.loadPriorPushSummaries,
      },
    );
    expect(firstTurnLatency.readCurrentFirstTurnLatencySample).toHaveBeenCalledWith(
      "/runner/e2e-runtime-audit",
    );
    expect(runtimeAudit.auditTestRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      traceTiming.buildTraceTimingResult.mock.invocationCallOrder[0],
    );
    expect(warning).toHaveBeenCalledWith("Cloud onboard advisory performance budget exceeded");
    expect(coordinator.buildScorecard).toHaveBeenCalledWith(
      expect.objectContaining({
        apiJobs: [],
        eventName: "push",
        needs: { "generate-matrix": { result: "success" } },
        rawExplicitOnly: "",
        rawJobs: "",
        rawTargets: "",
        trace: expect.objectContaining({
          traceSummaryLines: expect.arrayContaining(["### Onboard Performance Budget"]),
        }),
      }),
    );
    expect(summary.addRaw).toHaveBeenCalledWith(
      expect.stringMatching(
        /### Onboard Performance Budget[\s\S]*## E2E Test Phase Runtime[\s\S]*## E2E Push Runtime Trend/u,
      ),
    );
    expect(summary.write).toHaveBeenCalledOnce();
    expect(setOutput).toHaveBeenCalledWith("scorecardData", expect.any(String));
    expect(setOutput).toHaveBeenCalledWith("slackData", expect.any(String));
  });

  it("keeps scorecard outputs available when a progress artifact is invalid", async () => {
    const script = workflowScript("scorecard", "Generate E2E scorecard");
    const warning = vi.fn();
    const setOutput = vi.fn();
    const summary = {
      addRaw: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
    };
    summary.addRaw.mockReturnValue(summary);
    const runtimeAudit = {
      auditTestRuntime: vi.fn(() => {
        throw new Error("invalid progress artifact");
      }),
      collectRuntimeHistorySamples: vi.fn(),
      formatRuntimeAuditSummary: vi.fn(),
    };
    const runtimeHistory = { buildRuntimeHistory: vi.fn() };
    const firstTurnLatency = { readCurrentFirstTurnLatencySample: vi.fn() };
    const runtimeModules = new Map<string, unknown>([
      ["path", { join: (...parts: string[]) => parts.join("/") }],
      ["/workspace/scripts/audit-test-runtime.mts", runtimeAudit],
      ["/workspace/scripts/scorecard/analyze-first-turn-latency.mts", firstTurnLatency],
      ["/workspace/scripts/scorecard/analyze-runtime-history.mts", runtimeHistory],
      [
        "/workspace/scripts/scorecard/coordinate-scorecard.mts",
        {
          buildScorecard: vi.fn().mockReturnValue({
            scorecardData: { ran: 0, runMode: "Main push", total: 0 },
            slackData: { channel: "daily", payload: { attachments: [], text: "scorecard" } },
            summaryMarkdown: "## 🌅 NemoClaw E2E Scorecard",
          }),
        },
      ],
      [
        "/workspace/scripts/scorecard/analyze-trace-timing.mts",
        {
          buildTraceTimingResult: vi.fn().mockResolvedValue({
            budgetWarningMessage: undefined,
            traceSummaryLines: [],
            traceTimingLine: "Trace: unavailable",
          }),
        },
      ],
      [
        "/workspace/scripts/scorecard/summarize-jobs.mts",
        { loadWorkflowRunJobs: vi.fn().mockResolvedValue([]) },
      ],
    ]);
    const runtimeRequire = (specifier: string) => {
      const runtimeModule = runtimeModules.get(specifier);
      expect(runtimeModule, `Unexpected scorecard require: ${specifier}`).toBeDefined();
      return runtimeModule;
    };
    const processMock = {
      env: {
        EXPLICIT_ONLY_JOBS: "",
        GITHUB_WORKSPACE: "/workspace",
        JOBS: "",
        NEEDS_JSON: JSON.stringify({ "generate-matrix": { result: "success" } }),
        RUNTIME_ARTIFACTS: "/runner/e2e-runtime-audit",
        RUNTIME_SUMMARY_FILE: "/runner/e2e-runtime-summary.json",
        TARGETS: "",
      },
    };
    const context = {
      actor: "scorecard-test",
      eventName: "push",
      repo: { owner: "NVIDIA", repo: "NemoClaw" },
      runId: 123,
      serverUrl: "https://github.com",
    };

    await new AsyncFunction("require", "process", "github", "context", "core", script)(
      runtimeRequire,
      processMock,
      {},
      context,
      { setOutput, summary, warning },
    );

    expect(warning).toHaveBeenCalledWith(
      "E2E test phase runtime summary unavailable: invalid progress artifact",
    );
    expect(runtimeAudit.formatRuntimeAuditSummary).not.toHaveBeenCalled();
    expect(runtimeAudit.collectRuntimeHistorySamples).not.toHaveBeenCalled();
    expect(firstTurnLatency.readCurrentFirstTurnLatencySample).not.toHaveBeenCalled();
    expect(runtimeHistory.buildRuntimeHistory).not.toHaveBeenCalled();
    expect(summary.addRaw).toHaveBeenCalledWith(
      expect.stringMatching(
        /The summary is unavailable because a `test-progress.json` artifact was invalid\.[\s\S]*The trend is unavailable because a `test-progress.json` artifact was invalid\./u,
      ),
    );
    expect(summary.write).toHaveBeenCalledOnce();
    expect(setOutput).toHaveBeenCalledWith("scorecardData", expect.any(String));
    expect(setOutput).toHaveBeenCalledWith("slackData", expect.any(String));
  });

  it("keeps selective scorecards silent unless Slack posting is explicitly enabled", async () => {
    const script = workflowScript("scorecard", "Post scorecard to Slack");
    const info = vi.fn();
    const fetchMock = vi.fn();
    vi.stubEnv(
      "SLACK_DATA",
      JSON.stringify({
        channel: "preview",
        payload: {
          text: "safe precomputed payload",
          attachments: [{ color: "#76b900", blocks: [] }],
        },
      }),
    );
    vi.stubEnv("POST_TO_SLACK", "false");
    try {
      await new AsyncFunction("process", "core", "fetch", script)(
        process,
        { info, setFailed: vi.fn() },
        fetchMock,
      );
      expect(info).toHaveBeenCalledWith("Selective dispatch without post_to_slack — skipping");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["empty payload", { channel: "daily", payload: {} }],
    [
      "missing text",
      { channel: "daily", payload: { attachments: [{ color: "#76b900", blocks: [] }] } },
    ],
    ["non-array attachments", { channel: "daily", payload: { text: "hi", attachments: {} } }],
    [
      "malformed attachment",
      { channel: "daily", payload: { text: "hi", attachments: [{ blocks: [] }] } },
    ],
  ])("rejects a precomputed Slack payload with %s before calling fetch", async (_label, data) => {
    const script = workflowScript("scorecard", "Post scorecard to Slack");
    const setFailed = vi.fn();
    const fetchMock = vi.fn();
    vi.stubEnv("SLACK_DATA", JSON.stringify(data));
    vi.stubEnv("POST_TO_SLACK", "true");
    try {
      await new AsyncFunction("process", "core", "fetch", script)(
        process,
        { info: vi.fn(), setFailed },
        fetchMock,
      );
      expect(setFailed).toHaveBeenCalledWith("Invalid precomputed Slack payload");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects raw trace upload ordering and unified advisor auto-dispatch", () => {
    const workflow = readE2eOperationsWorkflow();
    const cloudSteps = workflow.jobs["cloud-onboard"].steps!;
    const sanitize = cloudSteps.find(
      (step) => step.name === "Build trusted cloud-onboard timing summary",
    )!;
    sanitize.run = "cp -R raw-traces e2e-artifacts";

    const directory = mkdtempSync(join(tmpdir(), "nemoclaw-e2e-operations-"));
    const advisorPath = join(directory, "advisor.yaml");
    try {
      writeFileSync(advisorPath, "permissions: write-all\njobs:\n  advisor:\n    steps: []\n");
      expect(validateE2eOperationsWorkflow(workflow, advisorPath)).toContain(
        "Unified advisor must not hold actions: write",
      );

      writeFileSync(
        advisorPath,
        'permissions: read-all\njobs:\n  advisor:\n    permissions:\n      actions: "write"\n    steps:\n      - run: createWorkflowDispatch()\n',
      );
      expect(validateE2eOperationsWorkflow(workflow, advisorPath)).toEqual(
        expect.arrayContaining([
          "cloud-onboard trace sanitizer must retain scripts/e2e/sanitize-trace-timing.py",
          "Unified advisor must not hold actions: write",
          "Unified advisor must not auto-dispatch workflows",
        ]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
