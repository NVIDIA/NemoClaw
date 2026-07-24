// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      "${{ always() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}";

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "report-to-pr must run only for manual workflow dispatches",
        "scorecard must run after scheduled and manual E2E executions",
      ]),
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

  it("rejects controller protocol and PR validation drift", () => {
    const workflow = readE2eOperationsWorkflow();
    delete workflow.on?.workflow_dispatch?.inputs?.base_sha;
    delete workflow.on?.workflow_dispatch?.inputs?.workflow_sha;
    delete workflow.on?.workflow_dispatch?.inputs?.plan_hash;
    workflow.env!.NEMOCLAW_E2E_PLAN_HASH = "${{ inputs.checkout_sha }}";
    workflow.concurrency!["cancel-in-progress"] = false;
    const validation = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Validate controller dispatch",
    )!;
    delete validation.env?.BASE_SHA;
    delete validation.env?.EXPECTED_WORKFLOW_SHA;
    validation.if = "${{ inputs.plan_hash != '' }}";
    validation.run = "echo unchecked";
    const checkout = workflow.jobs["generate-matrix"].steps!.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    )!;
    checkout.with!.ref = "${{ github.sha }}";

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        "workflow_dispatch base_sha must be an optional string with an empty default",
        "workflow_dispatch workflow_sha must be an optional string with an empty default",
        "workflow_dispatch plan_hash must be an optional string with an empty default",
        "E2E workflow must bind NEMOCLAW_E2E_PLAN_HASH to controller metadata",
        "PR E2E concurrency must cancel obsolete runs",
        "Controller validation must be activated only by checkout_sha",
        "Controller validation must bind BASE_SHA",
        "Controller validation must bind EXPECTED_WORKFLOW_SHA",
        'Controller validation must retain "$BASE_SHA" =~ ^[a-f0-9]{40}$',
        'Controller validation must retain "$WORKFLOW_SHA" == "$EXPECTED_WORKFLOW_SHA"',
        'Controller validation must retain [[ "$(jq -r \'.base.sha\' <<< "$pull_json")" == "$BASE_SHA" ]]',
        'Controller validation must retain "$PR_NUMBER" =~ ^[1-9][0-9]*$',
        "generate-matrix checkout must use the selected PR commit",
      ]),
    );
  });

  it("binds controller dispatch to the exact checkout, plan, and correlation identity (#6955)", () => {
    const workflow = readE2eOperationsWorkflow();
    const validation = workflow.jobs["generate-matrix"].steps!.find(
      (step) => step.name === "Validate controller dispatch",
    )!;
    validation.run = validation
      .run!.replace('[[ "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$ ]]', '[[ -n "$CHECKOUT_SHA" ]]')
      .replace('[[ "$PLAN_HASH" =~ ^[a-f0-9]{64}$ ]]', '[[ -n "$PLAN_HASH" ]]')
      .replace(
        '[[ "$CORRELATION_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$ ]]',
        '[[ -n "$CORRELATION_ID" ]]',
      )
      .replace(
        `[[ "$(jq -r '.head.sha' <<< "$pull_json")" == "$CHECKOUT_SHA" ]]`,
        `[[ -n "$(jq -r '.head.sha' <<< "$pull_json")" ]]`,
      );

    expect(validateE2eOperationsWorkflow(workflow)).toEqual(
      expect.arrayContaining([
        'Controller validation must retain "$CHECKOUT_SHA" =~ ^[a-f0-9]{40}$',
        'Controller validation must retain "$PLAN_HASH" =~ ^[a-f0-9]{64}$',
        'Controller validation must retain "$CORRELATION_ID" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',
        `Controller validation must retain [[ "$(jq -r '.head.sha' <<< "$pull_json")" == "$CHECKOUT_SHA" ]]`,
      ]),
    );
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
    const script = workflowScript("scorecard", "Generate E2E scorecard").replace(
      "${{ toJSON(needs) }}",
      JSON.stringify({ "generate-matrix": { result: "success" } }),
    );
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
        scorecardData: { ran: 0, runMode: "Scheduled E2E", total: 0 },
        slackData: { channel: "daily", payload: { attachments: [], text: "scorecard fallback" } },
        summaryMarkdown: "## 🌅 NemoClaw E2E Scorecard\n\n### Onboard Performance Budget",
      }),
    };
    const runtimeAudit = {
      auditTestRuntime: vi.fn().mockReturnValue([{ target: "full-e2e" }]),
      formatRuntimeAuditSummary: vi
        .fn()
        .mockReturnValue("## E2E Test Phase Runtime\n\n| Target | Slowest observed phase |"),
    };
    const runtimeModules = new Map<string, unknown>([
      ["path", { join: (...parts: string[]) => parts.join("/") }],
      ["/workspace/scripts/audit-test-runtime.mts", runtimeAudit],
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
        RUNTIME_ARTIFACTS: "/runner/e2e-runtime-audit",
        TARGETS: "",
      },
    };
    const context = {
      actor: "scorecard-test",
      eventName: "schedule",
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
    expect(runtimeAudit.auditTestRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      traceTiming.buildTraceTimingResult.mock.invocationCallOrder[0],
    );
    expect(warning).toHaveBeenCalledWith("Cloud onboard advisory performance budget exceeded");
    expect(coordinator.buildScorecard).toHaveBeenCalledWith(
      expect.objectContaining({
        apiJobs: [],
        eventName: "schedule",
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
      expect.stringMatching(/### Onboard Performance Budget[\s\S]*## E2E Test Phase Runtime/u),
    );
    expect(summary.write).toHaveBeenCalledOnce();
    expect(setOutput).toHaveBeenCalledWith("scorecardData", expect.any(String));
    expect(setOutput).toHaveBeenCalledWith("slackData", expect.any(String));
  });

  it("keeps scorecard outputs available when a progress artifact is invalid", async () => {
    const script = workflowScript("scorecard", "Generate E2E scorecard").replace(
      "${{ toJSON(needs) }}",
      JSON.stringify({ "generate-matrix": { result: "success" } }),
    );
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
      formatRuntimeAuditSummary: vi.fn(),
    };
    const runtimeModules = new Map<string, unknown>([
      ["path", { join: (...parts: string[]) => parts.join("/") }],
      ["/workspace/scripts/audit-test-runtime.mts", runtimeAudit],
      [
        "/workspace/scripts/scorecard/coordinate-scorecard.mts",
        {
          buildScorecard: vi.fn().mockReturnValue({
            scorecardData: { ran: 0, runMode: "Scheduled E2E", total: 0 },
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
        RUNTIME_ARTIFACTS: "/runner/e2e-runtime-audit",
        TARGETS: "",
      },
    };
    const context = {
      actor: "scorecard-test",
      eventName: "schedule",
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
    expect(summary.addRaw).toHaveBeenCalledWith(
      expect.stringContaining(
        "The summary is unavailable because a `test-progress.json` artifact was invalid.",
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
