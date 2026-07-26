// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { noAuthProxy } from "../../inference/ollama/proxy";
import { setupRemoteProviderInference } from "./remote";
import type { RemoteProviderDeps } from "./types";

vi.mock("../../inference/ollama/proxy", () => ({ noAuthProxy: vi.fn() }));

const PROVIDER = "compatible-anthropic-endpoint";
const MODEL = "custom-model";
const ENDPOINT = "https://inference.example";
const OPENAI_SURFACE = `${ENDPOINT}/v1`;
const CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const SANDBOX = "target-box";
const NO_AUTH_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
const SUCCESS = { status: 0, stdout: "", stderr: "" };

function makeArgs(sandboxName: string | null) {
  return {
    sandboxName,
    model: MODEL,
    provider: PROVIDER,
    endpointUrl: ENDPOINT,
    credentialEnv: CREDENTIAL_ENV,
    preferredInferenceApi: "openai-completions",
    pinnedAddresses: ["93.184.216.34"],
  };
}

function createHarness() {
  const runOpenshell = vi.fn(() => SUCCESS);
  const upsertProvider = vi.fn(() => ({ ok: true }));
  const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
  const readGatewayProviderMetadata = vi.fn(() => ({
    name: PROVIDER,
    type: "anthropic",
    credentialKeys: [CREDENTIAL_ENV],
    configKeys: ["ANTHROPIC_BASE_URL"],
  }));
  const deleteGatewayProvider = vi.fn(() => ({ ok: true }));
  const exitProcess = vi.fn((code: number): never => {
    throw new Error(`EXIT_CALLED:${code}`);
  });
  const error = vi.fn();
  const deps = {
    runOpenshell,
    upsertProvider,
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: vi.fn(() => true),
    registry: { updateSandbox: vi.fn() },
    exitProcess,
    error,
    log: vi.fn(),
    REMOTE_PROVIDER_CONFIG: {
      anthropicCompatible: {
        label: "Other Anthropic-compatible endpoint",
        providerName: PROVIDER,
        providerType: "anthropic",
        credentialEnv: CREDENTIAL_ENV,
        endpointUrl: ENDPOINT,
        helpUrl: null,
        modelMode: "input",
        defaultModel: MODEL,
      },
      custom: {
        label: "Other OpenAI-compatible endpoint",
        providerName: "compatible-endpoint",
        providerType: "openai",
        credentialEnv: "COMPATIBLE_API_KEY",
        endpointUrl: "http://localhost:8000/v1",
        helpUrl: null,
        modelMode: "input",
        defaultModel: MODEL,
      },
    },
    hydrateCredentialEnv: vi.fn(() => "test-secret"),
    promptValidationRecovery: vi.fn(async () => "selection" as const),
    classifyApplyFailure: vi.fn(() => "unknown"),
    LOCAL_INFERENCE_TIMEOUT_SECS: 60,
    bedrockRuntimeOnboard: {
      setupBedrockRuntimeInference: vi.fn(async () => ({ handled: false as const })),
    },
    openrouterRuntimeOnboard: {
      setupOpenRouterRuntimeInference: vi.fn(async () => ({ handled: false as const })),
    },
    redact: vi.fn((value: string) => value),
    compactText: vi.fn((value: string) => value.trim()),
    probeOpenAiLikeEndpoint,
    readGatewayProviderMetadata,
    deleteGatewayProvider,
  } satisfies RemoteProviderDeps;

  return {
    deps,
    runOpenshell,
    upsertProvider,
    probeOpenAiLikeEndpoint,
    readGatewayProviderMetadata,
    deleteGatewayProvider,
    exitProcess,
    error,
  };
}

afterEach(() => {
  vi.mocked(noAuthProxy).mockReset();
  delete process.env[NO_AUTH_ENV];
});

describe("custom Anthropic provider replacement on the OpenAI surface", () => {
  it("probes chat completions before replacing a stale Anthropic provider as OpenAI (#6294)", async () => {
    const harness = createHarness();

    await expect(setupRemoteProviderInference(makeArgs(SANDBOX), harness.deps)).resolves.toEqual({
      done: false,
    });

    expect(harness.probeOpenAiLikeEndpoint).toHaveBeenCalledWith(
      OPENAI_SURFACE,
      MODEL,
      "test-secret",
      { skipResponsesProbe: true, pinnedAddresses: ["93.184.216.34"] },
    );
    expect(harness.readGatewayProviderMetadata).toHaveBeenCalledWith(
      PROVIDER,
      harness.runOpenshell,
    );
    expect(harness.runOpenshell).toHaveBeenNthCalledWith(1, ["provider", "delete", PROVIDER], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(harness.probeOpenAiLikeEndpoint.mock.invocationCallOrder[0]).toBeLessThan(
      harness.runOpenshell.mock.invocationCallOrder[0],
    );
    expect(harness.upsertProvider).toHaveBeenCalledWith(
      PROVIDER,
      "openai",
      CREDENTIAL_ENV,
      OPENAI_SURFACE,
      { [CREDENTIAL_ENV]: "test-secret" },
    );
    expect(harness.probeOpenAiLikeEndpoint.mock.invocationCallOrder[0]).toBeLessThan(
      harness.upsertProvider.mock.invocationCallOrder[0],
    );
  });

  it("authorizes detach recovery only for the current sandbox (#6294)", async () => {
    const harness = createHarness();
    harness.runOpenshell.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `provider '${PROVIDER}' is attached to sandbox(es): ${SANDBOX}`,
    });

    await expect(setupRemoteProviderInference(makeArgs(SANDBOX), harness.deps)).resolves.toEqual({
      done: false,
    });

    expect(harness.deleteGatewayProvider).toHaveBeenCalledWith(PROVIDER, {
      runOpenshell: harness.runOpenshell,
      allowedSandboxes: [SANDBOX],
    });
    expect(harness.upsertProvider).toHaveBeenCalledWith(
      PROVIDER,
      "openai",
      CREDENTIAL_ENV,
      OPENAI_SURFACE,
      { [CREDENTIAL_ENV]: "test-secret" },
    );
    expect(harness.deleteGatewayProvider.mock.invocationCallOrder[0]).toBeLessThan(
      harness.upsertProvider.mock.invocationCallOrder[0],
    );
  });

  it("fails closed when a foreign sandbox is attached (#6294)", async () => {
    const harness = createHarness();
    harness.runOpenshell.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `provider '${PROVIDER}' is attached to sandbox(es): ${SANDBOX}, foreign-box`,
    });

    await expect(setupRemoteProviderInference(makeArgs(SANDBOX), harness.deps)).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(harness.exitProcess).toHaveBeenCalledWith(1);
    expect(harness.error).toHaveBeenCalledWith(
      expect.stringContaining("attached to other sandbox(es) (foreign-box)"),
    );
    expect(harness.deleteGatewayProvider).not.toHaveBeenCalled();
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });

  it("refuses detach recovery without a confirmed sandbox (#6294)", async () => {
    const harness = createHarness();
    harness.runOpenshell.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `provider '${PROVIDER}' is attached to sandbox(es): ${SANDBOX}`,
    });

    await expect(setupRemoteProviderInference(makeArgs(null), harness.deps)).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(harness.exitProcess).toHaveBeenCalledWith(1);
    expect(harness.error).toHaveBeenCalledWith(
      expect.stringContaining("no target sandbox was confirmed"),
    );
    expect(harness.deleteGatewayProvider).not.toHaveBeenCalled();
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });
});

describe("OpenAI-compatible no-auth provider registration", () => {
  const args = {
    sandboxName: SANDBOX,
    model: MODEL,
    provider: "compatible-endpoint",
    endpointUrl: "http://localhost:8000/v1",
    credentialEnv: NO_AUTH_ENV,
    preferredInferenceApi: "openai-completions",
    pinnedAddresses: ["127.0.0.1"],
  };

  it("registers the protected proxy URL and generated credential (#7424)", async () => {
    const harness = createHarness();
    const persist = vi.fn();
    const restore = vi.fn();
    vi.mocked(noAuthProxy).mockReturnValue({
      baseUrl: "http://host.openshell.internal:11435/v1",
      credentialValue: "proxy-token",
      persist,
      restore,
    });
    harness.deps.hydrateCredentialEnv.mockImplementation(
      () => process.env[NO_AUTH_ENV] || "missing",
    );

    await expect(setupRemoteProviderInference(args, harness.deps)).resolves.toEqual({
      done: false,
    });

    expect(noAuthProxy).toHaveBeenCalledWith("http://localhost:8000/v1");
    expect(harness.upsertProvider).toHaveBeenCalledWith(
      "compatible-endpoint",
      "openai",
      NO_AUTH_ENV,
      "http://host.openshell.internal:11435/v1",
      { [NO_AUTH_ENV]: "proxy-token" },
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
  });

  it("stops before registration when proxy startup fails (#7424)", async () => {
    const harness = createHarness();
    vi.mocked(noAuthProxy).mockImplementation(() => {
      throw new Error("proxy startup failed");
    });

    await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow(
      "proxy startup failed",
    );
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });

  it("restores committed proxy state when provider registration fails (#7424)", async () => {
    const harness = createHarness();
    const persist = vi.fn();
    const restore = vi.fn();
    process.env[NO_AUTH_ENV] = "committed-token";
    vi.mocked(noAuthProxy).mockReturnValue({
      baseUrl: "http://host.openshell.internal:11435/v1",
      credentialValue: "proxy-token",
      persist,
      restore,
    });
    harness.deps.hydrateCredentialEnv.mockReturnValue("proxy-token");
    harness.upsertProvider.mockReturnValue({ ok: false });

    await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow("EXIT_CALLED:1");
    expect(persist).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(process.env[NO_AUTH_ENV]).toBe("committed-token");
  });

  it("restores committed proxy state when registration returns to selection (#7424)", async () => {
    const harness = createHarness();
    const persist = vi.fn();
    const restore = vi.fn();
    process.env[NO_AUTH_ENV] = "committed-token";
    vi.mocked(noAuthProxy).mockReturnValue({
      baseUrl: "http://host.openshell.internal:11435/v1",
      credentialValue: "proxy-token",
      persist,
      restore,
    });
    harness.deps.hydrateCredentialEnv.mockReturnValue("proxy-token");
    harness.upsertProvider.mockReturnValue({ ok: false });
    harness.deps.isNonInteractive.mockReturnValue(false);
    harness.deps.promptValidationRecovery.mockResolvedValue("selection");

    await expect(setupRemoteProviderInference(args, harness.deps)).resolves.toEqual({
      done: true,
      result: { retry: "selection" },
    });
    expect(persist).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(process.env[NO_AUTH_ENV]).toBe("committed-token");
  });
});
