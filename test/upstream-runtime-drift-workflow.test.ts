// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { readYaml, type WorkflowStep } from "./helpers/e2e-workflow-contract";

const FULL_SHA_ACTION = /@[0-9a-f]{40}$/iu;

type RuntimeDriftWorkflow = {
  on?: {
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: unknown;
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      if?: string;
      steps?: WorkflowStep[];
    }
  >;
};

describe("nightly upstream runtime drift workflow", () => {
  const workflow = readYaml<RuntimeDriftWorkflow>(".github/workflows/upstream-runtime-drift.yaml");
  const job = workflow.jobs?.report;

  // source-shape-contract: security -- The scheduled report must keep its GitHub token and Slack bot token on separate trusted steps
  it("runs nightly with read-only access and sends Slack only from main", () => {
    expect(workflow.on?.schedule).toEqual([{ cron: "0 5 * * *" }]);
    expect(Object.hasOwn(workflow.on ?? {}, "workflow_dispatch")).toBe(true);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job?.if).toBe("github.repository == 'NVIDIA/NemoClaw'");

    const checkout = job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    const report = job?.steps?.find((step) => step.id === "drift");
    const upload = job?.steps?.find((step) => step.name === "Upload Pin Diesel report");
    const slack = job?.steps?.find((step) => step.name === "Send Pin Diesel to the situation room");
    expect(checkout?.uses).toMatch(FULL_SHA_ACTION);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(report?.env).toHaveProperty("GITHUB_TOKEN");
    expect(report?.env).not.toHaveProperty("SLACK_BOT_TOKEN");
    expect(report?.run).toContain("scripts/checks/upstream-runtime-drift.mts");
    expect(report?.run).toContain('--nemoclaw-sha "${GITHUB_SHA}"');
    expect(report?.run).toContain('--report-output "${REPORT_DIR}/report.md"');
    expect(report?.run).not.toContain("e2e");
    expect(upload?.uses).toMatch(FULL_SHA_ACTION);
    expect(upload?.with?.name).toBe("pin-diesel-nightly-report");
    expect(upload?.with?.["retention-days"]).toBe(30);
    expect(slack?.uses).toBeUndefined();
    expect(slack?.if).toContain("github.ref == 'refs/heads/main'");
    expect(slack?.env).toMatchObject({
      SLACK_BOT_TOKEN: "${{ secrets.SLACK_BOT_TOKEN_PIN_DIESEL }}",
      SLACK_CHANNEL_ID: "C0ALN454EH4",
      SLACK_CHANNEL_NAME: "nemoclaw-situation-room",
    });
    expect(slack?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(slack?.run).toContain("SLACK_BOT_TOKEN_PIN_DIESEL is not configured");
    expect(slack?.run).toContain("https://slack.com/api/chat.postMessage");
    expect(slack?.run).toContain("authorization: `Bearer ${token}`");
    expect(slack?.run).toContain("result.channel !== channel");
    expect(slack?.run).not.toContain("hooks.slack.com");
    expect(slack?.run).not.toContain("SLACK_WEBHOOK_URL_SITUATION_ROOM");
    expect(slack?.run).not.toContain("SLACK_WEBHOOK_URL_DAILY");
    expect(slack?.run).toContain('encoded.includes("<!")');

    const missingToken = spawnSync("bash", ["-euo", "pipefail", "-c", slack?.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        SLACK_BOT_TOKEN: "",
        SLACK_CHANNEL_ID: "C0ALN454EH4",
        SLACK_CHANNEL_NAME: "nemoclaw-situation-room",
      },
    });
    expect(missingToken.status, missingToken.stderr).toBe(0);
    expect(missingToken.stdout).toContain(
      "Pin Diesel cannot post to #nemoclaw-situation-room (C0ALN454EH4)",
    );
    expect(missingToken.stdout).toContain("The GitHub report remains available");
  });
});
