// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { writeE2eWorkflowPlanCiOutput } from "../../../tools/e2e/workflow-plan.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type E2eWorkflow = {
  jobs: Record<
    string,
    {
      steps: Array<{
        env?: Record<string, string>;
        id?: string;
        name?: string;
        run?: string;
        with?: Record<string, unknown>;
      }>;
    }
  >;
};

describe("trusted E2E planning boundary", () => {
  it.each([
    ["ref", "${{ inputs.checkout_sha }}"],
    ["repository", "${{ inputs.checkout_repository }}"],
    ["persist-credentials", true],
  ] as const)("rejects a trusted planner checkout with changed %s", (key, value) => {
    const workflow = readWorkflow() as E2eWorkflow;
    const checkout = workflow.jobs["generate-matrix"]!.steps.find(
      (step) => step.name === "Check out trusted E2E planner",
    )!;
    const validationError =
      "trusted E2E planner checkout must use the workflow commit without credentials";
    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);

    checkout.with![key] = value;

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });

  it("rejects candidate checkout before trusted planning finishes", () => {
    const workflow = readWorkflow() as E2eWorkflow;
    const steps = workflow.jobs["generate-matrix"]!.steps;
    const candidate = steps.find((step) => step.name === "Check out E2E candidate")!;
    const validationError =
      "trusted E2E planning must finish before candidate checkout and execution";
    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);

    steps.splice(steps.indexOf(candidate), 1);
    steps.splice(
      steps.findIndex((step) => step.name === "Generate E2E target matrix"),
      0,
      candidate,
    );

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });

  it.each([
    [
      "main push",
      {},
      "",
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "tavily-fixture-key",
      null,
    ],
    [
      "main dispatch",
      { event_name: "workflow_dispatch" },
      "",
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "tavily-fixture-key",
      null,
    ],
    [
      "branch dispatch",
      { event_name: "workflow_dispatch", ref: "refs/heads/topic" },
      "",
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "",
      null,
    ],
    [
      "branch workflow",
      { workflow_ref: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/topic" },
      "",
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "",
      null,
    ],
    [
      "fork",
      { repository: "example/NemoClaw" },
      "",
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "",
      null,
    ],
    [
      "pull request",
      { event_name: "pull_request" },
      "",
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "",
      null,
    ],
    [
      "admitted candidate",
      { event_name: "workflow_dispatch" },
      "a".repeat(40),
      "true",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "tavily-fixture-key",
      null,
    ],
    [
      "unadmitted candidate",
      { event_name: "workflow_dispatch" },
      "a".repeat(40),
      "false",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "",
      new Error("Manual PR E2E requires an authorized source branch in NVIDIA/NemoClaw"),
    ],
    [
      "other target",
      { event_name: "workflow_dispatch" },
      "a".repeat(40),
      "true",
      "ubuntu-repo-cloud-openclaw",
      "",
      null,
    ],
  ])(
    "evaluates Tavily credential access for %s",
    (_name, githubOverrides, checkout, admission, target, expected, expectedPlanError) => {
      const workflow = readWorkflow() as E2eWorkflow;
      const run = workflow.jobs.live!.steps.find((step) => step.name === "Run live E2E tests")!;
      const context = {
        matrix: { id: target },
        github: {
          repository: "NVIDIA/NemoClaw",
          ref: "refs/heads/main",
          event_name: "push",
          workflow_ref: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main",
          ...githubOverrides,
        },
        inputs: { checkout_sha: checkout },
        needs: { "generate-matrix": { outputs: { e2e_credentials_allowed: admission } } },
        secrets: { TAVILY_API_KEY: "tavily-fixture-key" },
      };
      // Execute the string/boolean expression with synthetic credentials in a separate process.
      const observed = JSON.parse(
        execFileSync(
          process.execPath,
          [
            "-e",
            `
      const { readFileSync } = require("node:fs");
      const { runInNewContext } = require("node:vm");
      const { expression, context } = JSON.parse(readFileSync(0, "utf8"));
      const result = runInNewContext(
        expression.slice(3, -2).replaceAll("needs.generate-matrix", 'needs["generate-matrix"]'),
        context, { timeout: 1000 });
      process.stdout.write(JSON.stringify(result));
    `,
          ],
          {
            input: JSON.stringify({ expression: run.env!.TAVILY_API_KEY, context }),
            env: {},
            encoding: "utf8",
            timeout: 5000,
          },
        ),
      );
      expect(observed).toBe(expected);
      const directory = mkdtempSync(path.join(tmpdir(), "tavily-dispatch-plan-"));
      const output = path.join(directory, "output");
      try {
        const plan = () =>
          writeE2eWorkflowPlanCiOutput(
            { targets: target },
            {
              INFERENCE_MODE: "mock",
              GITHUB_REPOSITORY: context.github.repository,
              GITHUB_REF: context.github.ref,
              GITHUB_WORKFLOW_REF: context.github.workflow_ref,
              EVENT_NAME: context.github.event_name,
              NEMOCLAW_E2E_EXPECTED_SHA: checkout,
              NEMOCLAW_E2E_CREDENTIALS_ALLOWED: admission,
              GITHUB_OUTPUT: output,
              GITHUB_STEP_SUMMARY: path.join(directory, "summary"),
            },
          );
        let planError: unknown = null;
        try {
          plan();
        } catch (error) {
          planError = error;
        }
        expect(planError).toEqual(expectedPlanError);
        expect(existsSync(output)).toBe(expectedPlanError === null);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("rejects an inference credential exposed to an unauthorized PR candidate", () => {
    const workflow = readWorkflow() as E2eWorkflow;
    const run = workflow.jobs.live!.steps.find((step) => step.name === "Run live E2E tests")!;
    const validationError =
      "live E2E step must guard NVIDIA_INFERENCE_API_KEY behind a trusted main run or an authorized NVIDIA-owned PR dispatch";

    expect(validateE2eWorkflow(workflow)).not.toContain(validationError);
    run.env!.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";

    expect(validateE2eWorkflow(workflow)).toContain(validationError);
  });
});
