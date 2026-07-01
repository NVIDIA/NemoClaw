// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  evaluateE2eWorkflowDispatchSelectors,
  validateE2eWorkflowBoundary,
} from "../../../tools/e2e/workflow-boundary.mts";
import { assertSparkInstallSandboxName } from "../live/spark-install-helpers.ts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(path.join(process.cwd(), ".github/workflows/e2e.yaml"), "utf-8"),
  ) as Record<string, unknown>;
}

describe("spark install workflow boundary", () => {
  it("uses a test-owned sandbox name accepted by the live cleanup guard", () => {
    const workflow = readWorkflow() as {
      jobs: Record<string, { env?: Record<string, unknown> }>;
    };
    const sandboxName = workflow.jobs["spark-install"]?.env?.NEMOCLAW_SANDBOX_NAME;

    expect(sandboxName).toBe("e2e-spark-install-ci");
    expect(assertSparkInstallSandboxName(String(sandboxName))).toBe(sandboxName);
  });

  it("maps the Spark install selector to its free-standing E2E job", () => {
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        targets: "spark-install",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["spark-install"],
      registryTargets: [],
    });
    expect(
      evaluateE2eWorkflowDispatchSelectors({
        jobs: "spark-install",
      }),
    ).toMatchObject({
      valid: true,
      liveTargetsRun: false,
      selectedFreeStandingJobs: ["spark-install"],
      registryTargets: [],
    });
  });

  it("rejects Spark install trusted-boundary drift", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }
      >;
    };
    const job = workflow.jobs["spark-install"];
    expect(job).toBeDefined();
    job["runs-on" as keyof typeof job] = "self-hosted" as never;
    job["timeout-minutes" as keyof typeof job] = 30 as never;
    job.env = {
      ...job.env,
      E2E_ARTIFACT_DIR: "tmp/spark-install",
      NEMOCLAW_CLI_BIN: "/usr/bin/nemoclaw",
      NEMOCLAW_RUN_LIVE_E2E: "0",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      NEMOCLAW_NON_INTERACTIVE: "0",
      NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "0",
      NEMOCLAW_FRESH: "0",
      NEMOCLAW_SANDBOX_NAME: "personal-dev",
      NEMOCLAW_PROVIDER: "custom",
      OPENSHELL_GATEWAY: "shared",
    };

    const checkout = job.steps.find((step) =>
      String(step.uses ?? "").startsWith("actions/checkout@"),
    );
    expect(checkout).toBeDefined();
    checkout!.uses = "actions/checkout@v6";
    checkout!.with = {
      ...(checkout!.with as Record<string, unknown>),
      "persist-credentials": true,
    };

    const runSpark = job.steps.find((step) => step.name === "Run Spark install live test");
    expect(runSpark).toBeDefined();
    runSpark!.env = {};
    runSpark!.run = "npx vitest run --project e2e-live test/e2e/live/other.test.ts";

    const upload = job.steps.find((step) => step.name === "Upload Spark install artifacts");
    expect(upload).toBeDefined();
    upload!.with = {
      ...(upload!.with as Record<string, unknown>),
      name: "spark-install-artifacts",
      path: "e2e-artifacts/live/",
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 1,
    };
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "spark-install job must run on ubuntu-latest",
          "spark-install job must keep a 45 minute timeout",
          "spark-install job must write artifacts under e2e-artifacts/live/spark-install",
          "spark-install job must point NEMOCLAW_CLI_BIN at the repo CLI",
          "spark-install job must set NEMOCLAW_RUN_LIVE_E2E=1",
          "spark-install job must set NEMOCLAW_NON_INTERACTIVE=1",
          "spark-install job must accept third-party software non-interactively",
          "spark-install job must set NEMOCLAW_FRESH=1",
          "spark-install job must use the stable e2e-spark-install-ci sandbox name",
          "spark-install job must use the cloud provider",
          "spark-install job must force OPENSHELL_GATEWAY=nemoclaw",
          "spark-install job env must not include NVIDIA_INFERENCE_API_KEY",
          "spark-install checkout action must be pinned to a full commit SHA",
          "spark-install checkout step must set persist-credentials=false",
          "spark-install live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets",
          "step 'Run Spark install live test' run script must include set -euo pipefail",
          "step 'Run Spark install live test' run script must include test/e2e/live/spark-install.test.ts",
          "spark-install artifact upload name must be stable",
          "artifact upload path must include e2e-artifacts/live/spark-install/",
          "spark-install artifact upload must set include-hidden-files: false",
          "spark-install artifact upload must ignore missing fixture artifacts",
          "spark-install artifact upload retention-days must be 14",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
