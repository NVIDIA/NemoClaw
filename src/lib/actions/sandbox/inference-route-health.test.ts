// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenShellSandboxBufferedCommandExecutor } from "../../adapters/openshell/sandbox-command";
import {
  DCODE_MANAGED_EXEC_LAUNCHER,
  DCODE_MANAGED_EXEC_MISSING_DETAIL,
} from "./connect-inference-route-probe";
import {
  buildSandboxInferenceRouteHealth,
  isTransientInferenceInvocationFailure,
  probeSandboxInferenceGatewayHealth,
  probeSandboxNativeNvidiaModelsHealth,
  runSandboxInferenceInvocationProbe,
  type SandboxInferenceRouteHealth,
} from "./inference-route-health";

describe("sandbox inference route health", () => {
  const makeExecutor = (stdout: string, status = 0): OpenShellSandboxBufferedCommandExecutor => ({
    runBuffered: vi.fn(async () => ({
      outcome: { kind: "completed" as const, exitCode: status },
      stdout,
      stderr: "",
    })),
  });

  it.each([200, 401, 403])(
    "reports a reachable route for final HTTP responses [case %#]",
    async (httpStatus) => {
      const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
        commandExecutor: makeExecutor(`OK ${httpStatus}`),
      });

      expect(result).toMatchObject({
        ok: true,
        httpStatus,
        endpoint: "https://inference.local/v1/models",
      });
      expect(result?.detail).toContain("full chain reachable");
    },
  );

  it("reports HTTP 5xx as an unhealthy authoritative route (#6192)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      commandExecutor: makeExecutor("BROKEN 503"),
    });

    expect(result).toMatchObject({ ok: false, httpStatus: 503 });
    expect(result?.detail).toContain("reachable but unhealthy");
  });

  it("reports transport status 000 as unreachable", async () => {
    const result = await probeSandboxInferenceGatewayHealth("my-sandbox", {
      commandExecutor: makeExecutor("BROKEN 000"),
    });

    expect(result).toMatchObject({ ok: false, httpStatus: 0 });
    expect(result?.detail).toContain("unreachable");
  });

  it("returns null when the authoritative probe is unavailable (#6192)", async () => {
    await expect(
      probeSandboxInferenceGatewayHealth("my-sandbox", {
        commandExecutor: makeExecutor("transport unavailable", 1),
      }),
    ).resolves.toBeNull();
    await expect(
      probeSandboxInferenceGatewayHealth("my-sandbox", {
        commandExecutor: {
          runBuffered: async () => {
            throw new Error("openshell unavailable");
          },
        },
      }),
    ).resolves.toBeNull();
  });

  it("uses the DCode agent path while reporting observable route health (#6192)", async () => {
    const commandExecutor = makeExecutor("OK 200");
    const getSessionAgentImpl = vi.fn(() => ({ name: "langchain-deepagents-code" }) as never);

    const result = await probeSandboxInferenceGatewayHealth("deep-code", {
      commandExecutor,
      gatewayName: "recorded-gateway",
      getSessionAgentImpl,
    });

    expect(result).toMatchObject({ ok: true, httpStatus: 200 });
    expect(getSessionAgentImpl).toHaveBeenCalledWith("deep-code");
    expect(commandExecutor.runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "deep-code",
        target: { kind: "named", gatewayName: "recorded-gateway" },
        tty: false,
        sandboxEnvironment: { HOME: "/usr/local/lib/nemoclaw", BASH_ENV: "", ENV: "" },
        command: [
          "/usr/local/lib/nemoclaw/dcode-managed-exec",
          "/bin/sh",
          "-c",
          expect.stringContaining("/usr/bin/curl -q"),
        ],
      }),
    );
  });

  it("reports missing DCode helper as a failed compatibility boundary (#6192)", async () => {
    const result = await probeSandboxInferenceGatewayHealth("deep-code", {
      commandExecutor: makeExecutor(`exec: ${DCODE_MANAGED_EXEC_LAUNCHER}: not found`, 127),
      getSessionAgentImpl: () => ({ name: "langchain-deepagents-code" }) as never,
    });

    expect(result).toMatchObject({
      ok: false,
      httpStatus: 0,
      endpoint: "https://inference.local/v1/models",
      detail: DCODE_MANAGED_EXEC_MISSING_DETAIL,
    });
  });

  it("probes native NVIDIA models through the attached provider placeholder", async () => {
    const commandExecutor = makeExecutor("OK 200");

    const result = await probeSandboxNativeNvidiaModelsHealth("alpha", {
      gatewayName: "nemoclaw-19080",
      agentName: "openclaw",
      commandExecutor,
    });

    expect(result).toMatchObject({
      ok: true,
      httpStatus: 200,
      endpoint: "https://integrate.api.nvidia.com/v1/models",
    });
    expect(commandExecutor.runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        target: { kind: "named", gatewayName: "nemoclaw-19080" },
        command: ["sh", "-c", expect.stringContaining("NVIDIA_INFERENCE_API_KEY")],
      }),
    );
  });
});

describe("buildSandboxInferenceRouteHealth (#10080)", () => {
  const gateway = (httpStatus: number, ok = true): SandboxInferenceRouteHealth => ({
    ok,
    endpoint: "https://inference.local/v1/models",
    httpStatus,
    detail: `probe returned ${httpStatus}`,
  });

  it("uses the native NVIDIA invocation instead of the legacy gateway route", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(503, false),
      null,
      { ok: true },
      { provider: "nvidia-prod", nativeNvidia: true },
    );

    expect(result).toMatchObject({
      ok: true,
      probed: true,
      endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    });
    expect(result.subprobes).toBeUndefined();
  });

  it("does not let a healthy legacy gateway mask a failed native NVIDIA request", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(200),
      null,
      {
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 401",
        httpStatus: 401,
        endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
      },
      { provider: "nvidia-prod", nativeNvidia: true },
    );

    expect(result).toMatchObject({
      ok: false,
      probed: true,
      failureLabel: "unauthorized",
      endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
    });
    expect(result.subprobes).toBeUndefined();
  });

  it.each([
    ["openai-completions", "https://inference.local/v1/chat/completions"],
    ["openai-responses", "https://inference.local/v1/responses"],
    ["anthropic-messages", "https://inference.local/v1/messages"],
  ])("names the %s endpoint when the probe itself throws (#10879)", async (api, endpoint) => {
    const invocation = await runSandboxInferenceInvocationProbe(
      {
        sandboxName: "alpha",
        provider: "compatible-endpoint",
        model: "nvidia/nemotron",
        preferredInferenceApi: api,
      },
      () => {
        throw new Error("openshell exec exploded");
      },
    );

    expect(invocation).toMatchObject({ ok: false, httpStatus: null, endpoint });
    expect(
      buildSandboxInferenceRouteHealth(gateway(200), null, invocation, {
        provider: "compatible-endpoint",
      }).endpoint,
    ).toBe(endpoint);
  });

  it("names the request that failed, not the models route (#10879)", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(200),
      null,
      {
        ok: false,
        detail: "sandbox inference invocation probe returned HTTP 404",
        httpStatus: 404,
        endpoint: "https://inference.local/v1/chat/completions",
      },
      { provider: "nvidia-prod" },
    );

    expect(result.ok).toBe(false);
    expect(result.endpoint).toBe("https://inference.local/v1/chat/completions");
    expect(result.subprobes?.[0]).toMatchObject({
      probeLabel: "route reachability",
      endpoint: "https://inference.local/v1/models",
    });
  });

  it("falls back to the models route when the invocation reports no endpoint", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(200),
      null,
      { ok: false, detail: "probe was unavailable", httpStatus: null },
      { provider: "nvidia-prod" },
    );

    expect(result.endpoint).toBe("https://inference.local/v1/models");
  });

  it.each([404, 401, 403])(
    "carries the models route status into the reachability hop for HTTP %s (#10879)",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        {
          ok: false,
          detail: "sandbox inference invocation probe returned HTTP 404",
          httpStatus: 404,
          endpoint: "https://inference.local/v1/chat/completions",
        },
        { provider: "nvidia-prod" },
      );

      expect(result.subprobes?.[0]).toMatchObject({
        probeLabel: "route reachability",
        ok: true,
        okLabel: `reachable (HTTP ${httpStatus})`,
      });
    },
  );

  it("keeps the plain reachable label for a 2xx models route (#6846)", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(200),
      null,
      { ok: true },
      { provider: "nvidia-prod" },
    );

    expect(result.subprobes?.[0]).toMatchObject({ ok: true, okLabel: "reachable" });
  });

  it("accepts the OpenRouter adapter 404 when the invocation succeeds (#12621)", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      {
        provider: "openrouter-api",
      },
    );

    expect(result.ok).toBe(true);
  });

  it("fails closed for the OpenRouter adapter 404 when no invocation was attempted (#12621)", () => {
    const result = buildSandboxInferenceRouteHealth(gateway(404), null, null, {
      provider: "openrouter-api",
    });

    expect(result.ok).toBe(false);
    expect(result.okLabel).toBeUndefined();
    expect(result.detail).toContain("no inference request confirmed the selected model");
  });

  it("fails closed for the OpenRouter adapter 404 when the invocation fails", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: false, detail: "provider rejected the request", httpStatus: 401 },
      { provider: "openrouter-api" },
    );

    expect(result.ok).toBe(false);
  });

  it("normalizes the provider before matching the OpenRouter adapter 404", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      { provider: " openrouter-api " },
    );

    expect(result.ok).toBe(true);
  });

  it("does not extend the adapter 404 tolerance to a different provider", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(404),
      null,
      { ok: true },
      { provider: "nvidia-nim" },
    );

    expect(result.ok).toBe(false);
    expect(result.detail).toContain("provider does not have a supported catalog-less route");
  });

  it.each([401, 403])(
    "keeps a credential-gated HTTP %s route healthy when the invocation succeeds (#6192)",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        { ok: true },
        { provider: "openrouter-api" },
      );

      expect(result.ok).toBe(true);
    },
  );

  it.each([401, 403])(
    "fails a credential-gated HTTP %s route when the invocation fails (#6192)",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        { ok: false, detail: "provider rejected the request", httpStatus },
        { provider: "openrouter-api" },
      );

      expect(result.ok).toBe(false);
    },
  );

  it.each([302, 400, 405, 410, 429])(
    "fails closed for HTTP %s when an inference request succeeds",
    (httpStatus) => {
      const result = buildSandboxInferenceRouteHealth(
        gateway(httpStatus),
        null,
        { ok: true },
        { provider: "openrouter-api" },
      );

      expect(result.ok).toBe(false);
      expect(result.failureLabel).toBe("unreachable");
    },
  );

  it("leaves a strictly healthy 2xx route unaffected for any agent", () => {
    const result = buildSandboxInferenceRouteHealth(
      gateway(200),
      null,
      { ok: true },
      { provider: "openrouter-api" },
    );

    expect(result.ok).toBe(true);
  });
});

describe("transient inference invocation failures", () => {
  it.each([429, 502, 503, 504])(
    "treats HTTP %i as a transient inference request failure (#10709)",
    (httpStatus) => {
      expect(
        isTransientInferenceInvocationFailure({
          ok: false,
          detail: `sandbox inference invocation probe returned HTTP ${httpStatus}`,
          httpStatus,
        }),
      ).toBe(true);
    },
  );

  it.each([400, 401, 403, 404, 405, 500, 501])(
    "treats HTTP %i as a settled inference request failure (#10709)",
    (httpStatus) => {
      expect(
        isTransientInferenceInvocationFailure({
          ok: false,
          detail: `sandbox inference invocation probe returned HTTP ${httpStatus}`,
          httpStatus,
        }),
      ).toBe(false);
    },
  );

  it("treats a served request as no failure at all (#10709)", () => {
    expect(isTransientInferenceInvocationFailure({ ok: true })).toBe(false);
  });

  it("treats an invalid 2xx response body as a settled failure (#10709)", () => {
    expect(
      isTransientInferenceInvocationFailure({
        ok: false,
        detail: "sandbox inference invocation probe returned an invalid response body",
        httpStatus: 200,
      }),
    ).toBe(false);
  });

  it("treats a request that reached no HTTP status as a settled failure (#10709)", () => {
    expect(
      isTransientInferenceInvocationFailure({
        ok: false,
        detail: "sandbox inference invocation probe was unavailable",
        httpStatus: null,
      }),
    ).toBe(false);
  });

  it("reports no failure when no inference request was sent (#10709)", () => {
    expect(isTransientInferenceInvocationFailure(null)).toBe(false);
  });
});

it("offers conditional recreation guidance when the legacy route cannot be reached", () => {
  const health = buildSandboxInferenceRouteHealth(
    {
      ok: false,
      endpoint: "https://inference.local/v1/models",
      httpStatus: 0,
      detail: "Inference gateway is unreachable.",
    },
    null,
    null,
    { provider: "compatible-endpoint", model: "selected" },
  );
  expect(health.ok).toBe(false);
  expect(health.detail).toContain("If this legacy route is no longer available");
});

vi.mock("../../inference/native-local/profile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../inference/native-local/profile")>()),
  verifyRecordedNativeLocalProviderAttachment: vi.fn(async () => undefined),
}));
vi.mock("../../adapters/openshell/provider-adapter-cli", () => ({
  createCliOpenShellProviderAdapter: vi.fn(() => ({})),
}));
vi.mock("../../state/registry/cross-port", () => ({ findSandboxAcrossGatewayRoots: vi.fn() }));
vi.mock("../../onboard/sandbox-recreate-probe", () => ({ observeSandboxOnGateway: vi.fn() }));

const { nativeLocalIdentity } = await import("../../inference/native-local/contract");
const { verifyRecordedNativeLocalProviderAttachment } =
  await import("../../inference/native-local/profile");
const { findSandboxAcrossGatewayRoots } = await import("../../state/registry/cross-port");
const { observeSandboxOnGateway } = await import("../../onboard/sandbox-recreate-probe");
const { observeBlueprintNativeInference } = await import("../../blueprint-runner");
const localBinding = {
  provider: "compatible-endpoint",
  agent: "openclaw" as const,
  endpointUrl: "http://host.openshell.internal:8000/v1",
  credentialEnv: "NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  authMode: "authenticated" as const,
  gatewayName: "nemoclaw",
  sandboxName: "alpha",
};
const nativeEntry = {
  name: "alpha",
  agent: "openclaw" as const,
  gatewayName: "nemoclaw",
  provider: "compatible-endpoint",
  model: "test-model",
  preferredInferenceApi: "openai-completions",
  endpointUrl: "http://localhost:8000/v1",
  credentialEnv: "COMPATIBLE_API_KEY",
  lifecycleGeneration: "generation-one",
  lifecycleLiveIdentityFingerprint: "identity-one",
  nativeLocalProviderAttachment: {
    ...localBinding,
    ...nativeLocalIdentity(localBinding),
    schemaVersion: 1 as const,
    providerId: "provider-id",
  },
};
const nativeRequest = {
  gatewayName: "nemoclaw",
  sandboxName: "alpha",
  provider: "compatible-endpoint",
  model: "test-model",
  api: "openai-completions",
};

describe("blueprint native inference authority", () => {
  beforeEach(() => {
    vi.mocked(verifyRecordedNativeLocalProviderAttachment)
      .mockReset()
      .mockResolvedValue(nativeEntry.nativeLocalProviderAttachment);
    vi.mocked(findSandboxAcrossGatewayRoots)
      .mockReset()
      .mockReturnValue({
        entry: nativeEntry,
        registryFile: "/test-state/sandboxes.json",
        gatewayPort: 8080,
      } as ReturnType<typeof findSandboxAcrossGatewayRoots>);
    vi.mocked(observeSandboxOnGateway)
      .mockReset()
      .mockReturnValue({ state: "ready", liveIdentityFingerprint: "identity-one" });
  });

  it.each([
    "http://localhost:8000/v1",
    "http://127.0.0.1:8000/v1/",
    "http://[::1]:8000/v1",
    "http://host.openshell.internal:8000/v1",
  ])("verifies the recorded native attachment for selected URL %s", async (endpointUrl) => {
    vi.mocked(findSandboxAcrossGatewayRoots).mockReturnValue({
      entry: { ...nativeEntry, endpointUrl },
      registryFile: "/test-state/sandboxes.json",
      gatewayPort: 8080,
    } as ReturnType<typeof findSandboxAcrossGatewayRoots>);
    const identity = await observeBlueprintNativeInference(nativeRequest);
    expect(JSON.parse(identity)).toMatchObject({
      provider: "compatible-endpoint",
      model: "test-model",
      attachment: { providerId: "provider-id" },
    });
    expect(verifyRecordedNativeLocalProviderAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        expected: nativeEntry.nativeLocalProviderAttachment,
        agent: "openclaw",
        provider: "compatible-endpoint",
      }),
    );
    expect(observeSandboxOnGateway).toHaveBeenCalledWith(
      { sandboxName: "alpha", gatewayName: "nemoclaw" },
      undefined,
      undefined,
      15_000,
    );
  });

  it.each([
    { gatewayName: "other" },
    { provider: "other" },
    { model: "other" },
    { api: "openai-responses" },
    { endpointUrl: "http://host.openshell.internal:9000/v1" },
  ])("refuses a changed requested selection %j before attachment lookup", async (change) => {
    await expect(observeBlueprintNativeInference({ ...nativeRequest, ...change })).rejects.toThrow(
      /matching registered native inference/,
    );
    expect(verifyRecordedNativeLocalProviderAttachment).not.toHaveBeenCalled();
  });

  it.each([
    { nativeLocalProviderAttachment: undefined },
    {
      nativeLocalProviderAttachment: {
        ...nativeEntry.nativeLocalProviderAttachment,
        providerName: "forged",
      },
    },
    { nativeHostedProviderAttachment: {} },
    { agent: "hermes" },
    { endpointUrl: "http://host.openshell.internal:9000/v1" },
    {
      nativeLocalProviderAttachment: {
        ...nativeEntry.nativeLocalProviderAttachment,
        credentialEnv: "OTHER_KEY",
        ...nativeLocalIdentity({ ...localBinding, credentialEnv: "OTHER_KEY" }),
      },
    },
    {
      nativeLocalProviderAttachment: {
        ...nativeEntry.nativeLocalProviderAttachment,
        api: "openai-responses",
        ...nativeLocalIdentity({ ...localBinding, api: "openai-responses" }),
      },
    },
  ])("refuses invalid recorded native authority %j", async (change) => {
    vi.mocked(findSandboxAcrossGatewayRoots).mockReturnValue({
      entry: { ...nativeEntry, ...change },
      registryFile: "/test-state/sandboxes.json",
      gatewayPort: 8080,
    } as ReturnType<typeof findSandboxAcrossGatewayRoots>);
    await expect(observeBlueprintNativeInference(nativeRequest)).rejects.toThrow(
      /matching registered native inference/,
    );
    expect(verifyRecordedNativeLocalProviderAttachment).not.toHaveBeenCalled();
  });

  it("propagates actual provider identity and profile refusal", async () => {
    vi.mocked(verifyRecordedNativeLocalProviderAttachment).mockRejectedValue(
      new Error("provider profile or identity changed"),
    );
    await expect(observeBlueprintNativeInference(nativeRequest)).rejects.toThrow(
      /profile or identity changed/,
    );
  });

  it("refuses missing recorded lifecycle authority", async () => {
    vi.mocked(findSandboxAcrossGatewayRoots).mockReturnValue(null);
    await expect(observeBlueprintNativeInference(nativeRequest)).rejects.toThrow(
      /recorded sandbox lifecycle authority/,
    );
  });

  it("refuses replacement live sandbox identity", async () => {
    vi.mocked(observeSandboxOnGateway).mockReturnValue({
      state: "ready",
      liveIdentityFingerprint: "replacement",
    });
    await expect(observeBlueprintNativeInference(nativeRequest)).rejects.toThrow(
      /live identity.*changed/,
    );
    expect(verifyRecordedNativeLocalProviderAttachment).not.toHaveBeenCalled();
  });

  it.each([{ model: "replacement" }, { credentialEnv: "OTHER_KEY" }])(
    "refuses selection changes during provider verification %j",
    async (change) => {
      vi.mocked(verifyRecordedNativeLocalProviderAttachment).mockImplementation(async () => {
        vi.mocked(findSandboxAcrossGatewayRoots).mockReturnValue({
          entry: { ...nativeEntry, ...change },
          registryFile: "/test-state/sandboxes.json",
          gatewayPort: 8080,
        } as ReturnType<typeof findSandboxAcrossGatewayRoots>);
        return nativeEntry.nativeLocalProviderAttachment;
      });
      await expect(observeBlueprintNativeInference(nativeRequest)).rejects.toThrow(
        /matching registered native inference|selection changed/,
      );
    },
  );
});
