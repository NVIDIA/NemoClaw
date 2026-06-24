// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  evaluateE2eVitestWorkflowDispatchSelectors,
  validateE2eVitestScenariosWorkflowBoundary,
} from "../../../tools/e2e-scenarios/workflow-boundary.mts";

function readWorkflow(): Record<string, unknown> {
  return YAML.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e-vitest-scenarios.yaml"),
      "utf-8",
    ),
  ) as Record<string, unknown>;
}

describe("spark install workflow boundary", () => {
  it("maps the Spark install selector to its free-standing Vitest job", () => {
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        scenarios: "spark-install",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["spark-install-vitest"],
      registryScenarios: [],
    });
    expect(
      evaluateE2eVitestWorkflowDispatchSelectors({
        jobs: "spark-install-vitest",
      }),
    ).toMatchObject({
      valid: true,
      liveScenariosRuns: false,
      selectedFreeStandingJobs: ["spark-install-vitest"],
      registryScenarios: [],
    });
  });

  it("rejects Spark install trusted-boundary drift", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-vitest-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }
      >;
    };
    const job = workflow.jobs["spark-install-vitest"];
    expect(job).toBeDefined();
    job["runs-on" as keyof typeof job] = "self-hosted" as never;
    job["timeout-minutes" as keyof typeof job] = 30 as never;
    job.env = {
      ...job.env,
      E2E_ARTIFACT_DIR: "tmp/spark-install",
      NEMOCLAW_CLI_BIN: "/usr/bin/nemoclaw",
      NEMOCLAW_RUN_E2E_SCENARIOS: "0",
      NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}",
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

    const setupNode = job.steps.find((step) => step.name === "Set up Node");
    expect(setupNode).toBeDefined();
    setupNode!.uses = "actions/setup-node@v6";

    const install = job.steps.find((step) => step.name === "Install root dependencies");
    expect(install).toBeDefined();
    install!.env = { NVIDIA_API_KEY: "${{ secrets.NVIDIA_API_KEY }}" };
    install!.run = "npm install";

    const runSpark = job.steps.find((step) => step.name === "Run Spark install live test");
    expect(runSpark).toBeDefined();
    runSpark!.env = {};
    runSpark!.run =
      "npx vitest run --project e2e-scenarios-live test/e2e-scenario/live/other.test.ts";

    const upload = job.steps.find((step) => step.name === "Upload Spark install artifacts");
    expect(upload).toBeDefined();
    upload!.with = {
      ...(upload!.with as Record<string, unknown>),
      name: "spark-install-artifacts",
      path: "e2e-artifacts/vitest/",
      "include-hidden-files": true,
      "if-no-files-found": "error",
      "retention-days": 1,
    };
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eVitestScenariosWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "spark-install-vitest job must run on ubuntu-latest",
          "spark-install-vitest job must keep a 45 minute timeout",
          "spark-install-vitest job must write artifacts under e2e-artifacts/vitest/spark-install",
          "spark-install-vitest job must point NEMOCLAW_CLI_BIN at the repo CLI",
          "spark-install-vitest job must set NEMOCLAW_RUN_E2E_SCENARIOS=1",
          "spark-install-vitest job must set NEMOCLAW_NON_INTERACTIVE=1",
          "spark-install-vitest job must accept third-party software non-interactively",
          "spark-install-vitest job must set NEMOCLAW_FRESH=1",
          "spark-install-vitest job must use the stable e2e-spark-install-vitest sandbox name",
          "spark-install-vitest job must use the cloud provider",
          "spark-install-vitest job must force OPENSHELL_GATEWAY=nemoclaw",
          "spark-install-vitest job env must not include NVIDIA_API_KEY",
          "spark-install-vitest checkout action must be pinned to a full commit SHA",
          "spark-install-vitest checkout step must set persist-credentials=false",
          "spark-install-vitest setup-node action must be pinned to a full commit SHA",
          "spark-install-vitest step 'Install root dependencies' env must not include NVIDIA_API_KEY",
          "step 'Install root dependencies' run script must include npm ci --ignore-scripts",
          "spark-install-vitest Vitest step must receive NVIDIA_API_KEY from secrets",
          "step 'Run Spark install live test' run script must include set -euo pipefail",
          "step 'Run Spark install live test' run script must include test/e2e-scenario/live/spark-install.test.ts",
          "spark-install-vitest artifact upload name must be stable",
          "artifact upload path must include e2e-artifacts/vitest/spark-install/",
          "spark-install-vitest artifact upload must set include-hidden-files: false",
          "spark-install-vitest artifact upload must ignore missing fixture artifacts",
          "spark-install-vitest artifact upload retention-days must be 14",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
