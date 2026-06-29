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
  it("keeps scheduled routing and scorecards aggregated over the report job set", () => {
    expect(validateE2eOperationsWorkflowBoundary()).toEqual([]);

    const workflow = readE2eOperationsWorkflow();
    const reportNeeds = workflow.jobs["report-to-pr"].needs as string[];
    expect(workflow.jobs["notify-on-failure"].needs).toEqual(reportNeeds);
    expect(workflow.jobs.scorecard.needs).toEqual(reportNeeds);
  });

  it("rejects aggregation, permission, and secret-scope drift", () => {
    const workflow = readE2eOperationsWorkflow();
    (workflow.jobs["notify-on-failure"].needs as string[]).pop();
    workflow.jobs["notify-on-failure"].permissions = { contents: "write", issues: "write" };
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
        "notify-on-failure needs must exactly match report-to-pr needs",
        "notify-on-failure must hold only issues: write",
        "scorecard permissions must be actions: read and contents: read",
        "scorecard must not expose credentials at job scope",
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

  it("creates the scheduled failure issue when no historical thread exists", async () => {
    const script = workflowScript(
      "notify-on-failure",
      "Create or update scheduled E2E failure issue",
    ).replace(
      "${{ toJSON(needs) }}",
      JSON.stringify({ cloud: { result: "failure" }, hermes: { result: "cancelled" } }),
    );
    const create = vi.fn().mockResolvedValue({ data: { number: 123 } });
    const createComment = vi.fn();
    const github = {
      rest: {
        issues: {
          create,
          createComment,
          listForRepo: vi.fn().mockResolvedValue({ data: [] }),
        },
      },
    };
    const context = {
      repo: { owner: "NVIDIA", repo: "NemoClaw" },
      runId: 456,
      serverUrl: "https://github.com",
    };

    await new AsyncFunction("github", "context", script)(github, context);

    expect(createComment).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("**Failed:** cloud\n**Cancelled:** hermes"),
        labels: ["bug", "CI/CD"],
        owner: "NVIDIA",
        repo: "NemoClaw",
        title: expect.stringMatching(/^Nightly E2E failed — \d{4}-\d{2}-\d{2}$/u),
      }),
    );
  });

  it("keeps selective scorecards silent unless Slack posting is explicitly enabled", async () => {
    const script = workflowScript("scorecard", "Post scorecard to Slack");
    const info = vi.fn();
    const fetchMock = vi.fn();
    vi.stubEnv(
      "SLACK_DATA",
      JSON.stringify({ channel: "preview", payload: { text: "safe precomputed payload" } }),
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

  it("rejects raw trace upload ordering and advisor auto-dispatch restoration", () => {
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
        "E2E advisor must not hold actions: write",
      );

      writeFileSync(
        advisorPath,
        'permissions: read-all\njobs:\n  advisor:\n    permissions:\n      actions: "write"\n    steps:\n      - run: createWorkflowDispatch()\n',
      );
      expect(validateE2eOperationsWorkflow(workflow, advisorPath)).toEqual(
        expect.arrayContaining([
          "cloud-onboard trace sanitizer must retain scripts/e2e/sanitize-trace-timing.py",
          "E2E advisor must not hold actions: write",
          "E2E advisor must not auto-dispatch workflows",
        ]),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
