// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildChain } from "./dashboard/contract.js";
import { probeOnboardInferenceInvocation, verifyDeployment } from "./verify-deployment.js";

const NO_RETRY = { retryDelaysMs: [], sleep: async (_ms: number) => {} };
const DCODE_AGENT = "langchain-deepagents-code";

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    executeSandboxCommand: (_name: string, _script: string) => ({
      status: 0,
      stdout: "200",
      stderr: "",
    }),
    probeHostPort: (_port: number, _path: string) => 200,
    captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
    getMessagingChannels: (_name: string) => [] as string[],
    providerExistsInGateway: (_name: string) => true,
    ...overrides,
  };
}

/** Answer the models route with `code` and every other probe with HTTP 200. */
function makeModelsRouteDeps(code: string, overrides: Record<string, unknown> = {}) {
  return makeDeps({
    executeSandboxCommand: (_name: string, script: string) =>
      script.includes("inference.local")
        ? { status: 0, stdout: code, stderr: "" }
        : { status: 0, stdout: "200", stderr: "" },
    ...overrides,
  });
}

describe("verifyDeployment inference route model-catalog validation", () => {
  it("fails the deployment when the models route returns HTTP 404 (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { agentName: "openclaw", provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(false);
    expect(result.healthy).toBe(false);
  });

  it("names the unvalidated model catalog as the reason for a 404 (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { agentName: "openclaw", provider: "openrouter-api" },
    });

    const inference = result.diagnostics.find((entry) => entry.link === "inference");
    expect(inference?.status).toBe("fail");
    expect(inference?.detail).toContain("HTTP 404");
    expect(inference?.detail).toContain("model catalog");
  });

  it("fails a 404 for every agent when no route context is wired (#10543)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404"),
      NO_RETRY,
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("keeps a credential-gated HTTP 401 models route healthy (#2342)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("401"), {
      ...NO_RETRY,
      inferenceRouteContext: { agentName: "openclaw", provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(true);
  });

  it.each(["200junk", "20", "0200"])(
    "fails the deployment when the models route answers with the malformed token %j (#10609)",
    async (stdout) => {
      const result = await verifyDeployment(
        "my-sandbox",
        buildChain(),
        makeModelsRouteDeps(stdout),
        NO_RETRY,
      );

      expect(result.verification.inferenceRouteWorking).toBe(false);
    },
  );

  it("fails the deployment when the models-route command exits nonzero (#10609)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("200", {
        executeSandboxCommand: (_name: string, script: string) =>
          script.includes("inference.local")
            ? { status: 1, stdout: "200", stderr: "curl: (6) could not resolve host" }
            : { status: 0, stdout: "200", stderr: "" },
      }),
      NO_RETRY,
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("accepts the Deep Agents Code OpenRouter 404 when an inference request succeeds (#9834)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404", { probeInferenceInvocation: () => ({ ok: true }) }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { agentName: DCODE_AGENT, provider: "openrouter-api" },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(true);
  });

  it("fails the Deep Agents Code OpenRouter 404 when the inference request fails (#10543)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404", {
        probeInferenceInvocation: () => ({ ok: false, detail: "HTTP 401" }),
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { agentName: DCODE_AGENT, provider: "openrouter-api" },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("fails the Deep Agents Code OpenRouter 404 when no invocation probe is wired (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { agentName: DCODE_AGENT, provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("points a failed by-design 404 at the inference request, not the model catalog (#10543)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404", {
        probeInferenceInvocation: () => ({ ok: false, detail: "HTTP 401" }),
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { agentName: DCODE_AGENT, provider: "openrouter-api" },
      },
    );

    const inference = result.diagnostics.find((entry) => entry.link === "inference");
    expect(inference?.hint).toContain("serve no model catalog");
    expect(inference?.hint).not.toContain("endpoint serves");
  });

  it("tells a plain 404 to make the model catalog available (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { agentName: "openclaw", provider: "openrouter-api" },
    });

    const inference = result.diagnostics.find((entry) => entry.link === "inference");
    expect(inference?.hint).toContain("served no model catalog");
    expect(inference?.hint).toContain("/v1/models");
  });

  it("fails a 404 for the default agent that onboarding leaves unnamed (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { agentName: undefined, provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("gives a plain 404 the startup budget before failing it closed (#10543)", async () => {
    let modelsRouteCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        const isModelsRoute = script.includes("inference.local");
        modelsRouteCalls += isModelsRoute ? 1 : 0;
        return isModelsRoute
          ? { status: 0, stdout: "404", stderr: "" }
          : { status: 0, stdout: "200", stderr: "" };
      },
    });

    const result = await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { agentName: "openclaw", provider: "openrouter-api" },
    });

    expect(modelsRouteCalls).toBe(4);
    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("recovers when the model catalog registers after a late 404 (#6849)", async () => {
    const responses = ["404", "404", "200"];
    let modelsRouteCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        const isModelsRoute = script.includes("inference.local");
        modelsRouteCalls += isModelsRoute ? 1 : 0;
        return isModelsRoute
          ? { status: 0, stdout: responses[modelsRouteCalls - 1] ?? "200", stderr: "" }
          : { status: 0, stdout: "200", stderr: "" };
      },
    });

    const result = await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { agentName: "openclaw", provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(true);
  });

  it("spends no models-route retry budget on the expected Deep Agents Code 404 (#10543)", async () => {
    let modelsRouteCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: (_name: string, script: string) => {
        const isModelsRoute = script.includes("inference.local");
        modelsRouteCalls += isModelsRoute ? 1 : 0;
        return isModelsRoute
          ? { status: 0, stdout: "404", stderr: "" }
          : { status: 0, stdout: "200", stderr: "" };
      },
      probeInferenceInvocation: () => ({ ok: true }),
    });

    await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { agentName: DCODE_AGENT, provider: "openrouter-api" },
    });

    expect(modelsRouteCalls).toBe(1);
  });

  it("runs the invocation probe once for the Deep Agents Code 404 exception (#10543)", async () => {
    let invocationCalls = 0;
    const deps = makeModelsRouteDeps("404", {
      probeInferenceInvocation: () => {
        invocationCalls += 1;
        return { ok: false, detail: "HTTP 500" };
      },
    });

    await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { agentName: DCODE_AGENT, provider: "openrouter-api" },
    });

    expect(invocationCalls).toBe(1);
  });

  it("fails closed when no provider and model were recorded for the sandbox (#10543)", () => {
    const result = probeOnboardInferenceInvocation({
      sandboxName: "my-sandbox",
      gatewayName: "my-gateway",
      agentName: DCODE_AGENT,
      model: null,
      provider: "openrouter-api",
      preferredInferenceApi: null,
    });

    expect(result).toEqual({
      ok: false,
      detail: "no provider and model were recorded for this sandbox",
    });
  });
});
