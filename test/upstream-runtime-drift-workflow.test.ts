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

describe("weekly upstream runtime drift workflow", () => {
  const workflow = readYaml<RuntimeDriftWorkflow>(".github/workflows/upstream-runtime-drift.yaml");
  const job = workflow.jobs?.report;

  // source-shape-contract: security -- The scheduled report must keep its GitHub token and Slack webhook on separate trusted steps
  it("runs Fridays with read-only access and sends Slack only from main", () => {
    expect(workflow.on?.schedule).toEqual([{ cron: "0 16 * * 5" }]);
    expect(Object.hasOwn(workflow.on ?? {}, "workflow_dispatch")).toBe(true);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job?.if).toBe("github.repository == 'NVIDIA/NemoClaw'");

    const checkout = job?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    const report = job?.steps?.find((step) => step.id === "drift");
    const upload = job?.steps?.find((step) => step.name === "Upload drift report");
    const slack = job?.steps?.find((step) => step.name === "Send the advisory Slack summary");
    expect(checkout?.uses).toMatch(FULL_SHA_ACTION);
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    expect(report?.env).toHaveProperty("GITHUB_TOKEN");
    expect(report?.env).not.toHaveProperty("SLACK_WEBHOOK_URL");
    expect(report?.run).toContain("scripts/checks/upstream-runtime-drift.mts");
    expect(report?.run).not.toContain("e2e");
    expect(upload?.uses).toMatch(FULL_SHA_ACTION);
    expect(slack?.uses).toBeUndefined();
    expect(slack?.if).toContain("github.ref == 'refs/heads/main'");
    expect(slack?.env).toHaveProperty("SLACK_WEBHOOK_URL");
    expect(slack?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(slack?.run).toContain("SLACK_WEBHOOK_URL_DAILY is not configured");
    expect(slack?.run).toContain('encoded.includes("<!")');

    const missingWebhook = spawnSync("bash", ["-euo", "pipefail", "-c", slack?.run ?? ""], {
      encoding: "utf8",
      env: { ...process.env, SLACK_WEBHOOK_URL: "" },
    });
    expect(missingWebhook.status, missingWebhook.stderr).toBe(0);
    expect(missingWebhook.stdout).toContain("the GitHub report remains available");
  });
});
