// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HOSTED_PROVIDER_SMOKE_CASES,
  hostedProviderSmokeEnvironment,
} from "../../../tools/e2e/hosted-provider-smoke.mts";
import {
  catalogueTarget,
  catalogueRecommendationSelectorIds,
  E2E_TARGET_CATALOGUE,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import {
  buildE2eWorkflowPlan,
  validateE2eWorkflowPlan,
} from "../../../tools/e2e/workflow-plan.mts";
import { validateStandardProfileWorkflowBoundary } from "../../../tools/e2e/standard-profile-workflow-boundary.mts";

import { requireProviderSmokeSelected } from "../live/inference-routing-helpers.ts";

const workflow = YAML.parse(readFileSync(".github/workflows/e2e.yaml", "utf8"));

describe.each(HOSTED_PROVIDER_SMOKE_CASES)("$label qualification selection", (selected) => {
  const id = `hosted-inference-${selected.selector}`;
  it("selects only the named provider in the existing smoke owner", () => {
    const target = catalogueTarget(id);
    expect(target.agentRuntime).toBe(selected.selector === "hermes" ? "hermes" : "openclaw");
    expect(target.testFile).toBe("test/e2e/live/inference-routing-provider-smoke.test.ts");
    expect(
      new RegExp(target.selector!).test(
        `${selected.id} ${selected.label} answers through its native provider`,
      ),
    ).toBe(true);
    expect(new RegExp(target.selector!).test("TC-INF-05 real NVIDIA key is isolated")).toBe(false);
    expect(
      buildE2eWorkflowPlan({ targets: id }).catalogueMatrices["hosted-inference"].map(
        (row) => row.id,
      ),
    ).toEqual([id]);
  });
  it("passes only its approved key and model and refuses missing prerequisites", () => {
    expect(
      hostedProviderSmokeEnvironment(id, {
        HOSTED_INFERENCE_API_KEY: "selected-canary",
        HOSTED_INFERENCE_MODEL: "approved-model",
        NVIDIA_API_KEY: "other-canary",
      }),
    ).toEqual({ [selected.credential]: "selected-canary", [selected.modelEnv]: "approved-model" });
    expect(() =>
      hostedProviderSmokeEnvironment(id, { HOSTED_INFERENCE_MODEL: "approved-model" }),
    ).toThrow("requires");
    expect(() =>
      hostedProviderSmokeEnvironment(id, { HOSTED_INFERENCE_API_KEY: "selected-canary" }),
    ).toThrow("requires");
  });
});

it("does not select hosted providers for unrelated shared files or the default suite", () => {
  expect(
    catalogueTargetsForChangedFiles(["tools/e2e/target-catalogue.mts"]).filter(
      (target) => target.profile === "hosted-inference",
    ),
  ).toEqual([]);
  expect(buildE2eWorkflowPlan().catalogueMatrices["hosted-inference"]).toEqual([]);
});

it("retains the trusted controller credential and artifact boundary", () => {
  expect(validateStandardProfileWorkflowBoundary(workflow)).toEqual([]);
});

it("selects automatic catalogue targets when their shared installer changes", () => {
  expect(catalogueTargetsForChangedFiles(["scripts/install-openshell.sh"])).toEqual(
    E2E_TARGET_CATALOGUE.filter((target) => target.profile !== "hosted-inference"),
  );
});

it("keeps hosted targets available for explicit recommendations only", () => {
  expect(
    buildE2eWorkflowPlan(
      {},
      { changedFiles: ["src/lib/inference/native-provider/lifecycle.ts"] },
    ).catalogueMatrices["hosted-inference"].map((row) => row.id),
  ).toEqual([]);
  expect(catalogueRecommendationSelectorIds()).toEqual(
    expect.arrayContaining(
      HOSTED_PROVIDER_SMOKE_CASES.map((entry) => `hosted-inference-${entry.selector}`),
    ),
  );
});

it.each(HOSTED_PROVIDER_SMOKE_CASES)(
  "does not automatically select $label for its profile change",
  (selected) => {
    expect(
      catalogueTargetsForChangedFiles([
        `managed-inference/provider-profiles/nemoclaw-${selected.selector}-inference-v1.yaml`,
      ])
        .filter((target) => target.profile === "hosted-inference")
        .map((target) => target.id),
    ).toEqual([]);
  },
);

describe.each(HOSTED_PROVIDER_SMOKE_CASES)("$label workflow credential boundary", (provider) => {
  it.each([
    { name: "main dispatch", allowed: true },
    { name: "main push", event: "push", allowed: true },
    {
      name: "approved candidate on main",
      candidate: "candidate-sha",
      approved: "true",
      allowed: true,
    },
    {
      name: "branch dispatch",
      ref: "refs/heads/feature",
      workflowRef: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/feature",
      allowed: false,
    },
    {
      name: "branch workflow with main ref",
      workflowRef: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/feature",
      allowed: false,
    },
    {
      name: "branch dispatch with approved candidate",
      ref: "refs/heads/feature",
      candidate: "candidate-sha",
      approved: "true",
      allowed: false,
    },
    { name: "fork dispatch", repository: "contributor/NemoClaw", allowed: false },
    { name: "pull request event", event: "pull_request", allowed: false },
    { name: "unapproved candidate", candidate: "candidate-sha", allowed: false },
  ])("restricts hosted credentials for $name", (scenario) => {
    const job = workflow.jobs["catalogue-hosted-inference"];
    const secrets = {
      DOCKERHUB_USERNAME: "registry-user",
      DOCKERHUB_TOKEN: "registry-canary",
      ...Object.fromEntries(
        HOSTED_PROVIDER_SMOKE_CASES.map((provider) => [provider.credential, provider.selector]),
      ),
    };
    const context = {
      github: {
        repository: scenario.repository ?? "NVIDIA/NemoClaw",
        ref: scenario.ref ?? "refs/heads/main",
        workflow_ref:
          scenario.workflowRef ?? "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main",
        event_name: scenario.event ?? "workflow_dispatch",
      },
      inputs: { checkout_sha: scenario.candidate ?? "" },
      needs: {
        "generate-matrix": { outputs: { e2e_credentials_allowed: scenario.approved ?? "false" } },
      },
      matrix: { id: `hosted-inference-${provider.selector}` },
      secrets,
    };
    const observed = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `
      const { readFileSync } = require("node:fs");
      const { runInNewContext } = require("node:vm");
      const { job, context } = JSON.parse(readFileSync(0, "utf8"));
      const evaluate = expression => runInNewContext(
        expression.slice(3, -2).replaceAll("needs.generate-matrix", 'needs["generate-matrix"]'),
        context, { timeout: 1000 });
      process.stdout.write(JSON.stringify({
        trusted: evaluate(job.with.trusted_main),
        ...Object.fromEntries(Object.entries(job.secrets).map(([name, expression]) => [name, evaluate(expression)])),
      }));
    `,
        ],
        { input: JSON.stringify({ job, context }), env: {}, encoding: "utf8", timeout: 5000 },
      ),
    );
    expect(observed).toEqual({
      trusted: scenario.allowed,
      DOCKERHUB_USERNAME: scenario.allowed ? "registry-user" : "",
      DOCKERHUB_TOKEN: scenario.allowed ? "registry-canary" : "",
      HOSTED_INFERENCE_API_KEY: scenario.allowed ? provider.selector : "",
    });
  });
});

// Evaluate the reusable workflow expression with distinct models to detect provider crossover.
it.each(HOSTED_PROVIDER_SMOKE_CASES)("routes only the approved $label model", (selected) => {
  const profile = YAML.parse(readFileSync(".github/workflows/e2e-standard-profile.yaml", "utf8"));
  const step = profile.jobs.run.steps.find(
    (entry: { name?: string }) => entry.name === "Run catalogue E2E target",
  );
  const plan = buildE2eWorkflowPlan({ targets: `hosted-inference-${selected.selector}` });
  const matrix = plan.catalogueMatrices["hosted-inference"][0]!;
  expect(matrix.model_env).toBe(selected.modelEnv);
  expect(() => validateE2eWorkflowPlan(plan)).not.toThrow();
  const observed = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const { readFileSync } = require("node:fs");
    const { runInNewContext } = require("node:vm");
    const { expression, callerExpression, context } = JSON.parse(readFileSync(0, "utf8"));
    context.inputs.hosted_inference_model = runInNewContext(callerExpression.slice(3, -2), context, { timeout: 1000 });
    process.stdout.write(runInNewContext(expression.slice(3, -2), context, { timeout: 1000 }));
  `,
    ],
    {
      input: JSON.stringify({
        expression: step.env.HOSTED_INFERENCE_MODEL,
        callerExpression: workflow.jobs["catalogue-hosted-inference"].with.hosted_inference_model,
        context: {
          matrix,
          inputs: { catalogue_id: `hosted-inference-${selected.selector}` },
          vars: Object.fromEntries(
            HOSTED_PROVIDER_SMOKE_CASES.map((provider) => [
              provider.modelEnv,
              `approved-${provider.selector}`,
            ]),
          ),
        },
      }),
      env: {},
      encoding: "utf8",
      timeout: 5000,
    },
  );
  expect(observed).toBe(`approved-${selected.selector}`);
  matrix.model_env = "UNRELATED_MODEL";
  expect(() => validateE2eWorkflowPlan(plan)).toThrow("invalid output schema");
  delete matrix.model_env;
  expect(() => validateE2eWorkflowPlan(plan)).toThrow("invalid output schema");
});

describe.each(HOSTED_PROVIDER_SMOKE_CASES)("$label local smoke prerequisites", (selected) => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "unrelated-provider"])("skips without matching opt-in %s", (requested) => {
    vi.stubEnv("NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE", requested);
    const skip = vi.fn();
    expect(() => requireProviderSmokeSelected(selected.selector, skip)).toThrow(
      `NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=${selected.selector}`,
    );
    expect(skip).toHaveBeenCalledOnce();
  });

  it("runs only after explicit selection and validates its named key and model", () => {
    vi.stubEnv("NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE", selected.selector);
    const skip = vi.fn();
    requireProviderSmokeSelected(selected.selector, skip);
    expect(skip).not.toHaveBeenCalled();
    const id = `hosted-inference-${selected.selector}`;
    expect(() =>
      hostedProviderSmokeEnvironment(id, {
        [selected.modelEnv]: "approved-model",
      }),
    ).toThrow("requires its approved credential and model");
    expect(() =>
      hostedProviderSmokeEnvironment(id, {
        [selected.credential]: "synthetic-selected-key",
      }),
    ).toThrow("requires its approved credential and model");
    expect(
      hostedProviderSmokeEnvironment(id, {
        [selected.credential]: "synthetic-selected-key",
        [selected.modelEnv]: "approved-model",
      }),
    ).toEqual({
      [selected.credential]: "synthetic-selected-key",
      [selected.modelEnv]: "approved-model",
    });
  });
});
