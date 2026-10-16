// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { buildChain } from "./dashboard/contract.js";
import {
  nativeLocalIdentity,
  NATIVE_LOCAL_CREDENTIAL_ENV,
} from "./inference/native-local/contract.js";
import {
  onboardInferenceVerificationContext,
  probeOnboardInferenceInvocation,
  verifyDeployment,
} from "./verify-deployment.js";

const NO_RETRY = { retryDelaysMs: [], sleep: async (_ms: number) => {} };
const DCODE_AGENT = "langchain-deepagents-code";
const localBinding = {
  provider: "ollama-local" as const,
  endpointUrl: "http://host.openshell.internal:11434/v1",
  credentialEnv: NATIVE_LOCAL_CREDENTIAL_ENV,
  authMode: "sentinel" as const,
  gatewayName: "my-gateway",
  sandboxName: "my-sandbox",
};
const localAttachment = {
  ...localBinding,
  ...nativeLocalIdentity(localBinding),
  schemaVersion: 1 as const,
  providerId: "provider-1",
};

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    executeSandboxCommand: async (_name: string, _script: string) => ({
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
    executeSandboxCommand: async (_name: string, script: string) =>
      script.includes("inference.local")
        ? { status: 0, stdout: code, stderr: "" }
        : { status: 0, stdout: "200", stderr: "" },
    ...overrides,
  });
}

describe("verifyDeployment inference route model-catalog validation", () => {
  it.each([
    ["openclaw", false],
    [DCODE_AGENT, true],
    ["pi", false],
    ["hermes", false],
  ])("selects the same onboarding verification route for %s", (agentName, expected) => {
    const context = onboardInferenceVerificationContext("my-sandbox", "my-gateway", agentName, {
      provider: "compatible-endpoint",
      model: "test-model",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      preferredInferenceApi: "openai-completions",
    });

    expect(context.route.nativeLocalExpected).toBe(expected);
    expect(context.invocation.nativeLocalExpected).toBe(expected);
  });

  it("verifies owned Local NIM through the shared route while expecting native standalone vLLM", () => {
    const flow = {
      provider: "vllm-local",
      model: "test-model",
      endpointUrl: "http://host.openshell.internal:8000/v1",
      preferredInferenceApi: "openai-completions",
    };
    const binding = {
      ...localBinding,
      provider: "vllm-local" as const,
      endpointUrl: "http://host.openshell.internal:8000/v1",
    };
    const staleAttachment = {
      ...binding,
      ...nativeLocalIdentity(binding),
      schemaVersion: 1 as const,
      providerId: "stale-provider",
    };
    const nim = onboardInferenceVerificationContext("my-sandbox", "my-gateway", DCODE_AGENT, flow, {
      nimContainer: "nemoclaw-nim-owned",
      nativeLocalProviderAttachment: staleAttachment,
    });
    const vllm = onboardInferenceVerificationContext("my-sandbox", "my-gateway", DCODE_AGENT, flow);
    expect(nim.route.nativeLocalExpected).toBe(false);
    expect(nim.invocation.nativeLocalExpected).toBe(false);
    expect(nim.route.nativeLocalProviderAttachment).toBeUndefined();
    expect(nim.invocation.nativeLocalProviderAttachment).toBeUndefined();
    expect(vllm.route.nativeLocalExpected).toBe(true);
  });

  it("uses the recorded native local attachment instead of the shared models route", async () => {
    const scripts: string[] = [];
    const probeInferenceInvocation = vi.fn(async () => ({ ok: true }) as const);
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeDeps({
        executeSandboxCommand: async (_name: string, script: string) => {
          scripts.push(script);
          return { status: 0, stdout: "200", stderr: "" };
        },
        probeInferenceInvocation,
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: {
          provider: "ollama-local",
          gatewayName: "my-gateway",
          nativeLocalExpected: true,
          nativeLocalProviderAttachment: localAttachment,
        },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(true);
    expect(probeInferenceInvocation).toHaveBeenCalledOnce();
    expect(scripts.join("\n")).not.toContain("inference.local");
  });

  it("fails closed when a selected native local route has no attachment", async () => {
    const probeInferenceInvocation = vi.fn(async () => ({ ok: true }) as const);
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("200", { probeInferenceInvocation }),
      {
        ...NO_RETRY,
        inferenceRouteContext: {
          provider: "ollama-local",
          nativeLocalExpected: true,
        },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
    expect(result.diagnostics.find((entry) => entry.link === "inference")?.detail).toContain(
      "attachment is missing or invalid",
    );
    expect(probeInferenceInvocation).not.toHaveBeenCalled();
  });

  it("rejects a native local attachment from another gateway before probing inference", async () => {
    const probeInferenceInvocation = vi.fn(async () => ({ ok: true }) as const);
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("200", { probeInferenceInvocation }),
      {
        ...NO_RETRY,
        inferenceRouteContext: {
          provider: "ollama-local",
          gatewayName: "other-gateway",
          nativeLocalExpected: true,
          nativeLocalProviderAttachment: localAttachment,
        },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
    expect(result.diagnostics.find((entry) => entry.link === "inference")?.detail).toContain(
      "attachment is missing or invalid",
    );
    expect(probeInferenceInvocation).not.toHaveBeenCalled();
  });

  it.each([DCODE_AGENT])(
    "accepts a managed local provider's canonical application route for %s",
    async (agentName) => {
      const binding = {
        ...localBinding,
        provider: "llama-cpp-local" as const,
        endpointUrl: "http://host.openshell.internal:8081/v1",
        authMode: "authenticated" as const,
      };
      const attachment = {
        ...binding,
        ...nativeLocalIdentity(binding),
        schemaVersion: 1 as const,
        providerId: "provider-1",
      };
      const context = onboardInferenceVerificationContext(
        "my-sandbox",
        "my-gateway",
        agentName,
        {
          provider: "llama-cpp-local",
          model: "test-model",
          endpointUrl: "https://inference.local/v1",
          preferredInferenceApi: "openai-completions",
        },
        { nativeLocalProviderAttachment: attachment },
      );
      const routeProbe = vi.fn(async () => ({ ok: true }) as const);
      const deployment = await verifyDeployment(
        "my-sandbox",
        buildChain(),
        makeDeps({ probeInferenceInvocation: routeProbe }),
        { ...NO_RETRY, inferenceRouteContext: context.route },
      );
      expect(deployment.verification.inferenceRouteWorking).toBe(true);
      expect(routeProbe).toHaveBeenCalledOnce();

      const invocationProbe = vi.fn(async () => ({ ok: true }) as const);
      expect(await probeOnboardInferenceInvocation(context.invocation, invocationProbe)).toEqual({
        ok: true,
      });
      expect(invocationProbe).toHaveBeenCalledOnce();
    },
  );

  it("rejects a native local attachment for a different selected endpoint in both probes", async () => {
    const context = onboardInferenceVerificationContext(
      "my-sandbox",
      "my-gateway",
      DCODE_AGENT,
      {
        provider: "ollama-local",
        model: "test-model",
        endpointUrl: "http://host.openshell.internal:11435/v1",
        preferredInferenceApi: "openai-completions",
      },
      { nativeLocalProviderAttachment: localAttachment },
    );
    const routeProbe = vi.fn(async () => ({ ok: true }) as const);
    const deployment = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeDeps({ probeInferenceInvocation: routeProbe }),
      { ...NO_RETRY, inferenceRouteContext: context.route },
    );
    expect(deployment.verification.inferenceRouteWorking).toBe(false);
    expect(routeProbe).not.toHaveBeenCalled();

    const invocationProbe = vi.fn(async () => ({ ok: true }) as const);
    expect(
      await probeOnboardInferenceInvocation(context.invocation, invocationProbe),
    ).toMatchObject({
      ok: false,
    });
    expect(invocationProbe).not.toHaveBeenCalled();
  });

  it("accepts a normalized spelling of the selected native local endpoint", async () => {
    const context = onboardInferenceVerificationContext(
      "my-sandbox",
      "my-gateway",
      DCODE_AGENT,
      {
        provider: "ollama-local",
        model: "test-model",
        endpointUrl: `${localBinding.endpointUrl}/`,
        preferredInferenceApi: "openai-completions",
      },
      { nativeLocalProviderAttachment: localAttachment },
    );
    const probe = vi.fn(async () => ({ ok: true }) as const);
    expect(await probeOnboardInferenceInvocation(context.invocation, probe)).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledOnce();
    const routeProbe = vi.fn(async () => ({ ok: true }) as const);
    const deployment = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeDeps({ probeInferenceInvocation: routeProbe }),
      { ...NO_RETRY, inferenceRouteContext: context.route },
    );
    expect(deployment.verification.inferenceRouteWorking).toBe(true);
    expect(routeProbe).toHaveBeenCalledOnce();
  });

  it("uses the native NVIDIA invocation instead of probing inference.local", async () => {
    const scripts: string[] = [];
    const probeInferenceInvocation = vi.fn(async () => ({ ok: true }) as const);
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("000", {
        executeSandboxCommand: async (_name: string, script: string) => {
          scripts.push(script);
          return { status: 0, stdout: "200", stderr: "" };
        },
        probeInferenceInvocation,
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { provider: "nvidia-prod" },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(true);
    expect(probeInferenceInvocation).toHaveBeenCalledOnce();
    expect(scripts.join("\n")).not.toContain("inference.local");
  });

  it("fails the deployment when the models route returns HTTP 404 (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(false);
    expect(result.healthy).toBe(false);
  });

  it("names the unvalidated model catalog as the reason for a 404 (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { provider: "openrouter-api" },
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
      inferenceRouteContext: { provider: "openrouter-api" },
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
        executeSandboxCommand: async (_name: string, script: string) =>
          script.includes("inference.local")
            ? {
                status: 1,
                stdout: "200",
                stderr: "curl: (6) could not resolve host",
              }
            : { status: 0, stdout: "200", stderr: "" },
      }),
      NO_RETRY,
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("accepts the OpenRouter adapter 404 without an agent allowlist when inference succeeds (#12621)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404", {
        probeInferenceInvocation: async () => ({ ok: true }),
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { provider: "openrouter-api" },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(true);
    expect(result.healthy).toBe(true);
  });

  it("fails the OpenRouter adapter 404 when the inference request fails (#12621)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404", {
        probeInferenceInvocation: async () => ({
          ok: false,
          detail: "HTTP 401",
        }),
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { provider: "openrouter-api" },
      },
    );

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("fails the OpenRouter adapter 404 when no invocation probe is wired (#12621)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { provider: "openrouter-api" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("points a failed by-design 404 at the inference request, not the model catalog (#10543)", async () => {
    const result = await verifyDeployment(
      "my-sandbox",
      buildChain(),
      makeModelsRouteDeps("404", {
        probeInferenceInvocation: async () => ({
          ok: false,
          detail: "HTTP 401",
        }),
      }),
      {
        ...NO_RETRY,
        inferenceRouteContext: { provider: "openrouter-api" },
      },
    );

    const inference = result.diagnostics.find((entry) => entry.link === "inference");
    expect(inference?.hint).toContain("serves no model catalog");
    expect(inference?.hint).not.toContain("endpoint serves");
  });

  it("tells a plain 404 to make the model catalog available (#10543)", async () => {
    const result = await verifyDeployment("my-sandbox", buildChain(), makeModelsRouteDeps("404"), {
      ...NO_RETRY,
      inferenceRouteContext: { provider: "compatible-endpoint" },
    });

    const inference = result.diagnostics.find((entry) => entry.link === "inference");
    expect(inference?.hint).toContain("served no model catalog");
    expect(inference?.hint).toContain("/v1/models");
  });

  it("gives a plain 404 the startup budget before failing it closed (#10543)", async () => {
    let modelsRouteCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: async (_name: string, script: string) => {
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
      inferenceRouteContext: { provider: "compatible-endpoint" },
    });

    expect(modelsRouteCalls).toBe(4);
    expect(result.verification.inferenceRouteWorking).toBe(false);
  });

  it("recovers when the model catalog registers after a late 404 (#6849)", async () => {
    const responses = ["404", "404", "200"];
    let modelsRouteCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: async (_name: string, script: string) => {
        const isModelsRoute = script.includes("inference.local");
        modelsRouteCalls += isModelsRoute ? 1 : 0;
        return isModelsRoute
          ? {
              status: 0,
              stdout: responses[modelsRouteCalls - 1] ?? "200",
              stderr: "",
            }
          : { status: 0, stdout: "200", stderr: "" };
      },
    });

    const result = await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { provider: "compatible-endpoint" },
    });

    expect(result.verification.inferenceRouteWorking).toBe(true);
  });

  it("spends no models-route retry budget on an expected OpenRouter 404 (#12621)", async () => {
    let modelsRouteCalls = 0;
    const deps = makeDeps({
      executeSandboxCommand: async (_name: string, script: string) => {
        const isModelsRoute = script.includes("inference.local");
        modelsRouteCalls += isModelsRoute ? 1 : 0;
        return isModelsRoute
          ? { status: 0, stdout: "404", stderr: "" }
          : { status: 0, stdout: "200", stderr: "" };
      },
      probeInferenceInvocation: async () => ({ ok: true }),
    });

    await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { provider: "openrouter-api" },
    });

    expect(modelsRouteCalls).toBe(1);
  });

  it("runs the invocation probe once for an expected OpenRouter 404 (#12621)", async () => {
    let invocationCalls = 0;
    const deps = makeModelsRouteDeps("404", {
      probeInferenceInvocation: async () => {
        invocationCalls += 1;
        return { ok: false, detail: "HTTP 500" };
      },
    });

    await verifyDeployment("my-sandbox", buildChain(), deps, {
      retryDelaysMs: [1, 1, 1],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { provider: "openrouter-api" },
    });

    expect(invocationCalls).toBe(1);
  });

  it("fails closed when no provider and model were recorded for the sandbox (#10543)", async () => {
    const result = await probeOnboardInferenceInvocation({
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

  it("passes the native local receipt to the bounded agent request", async () => {
    const probe = vi.fn(async () => ({ ok: true }) as const);
    const result = await probeOnboardInferenceInvocation(
      {
        sandboxName: "my-sandbox",
        gatewayName: "my-gateway",
        agentName: DCODE_AGENT,
        model: "test-model",
        provider: "ollama-local",
        preferredInferenceApi: "openai-completions",
        nativeLocalExpected: true,
        nativeLocalProviderAttachment: localAttachment,
      },
      probe,
    );

    expect(result).toEqual({ ok: true });
    expect(probe).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        gatewayName: "my-gateway",
        provider: "ollama-local",
        model: "test-model",
        nativeLocalProviderAttachment: localAttachment,
      }),
    );
  });

  it("does not request inference without the selected native local receipt", async () => {
    const probe = vi.fn(async () => ({ ok: true }) as const);
    const result = await probeOnboardInferenceInvocation(
      {
        sandboxName: "my-sandbox",
        gatewayName: "my-gateway",
        agentName: DCODE_AGENT,
        model: "test-model",
        provider: "ollama-local",
        preferredInferenceApi: "openai-completions",
        nativeLocalExpected: true,
      },
      probe,
    );

    expect(result).toMatchObject({ ok: false });
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed when a model was recorded without its provider (#10543)", async () => {
    const result = await probeOnboardInferenceInvocation({
      sandboxName: "my-sandbox",
      gatewayName: "my-gateway",
      agentName: DCODE_AGENT,
      model: "openai/gpt-4o-mini",
      provider: null,
      preferredInferenceApi: null,
    });

    expect(result).toEqual({
      ok: false,
      detail: "no provider and model were recorded for this sandbox",
    });
  });
});
