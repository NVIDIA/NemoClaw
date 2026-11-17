// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_SMOKE,
  configureOpenRouterSmokeEnvironment,
  openRouterSmokeEnvironment,
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
const selected = OPENROUTER_SMOKE;

describe("OpenRouter qualification selection", () => {
  const id = "hosted-inference-openrouter";
  it("selects only the named provider in the existing smoke owner", () => {
    const target = catalogueTarget(id);
    expect(target.agentRuntime).toBe("openclaw + hermes + langchain-deepagents-code");
    expect(target.testFile).toBe("test/e2e/live/inference-routing-provider-smoke.test.ts");
    expect(target.timeoutMinutes).toBe(140);
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
      openRouterSmokeEnvironment({
        HOSTED_INFERENCE_API_KEY: "selected-canary",
        HOSTED_INFERENCE_MODEL: "approved-model",
        NVIDIA_API_KEY: "other-canary",
      }),
    ).toEqual({ [selected.credential]: "selected-canary", [selected.modelEnv]: "approved-model" });
    expect(() => openRouterSmokeEnvironment({ HOSTED_INFERENCE_MODEL: "approved-model" })).toThrow(
      "requires",
    );
    expect(() =>
      openRouterSmokeEnvironment({ HOSTED_INFERENCE_API_KEY: "selected-canary" }),
    ).toThrow("requires");
  });
  it("removes inherited retired provider credentials before the OpenRouter smoke", () => {
    const environment: NodeJS.ProcessEnv = {
      HOSTED_INFERENCE_API_KEY: "selected-canary",
      HOSTED_INFERENCE_MODEL: "approved-model",
      OPENAI_API_KEY: "retired-openai-canary",
      ANTHROPIC_API_KEY: "retired-anthropic-canary",
      GEMINI_API_KEY: "retired-gemini-canary",
      NOUS_API_KEY: "retired-hermes-canary",
      KEEP: "unrelated",
    };
    configureOpenRouterSmokeEnvironment(environment);
    expect(environment).toEqual({
      HOSTED_INFERENCE_MODEL: "approved-model",
      OPENROUTER_API_KEY: "selected-canary",
      NEMOCLAW_OPENROUTER_MODEL: "approved-model",
      KEEP: "unrelated",
    });
  });
});

it.each(["openai", "anthropic", "gemini", "hermes"])(
  "does not register or route the retired %s credentialed target",
  (provider) => {
    const id = `hosted-inference-${provider}`;
    expect(E2E_TARGET_CATALOGUE.map((target) => target.id)).not.toContain(id);
    expect(catalogueRecommendationSelectorIds()).not.toContain(id);
    expect(() => catalogueTarget(id)).toThrow("Unknown catalogue E2E target");
    expect(() => buildE2eWorkflowPlan({ targets: id })).toThrow();
  },
);

it("runs all three OpenRouter agents through the existing trusted target", () => {
  const target = catalogueTarget("hosted-inference-openrouter");
  expect(
    new RegExp(target.selector!).test("TC-INF-07D Deep Agents Code reaches native OpenRouter"),
  ).toBe(true);
  expect(
    new RegExp(target.selector!).test(
      "'TC-INF-07' 'OpenRouter' answers through its native provider",
    ),
  ).toBe(true);
  expect(
    new RegExp(target.selector!).test(
      "TC-INF-07H Hermes authenticates immediately after OpenRouter rebuild",
    ),
  ).toBe(true);
  expect(target.environment.NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE).toBe("openrouter");
  const selectedTestMinutes = 20 + 35 + 35;
  const cleanupMinutes = 3 * 10;
  const setupAndArtifactMinutes = 15;
  expect(target.timeoutMinutes).toBeGreaterThanOrEqual(
    selectedTestMinutes + cleanupMinutes + setupAndArtifactMinutes,
  );
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
    expect.arrayContaining(["hosted-inference-openrouter"]),
  );
});

it("does not automatically select OpenRouter for its profile change", () => {
  expect(
    catalogueTargetsForChangedFiles([
      "managed-inference/provider-profiles/nemoclaw-openrouter-inference-v1.yaml",
    ])
      .filter((target) => target.profile === "hosted-inference")
      .map((target) => target.id),
  ).toEqual([]);
});

describe("OpenRouter workflow credential boundary", () => {
  const provider = OPENROUTER_SMOKE;
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
      OPENAI_API_KEY: "retired-openai-canary",
      ANTHROPIC_API_KEY: "retired-anthropic-canary",
      GEMINI_API_KEY: "retired-gemini-canary",
      NOUS_API_KEY: "retired-hermes-canary",
      OPENROUTER_API_KEY: "openrouter",
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

it.each(["openai", "anthropic", "gemini", "hermes"])(
  "does not forward the retired %s secret even in a trusted workflow",
  (provider) => {
    const expression = workflow.jobs["catalogue-hosted-inference"].secrets.HOSTED_INFERENCE_API_KEY;
    const context = {
      github: {
        repository: "NVIDIA/NemoClaw",
        ref: "refs/heads/main",
        workflow_ref: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main",
        event_name: "workflow_dispatch",
      },
      inputs: { checkout_sha: "" },
      needs: { "generate-matrix": { outputs: { e2e_credentials_allowed: "true" } } },
      matrix: { id: `hosted-inference-${provider}` },
      secrets: {
        OPENROUTER_API_KEY: "selected-canary",
        OPENAI_API_KEY: "retired-canary",
        ANTHROPIC_API_KEY: "retired-canary",
        GEMINI_API_KEY: "retired-canary",
        NOUS_API_KEY: "retired-canary",
      },
    };
    const observed = execFileSync(
      process.execPath,
      [
        "-e",
        `const { readFileSync } = require("node:fs");
        const { runInNewContext } = require("node:vm");
        const { expression, context } = JSON.parse(readFileSync(0, "utf8"));
        process.stdout.write(runInNewContext(
          expression.slice(3, -2).replaceAll("needs.generate-matrix", 'needs["generate-matrix"]'),
          context, { timeout: 1000 }));`,
      ],
      { input: JSON.stringify({ expression, context }), env: {}, encoding: "utf8", timeout: 5000 },
    );
    expect(observed).toBe("");
  },
);

// Evaluate the reusable workflow expression with an unrelated model to detect model crossover.
it("routes only the approved OpenRouter model", () => {
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
          vars: { NEMOCLAW_OPENROUTER_MODEL: "approved-openrouter" },
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

describe("OpenRouter local smoke prerequisites", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each([undefined, "unrelated-provider", "all", "openai", "anthropic", "gemini", "hermes"])(
    "skips without matching opt-in %s",
    (requested) => {
      vi.stubEnv("NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE", requested);
      const skip = vi.fn();
      expect(() => requireProviderSmokeSelected(selected.selector, skip)).toThrow(
        `NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE=${selected.selector}`,
      );
      expect(skip).toHaveBeenCalledOnce();
    },
  );

  it("runs only after explicit selection and validates its named key and model", () => {
    vi.stubEnv("NEMOCLAW_INFERENCE_ROUTING_PROVIDER_SMOKE", selected.selector);
    const skip = vi.fn();
    requireProviderSmokeSelected(selected.selector, skip);
    expect(skip).not.toHaveBeenCalled();
    expect(() =>
      openRouterSmokeEnvironment({
        [selected.modelEnv]: "approved-model",
      }),
    ).toThrow("requires its approved credential and model");
    expect(() =>
      openRouterSmokeEnvironment({
        [selected.credential]: "synthetic-selected-key",
      }),
    ).toThrow("requires its approved credential and model");
    expect(
      openRouterSmokeEnvironment({
        [selected.credential]: "synthetic-selected-key",
        [selected.modelEnv]: "approved-model",
      }),
    ).toEqual({
      [selected.credential]: "synthetic-selected-key",
      [selected.modelEnv]: "approved-model",
    });
  });
});
