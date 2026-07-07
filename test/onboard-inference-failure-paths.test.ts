// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupInference, SetupInferenceDeps } from "../src/lib/onboard/setup-inference.js";
import {
  createDirectCommandRouter,
  createDirectSetupInferenceHarnessFactory,
  directRunResult,
} from "./support/setup-inference-test-harness.js";

const onboard = require("../src/lib/onboard") as {
  createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
};
const bedrockRuntimeOnboard =
  require("../src/lib/onboard/bedrock-runtime") as typeof import("../src/lib/onboard/bedrock-runtime.js");
const createDirectSetupInferenceHarness = createDirectSetupInferenceHarnessFactory(
  onboard.createSetupInference,
);

type DirectSetupInferenceHarness = ReturnType<typeof createDirectSetupInferenceHarness>;
type EnsureBedrockRuntimeAdapter = NonNullable<
  Parameters<typeof bedrockRuntimeOnboard.setupBedrockRuntimeInference>[0]["ensureAdapter"]
>;

const BEDROCK_ENDPOINT = "https://bedrock-runtime.us-east-1.amazonaws.com";
const BEDROCK_CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const BEDROCK_MODEL = "anthropic.claude-3-5-sonnet-20240620-v1:0";
const NVIDIA_REDACTION_CANARY = ["nv", "api-", "TEST-NOT-A-REAL-VALUE"].join("");

function createInjectedExit() {
  return vi.fn((code: number): never => {
    throw new Error(`EXIT_CALLED:${code}`);
  });
}

function successfulBedrockAdapter() {
  return {
    baseUrl: "http://host.openshell.internal:11436/v1",
    localBaseUrl: "http://127.0.0.1:11436/v1",
    credentialEnv: "NEMOCLAW_BEDROCK_RUNTIME_ADAPTER_TOKEN",
    token: "adapter-token",
    region: "us-east-1",
    logPath: "/tmp/bedrock-adapter.log",
  };
}

function withBedrockAdapter(ensureAdapter: EnsureBedrockRuntimeAdapter) {
  return {
    setupBedrockRuntimeInference: (
      input: Parameters<typeof bedrockRuntimeOnboard.setupBedrockRuntimeInference>[0],
    ) => bedrockRuntimeOnboard.setupBedrockRuntimeInference({ ...input, ensureAdapter }),
  };
}

function stubMissingBedrockAuth(): void {
  for (const key of [
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_PROFILE",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_WEB_IDENTITY_TOKEN_FILE",
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
    "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    BEDROCK_CREDENTIAL_ENV,
  ]) {
    vi.stubEnv(key, "");
  }
}

function expectNoPostFailureSideEffects(
  harness: DirectSetupInferenceHarness,
  expectedCommands: string[] = [],
): void {
  expect(harness.commands.map(({ command }) => command)).toEqual(expectedCommands);
  expect(harness.verifyInferenceRoute).not.toHaveBeenCalled();
  expect(harness.verifyOnboardInferenceSmoke).not.toHaveBeenCalled();
  expect(harness.updateSandbox).not.toHaveBeenCalled();
}

function expectNemoclawScopedRunner(
  harness: DirectSetupInferenceHarness,
  runOpenshell: SetupInferenceDeps["runOpenshell"],
): void {
  expect(runOpenshell).not.toBe(harness.runOpenshell);
  const commandCount = harness.commands.length;
  runOpenshell(["provider", "list"], { ignoreError: true });
  expect(harness.commands.at(-1)).toEqual({
    command: "provider list -g nemoclaw",
    env: undefined,
    ignoreError: true,
  });
  harness.commands.splice(commandCount);
}

describe("setupInference dependency failures", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails through the injected exit boundary when a known remote provider has no config", async () => {
    const exitProcess = createInjectedExit();
    const hydrateCredentialEnv = vi.fn();
    const setupBedrockRuntimeInference = vi.fn(async () => ({ handled: false as const }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        REMOTE_PROVIDER_CONFIG: {},
        exitProcess,
        hydrateCredentialEnv,
        bedrockRuntimeOnboard: { setupBedrockRuntimeInference },
      },
    });

    await expect(harness.setupInference("test-box", "gpt-test", "openai-api")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(harness.errors).toEqual(["  Unsupported provider configuration: openai-api"]);
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(setupBedrockRuntimeInference).not.toHaveBeenCalled();
    expect(hydrateCredentialEnv).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("fails through the injected exit boundary when a remote credential is missing", async () => {
    const exitProcess = createInjectedExit();
    const hydrateCredentialEnv = vi.fn(() => null);
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const setupBedrockRuntimeInference = vi.fn(async () => ({ handled: false as const }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        hydrateCredentialEnv,
        upsertProvider,
        promptValidationRecovery,
        bedrockRuntimeOnboard: { setupBedrockRuntimeInference },
      },
    });

    await expect(harness.setupInference("test-box", "gpt-test", "openai-api")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(setupBedrockRuntimeInference).toHaveBeenCalledOnce();
    expect(hydrateCredentialEnv).toHaveBeenCalledWith("OPENAI_API_KEY");
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(promptValidationRecovery).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  A host credential is required to configure provider 'openai-api'.",
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("preserves a remote provider upsert status through the injected exit boundary", async () => {
    const exitProcess = createInjectedExit();
    const hydrateCredentialEnv = vi.fn(() => "openai-secret");
    const upsertProvider = vi.fn(() => ({
      ok: false,
      status: 23,
      message: "remote provider registration rejected",
    }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const setupBedrockRuntimeInference = vi.fn(async () => ({ handled: false as const }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        hydrateCredentialEnv,
        upsertProvider,
        promptValidationRecovery,
        bedrockRuntimeOnboard: { setupBedrockRuntimeInference },
      },
    });

    await expect(harness.setupInference("test-box", "gpt-test", "openai-api")).rejects.toThrow(
      "EXIT_CALLED:23",
    );

    expect(setupBedrockRuntimeInference).toHaveBeenCalledOnce();
    expect(hydrateCredentialEnv).toHaveBeenCalledWith("OPENAI_API_KEY");
    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(upsertProvider).toHaveBeenCalledWith(
      "openai-api",
      "openai",
      "OPENAI_API_KEY",
      expect.any(String),
      { OPENAI_API_KEY: "openai-secret" },
      "nemoclaw",
    );
    expect(promptValidationRecovery).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(23);
    expect(harness.errors).toEqual(["  remote provider registration rejected"]);
    expectNoPostFailureSideEffects(harness);
  });

  it("redacts a remote inference-set failure and preserves its status at the exit boundary", async () => {
    const exitProcess = createInjectedExit();
    const hydrateCredentialEnv = vi.fn(() => "openai-secret");
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const promptValidationRecovery = vi.fn(async () => "selection" as const);
    const setupBedrockRuntimeInference = vi.fn(async () => ({ handled: false as const }));
    const commandRouter = createDirectCommandRouter([
      {
        name: "remote-inference-set",
        matches: (command) => command.startsWith("inference set"),
        results: [{ status: 37, stdout: "", stderr: `route failed ${NVIDIA_REDACTION_CANARY}` }],
      },
    ]);
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: commandRouter.runOpenshell,
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        hydrateCredentialEnv,
        upsertProvider,
        promptValidationRecovery,
        bedrockRuntimeOnboard: { setupBedrockRuntimeInference },
      },
    });

    await expect(harness.setupInference("test-box", "gpt-test", "openai-api")).rejects.toThrow(
      "EXIT_CALLED:37",
    );

    expect(setupBedrockRuntimeInference).toHaveBeenCalledOnce();
    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(commandRouter.callCount("remote-inference-set")).toBe(1);
    expect(promptValidationRecovery).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(37);
    expect(harness.errors.join("\n")).toContain("route failed");
    expect(harness.errors.join("\n")).not.toContain(NVIDIA_REDACTION_CANARY);
    expectNoPostFailureSideEffects(harness, [
      "inference set -g nemoclaw --no-verify --provider openai-api --model gpt-test",
    ]);
  });

  it("fails closed before provider registration when local vLLM validation fails", async () => {
    const exitProcess = createInjectedExit();
    const validateLocalProvider = vi.fn(() => ({
      ok: false,
      message: "vLLM is unreachable",
      diagnostic: "container probe failed",
    }));
    const getLocalProviderHealthCheck = vi.fn(() => ["curl", "-sf", "http://127.0.0.1:8000"]);
    const run = vi.fn(() => directRunResult({ status: 7 }));
    const harness = createDirectSetupInferenceHarness({
      overrides: { exitProcess, validateLocalProvider, getLocalProviderHealthCheck, run },
    });

    await expect(harness.setupInference("test-box", "meta-llama", "vllm-local")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(validateLocalProvider).toHaveBeenCalledWith("vllm-local");
    expect(getLocalProviderHealthCheck).toHaveBeenCalledWith("vllm-local");
    expect(run).toHaveBeenCalledWith(["curl", "-sf", "http://127.0.0.1:8000"], {
      ignoreError: true,
      suppressOutput: true,
    });
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  vLLM is unreachable",
      "  Diagnostic: container probe failed",
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("propagates local vLLM health-check errors before provider registration", async () => {
    const exitProcess = createInjectedExit();
    const run = vi.fn(() => directRunResult());
    const getLocalProviderHealthCheck = vi.fn(() => {
      throw new Error("health probe exploded");
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        exitProcess,
        validateLocalProvider: () => ({ ok: false, message: "vLLM is unreachable" }),
        getLocalProviderHealthCheck,
        run,
      },
    });

    await expect(harness.setupInference("test-box", "meta-llama", "vllm-local")).rejects.toThrow(
      "health probe exploded",
    );

    expect(getLocalProviderHealthCheck).toHaveBeenCalledWith("vllm-local");
    expect(run).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("propagates Ollama proxy startup errors before reading credentials", async () => {
    const exitProcess = createInjectedExit();
    const ensureOllamaAuthProxy = vi.fn(() => {
      throw new Error("proxy startup failed");
    });
    const getOllamaProxyToken = vi.fn(() => "unused-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => {});
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        exitProcess,
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "proxy startup failed",
    );

    expect(ensureOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("fails closed when the recovered Ollama proxy remains unhealthy", async () => {
    const exitProcess = createInjectedExit();
    const ensureOllamaAuthProxy = vi.fn();
    const isProxyHealthy = vi.fn(() => false);
    const getOllamaProxyToken = vi.fn(() => "unused-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => {});
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        validateLocalProvider: () => ({
          ok: false,
          message: "container cannot reach Ollama",
          diagnostic: "proxy probe failed",
        }),
        shouldFrontOllamaWithProxy: () => true,
        exitProcess,
        ensureOllamaAuthProxy,
        isProxyHealthy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(ensureOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(isProxyHealthy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  container cannot reach Ollama",
      "  Diagnostic: proxy probe failed",
      ...(process.platform === "darwin"
        ? ["  On macOS, local inference also depends on OpenShell host routing support."]
        : []),
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("fails closed when proxy-fronted Ollama has no credential token", async () => {
    const exitProcess = createInjectedExit();
    const ensureOllamaAuthProxy = vi.fn();
    const getOllamaProxyToken = vi.fn(() => null);
    const persistAndProbeOllamaProxy = vi.fn(async () => {});
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        shouldFrontOllamaWithProxy: () => true,
        exitProcess,
        ensureOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(ensureOllamaAuthProxy).toHaveBeenCalledOnce();
    expect(getOllamaProxyToken).toHaveBeenCalledOnce();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  Ollama auth proxy token is not set. Re-run onboard to initialize the proxy.",
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("exits through injected Hermes boundaries when provider storage is unavailable", async () => {
    const exitProcess = createInjectedExit();
    const isHermesProviderRegistered = vi.fn(
      (_runOpenshell: SetupInferenceDeps["runOpenshell"]) => true,
    );
    const ensureHermesProviderApiKeyCredentials = vi.fn(async () => ({}));
    const ensureHermesProviderOAuthCredentials = vi.fn(async () => ({}));
    const checkHermesProviderStoreReachable = vi.fn(
      (_runOpenshell: SetupInferenceDeps["runOpenshell"]) => ({
        ok: false,
        message: "provider store unavailable",
      }),
    );
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        checkHermesProviderStoreReachable,
        hermesProviderAuth: {
          HERMES_PROVIDER_NAME: "hermes-provider",
          isHermesProviderRegistered,
          ensureHermesProviderApiKeyCredentials,
          ensureHermesProviderOAuthCredentials,
        },
      },
    });

    await expect(
      harness.setupInference("test-box", "moonshotai/kimi-k2.6", "hermes-provider"),
    ).rejects.toThrow("EXIT_CALLED:1");

    const runGatewayOpenshell = checkHermesProviderStoreReachable.mock.calls[0][0];
    expectNemoclawScopedRunner(harness, runGatewayOpenshell);
    expect(isHermesProviderRegistered).not.toHaveBeenCalled();
    expect(ensureHermesProviderApiKeyCredentials).not.toHaveBeenCalled();
    expect(ensureHermesProviderOAuthCredentials).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  ✗ OpenShell provider storage is unreachable.",
      "    provider store unavailable",
      "    Restart or recreate the OpenShell gateway, then rerun onboarding.",
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("exits through injected boundaries when Hermes API-key preparation throws", async () => {
    const exitProcess = createInjectedExit();
    const isHermesProviderRegistered = vi.fn(
      (_runOpenshell: SetupInferenceDeps["runOpenshell"]) => false,
    );
    const ensureHermesProviderApiKeyCredentials = vi.fn(async () => {
      throw new Error("API-key preparation failed");
    });
    const ensureHermesProviderOAuthCredentials = vi.fn(async () => ({}));
    const providerExistsInGateway = vi.fn(() => true);
    const resolveHermesNousApiKey = vi.fn(() => "nous-secret");
    const checkHermesProviderStoreReachable = vi.fn(
      (_runOpenshell: SetupInferenceDeps["runOpenshell"]) => ({ ok: true }),
    );
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        normalizeHermesAuthMethod: () => "api_key",
        providerExistsInGateway,
        resolveHermesNousApiKey,
        checkHermesProviderStoreReachable,
        hermesProviderAuth: {
          HERMES_PROVIDER_NAME: "hermes-provider",
          isHermesProviderRegistered,
          ensureHermesProviderApiKeyCredentials,
          ensureHermesProviderOAuthCredentials,
        },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "hermes-provider",
        null,
        "NOUS_API_KEY",
        "api-key",
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    const runGatewayOpenshell = checkHermesProviderStoreReachable.mock.calls[0][0];
    expectNemoclawScopedRunner(harness, runGatewayOpenshell);
    expect(isHermesProviderRegistered).toHaveBeenCalledWith(runGatewayOpenshell);
    expect(providerExistsInGateway).not.toHaveBeenCalled();
    expect(ensureHermesProviderApiKeyCredentials).toHaveBeenCalledOnce();
    expect(ensureHermesProviderApiKeyCredentials).toHaveBeenCalledWith("test-box", {
      apiKey: "nous-secret",
      runOpenshell: runGatewayOpenshell,
      baseUrl: undefined,
    });
    expect(ensureHermesProviderOAuthCredentials).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  ✗ Failed to prepare Hermes Provider credentials: API-key preparation failed",
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("exits through injected boundaries when Hermes OAuth preparation throws", async () => {
    const exitProcess = createInjectedExit();
    const isHermesProviderRegistered = vi.fn(
      (_runOpenshell: SetupInferenceDeps["runOpenshell"]) => false,
    );
    const ensureHermesProviderApiKeyCredentials = vi.fn(async () => ({}));
    const ensureHermesProviderOAuthCredentials = vi.fn(async () => {
      throw new Error("OAuth preparation failed");
    });
    const providerExistsInGateway = vi.fn(() => true);
    const resolveHermesNousApiKey = vi.fn(() => "unused-key");
    const checkHermesProviderStoreReachable = vi.fn(
      (_runOpenshell: SetupInferenceDeps["runOpenshell"]) => ({ ok: true }),
    );
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        normalizeHermesAuthMethod: () => "oauth",
        providerExistsInGateway,
        resolveHermesNousApiKey,
        checkHermesProviderStoreReachable,
        hermesProviderAuth: {
          HERMES_PROVIDER_NAME: "hermes-provider",
          isHermesProviderRegistered,
          ensureHermesProviderApiKeyCredentials,
          ensureHermesProviderOAuthCredentials,
        },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "hermes-provider",
        null,
        null,
        "oauth",
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    const runGatewayOpenshell = checkHermesProviderStoreReachable.mock.calls[0][0];
    expectNemoclawScopedRunner(harness, runGatewayOpenshell);
    expect(isHermesProviderRegistered).toHaveBeenCalledWith(runGatewayOpenshell);
    expect(providerExistsInGateway).not.toHaveBeenCalled();
    expect(resolveHermesNousApiKey).not.toHaveBeenCalled();
    expect(ensureHermesProviderApiKeyCredentials).not.toHaveBeenCalled();
    expect(ensureHermesProviderOAuthCredentials).toHaveBeenCalledOnce();
    expect(ensureHermesProviderOAuthCredentials).toHaveBeenCalledWith("test-box", {
      allowInteractiveLogin: false,
      runOpenshell: runGatewayOpenshell,
      baseUrl: undefined,
      toolGatewayPresets: [],
    });
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual([
      "  ✗ Failed to prepare Hermes Provider credentials: OAuth preparation failed",
    ]);
    expectNoPostFailureSideEffects(harness);
  });

  it("propagates Ollama proxy persistence errors before provider registration", async () => {
    const exitProcess = createInjectedExit();
    const persistAndProbeOllamaProxy = vi.fn(async () => {
      throw new Error("proxy persistence failed");
    });
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        exitProcess,
        shouldFrontOllamaWithProxy: () => true,
        ensureOllamaAuthProxy: () => {},
        getOllamaProxyToken: () => "proxy-token",
        persistAndProbeOllamaProxy,
      },
    });

    await expect(harness.setupInference("test-box", "qwen3.5:9b", "ollama-local")).rejects.toThrow(
      "proxy persistence failed",
    );

    expect(persistAndProbeOllamaProxy).toHaveBeenCalledWith("proxy-token");
    expect(exitProcess).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("exits through the injected boundary when non-interactive Bedrock setup has no auth", async () => {
    stubMissingBedrockAuth();
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => successfulBedrockAdapter());
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toContain(
      "  AWS_BEARER_TOKEN_BEDROCK, AWS_PROFILE, IAM environment credentials, or an explicitly exported Bedrock-compatible endpoint key is required for a Bedrock Runtime endpoint.",
    );
    expect(harness.logs).toEqual([]);
    expect(ensureAdapter).not.toHaveBeenCalled();
    expect(upsertProvider).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("returns to provider selection when the Bedrock adapter cannot start interactively", async () => {
    vi.stubEnv(BEDROCK_CREDENTIAL_ENV, "bedrock-bearer");
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => {
      throw new Error("adapter unavailable");
    });
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).resolves.toEqual({ retry: "selection" });

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(exitProcess).not.toHaveBeenCalled();
    expect(harness.errors).toContain(
      "  Failed to start Bedrock Runtime adapter: adapter unavailable",
    );
    expect(harness.logs).toEqual([]);
    expectNoPostFailureSideEffects(harness);
  });

  it("exits through the injected boundary when the Bedrock adapter cannot start", async () => {
    vi.stubEnv("COMPATIBLE_ANTHROPIC_API_KEY", "bedrock-bearer");
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => {
      throw new Error("adapter unavailable");
    });
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toContain(
      "  Failed to start Bedrock Runtime adapter: adapter unavailable",
    );
    expect(harness.logs).toEqual([]);
    expectNoPostFailureSideEffects(harness);
  });

  it("preserves the provider status through the injected Bedrock exit boundary", async () => {
    vi.stubEnv(BEDROCK_CREDENTIAL_ENV, "bedrock-bearer");
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => successfulBedrockAdapter());
    const upsertProvider = vi.fn(() => ({
      ok: false,
      status: 23,
      message: "Bedrock provider registration failed",
    }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).rejects.toThrow("EXIT_CALLED:23");

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(23);
    expect(harness.errors).toContain("  Bedrock provider registration failed");
    expect(harness.logs).toEqual([]);
    expectNoPostFailureSideEffects(harness);
  });

  it("falls back to status 1 when Bedrock provider registration returns status 0", async () => {
    vi.stubEnv(BEDROCK_CREDENTIAL_ENV, "bedrock-bearer");
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => successfulBedrockAdapter());
    const upsertProvider = vi.fn(() => ({
      ok: false,
      status: 0,
      message: "Bedrock provider registration failed without status",
    }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toContain("  Bedrock provider registration failed without status");
    expect(harness.logs).toEqual([]);
    expectNoPostFailureSideEffects(harness);
  });

  it("preserves the inference-set status through the injected Bedrock exit boundary", async () => {
    vi.stubEnv(BEDROCK_CREDENTIAL_ENV, "bedrock-bearer");
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => successfulBedrockAdapter());
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: (args) =>
        args.slice(0, 2).join(" ") === "inference set"
          ? { status: 37, stdout: "", stderr: "route denied" }
          : undefined,
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).rejects.toThrow("EXIT_CALLED:37");

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(37);
    expect(harness.errors).toContain("  route denied");
    expect(harness.logs).toEqual([
      "  Bedrock Runtime adapter ready: region us-east-1, sandbox route http://host.openshell.internal:11436/v1, host log /tmp/bedrock-adapter.log",
    ]);
    expectNoPostFailureSideEffects(harness, [
      `inference set -g nemoclaw --no-verify --provider compatible-anthropic-endpoint --model ${BEDROCK_MODEL} --timeout 180`,
    ]);
  });

  it("falls back to status 1 and a generic error when Bedrock inference set has no status", async () => {
    vi.stubEnv(BEDROCK_CREDENTIAL_ENV, "bedrock-bearer");
    const exitProcess = createInjectedExit();
    const ensureAdapter = vi.fn(async () => successfulBedrockAdapter());
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: (args) =>
        args.slice(0, 2).join(" ") === "inference set"
          ? { status: null, stdout: "", stderr: "" }
          : undefined,
      overrides: {
        isNonInteractive: () => true,
        exitProcess,
        upsertProvider,
        bedrockRuntimeOnboard: withBedrockAdapter(ensureAdapter),
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        BEDROCK_MODEL,
        "compatible-anthropic-endpoint",
        BEDROCK_ENDPOINT,
        BEDROCK_CREDENTIAL_ENV,
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(ensureAdapter).toHaveBeenCalledOnce();
    expect(upsertProvider).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toContain(
      "  Failed to configure inference provider 'compatible-anthropic-endpoint'.",
    );
    expect(harness.logs).toEqual([
      "  Bedrock Runtime adapter ready: region us-east-1, sandbox route http://host.openshell.internal:11436/v1, host log /tmp/bedrock-adapter.log",
    ]);
    expectNoPostFailureSideEffects(harness, [
      `inference set -g nemoclaw --no-verify --provider compatible-anthropic-endpoint --model ${BEDROCK_MODEL} --timeout 180`,
    ]);
  });

  it("uses an injected Hermes DNS lookup before rejecting an unpinnable HTTPS endpoint", async () => {
    const exitProcess = createInjectedExit();
    const lookup = vi.fn<NonNullable<SetupInferenceDeps["lookup"]>>(async () => [
      { address: "8.8.8.8", family: 4 },
    ]);
    const harness = createDirectSetupInferenceHarness({ overrides: { exitProcess, lookup } });

    await expect(
      harness.setupInference(
        "test-box",
        "moonshotai/kimi-k2.6",
        "hermes-provider",
        "https://api.public.example.test/v1",
      ),
    ).rejects.toThrow("DNS-backed HTTPS URLs are not supported");

    expect(lookup).toHaveBeenCalledWith("api.public.example.test", { all: true });
    expect(exitProcess).not.toHaveBeenCalled();
    expectNoPostFailureSideEffects(harness);
  });

  it("fails closed before routed-provider registration when model-router reconciliation fails", async () => {
    const exitProcess = createInjectedExit();
    const reconcileModelRouter = vi.fn(async () => {
      throw new Error("router unavailable");
    });
    const upsertRoutedProvider = vi.fn(() => ({ ok: true, result: {} }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isRoutedInferenceProvider: (provider) => provider === "nvidia-router",
        exitProcess,
        reconcileModelRouter,
        routedInference: { upsertRoutedProvider },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "router/model",
        "nvidia-router",
        "http://host.openshell.internal:4000/v1",
        "NVIDIA_INFERENCE_API_KEY",
      ),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(reconcileModelRouter).toHaveBeenCalledOnce();
    expect(upsertRoutedProvider).not.toHaveBeenCalled();
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(harness.errors).toEqual(["  ✗ Failed to start model router: router unavailable"]);
    expectNoPostFailureSideEffects(harness);
  });

  it("preserves a routed-provider upsert status through the injected exit boundary", async () => {
    const exitProcess = createInjectedExit();
    const reconcileModelRouter = vi.fn(async () => {});
    const upsertProvider = vi.fn(() => ({ ok: true }));
    const hydrateCredentialEnv = vi.fn(() => "unused-secret");
    const upsertRoutedProvider = vi.fn<
      SetupInferenceDeps["routedInference"]["upsertRoutedProvider"]
    >(() => ({
      ok: false,
      result: { status: 29, message: "routed provider registration rejected" },
    }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isRoutedInferenceProvider: (provider) => provider === "nvidia-router",
        exitProcess,
        reconcileModelRouter,
        upsertProvider,
        hydrateCredentialEnv,
        routedInference: { upsertRoutedProvider },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "router/model",
        "nvidia-router",
        "http://host.openshell.internal:4000/v1",
        "NVIDIA_INFERENCE_API_KEY",
      ),
    ).rejects.toThrow("EXIT_CALLED:29");

    expect(reconcileModelRouter).toHaveBeenCalledOnce();
    expect(upsertRoutedProvider).toHaveBeenCalledOnce();
    expect(upsertRoutedProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "http://host.openshell.internal:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
      {
        upsertProvider: expect.any(Function),
        hydrateCredentialEnv,
      },
    );
    const routedUpsertProvider = upsertRoutedProvider.mock.calls[0][3].upsertProvider;
    expect(routedUpsertProvider).not.toBe(upsertProvider);
    expect(upsertProvider).not.toHaveBeenCalled();
    expect(hydrateCredentialEnv).not.toHaveBeenCalled();
    routedUpsertProvider(
      "nvidia-router",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "http://host.openshell.internal:4000/v1",
      { NVIDIA_INFERENCE_API_KEY: "test-secret" },
    );
    expect(upsertProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "openai",
      "NVIDIA_INFERENCE_API_KEY",
      "http://host.openshell.internal:4000/v1",
      { NVIDIA_INFERENCE_API_KEY: "test-secret" },
      "nemoclaw",
    );
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(29);
    expect(harness.errors).toEqual(["  routed provider registration rejected"]);
    expectNoPostFailureSideEffects(harness);
  });

  it("redacts a routed inference-set failure and preserves its status at the exit boundary", async () => {
    const exitProcess = createInjectedExit();
    const reconcileModelRouter = vi.fn(async () => {});
    const upsertRoutedProvider = vi.fn(() => ({ ok: true, result: {} }));
    const commandRouter = createDirectCommandRouter([
      {
        name: "routed-inference-set",
        matches: (command) => command.startsWith("inference set"),
        results: [
          { status: 41, stdout: "", stderr: `routed apply failed ${NVIDIA_REDACTION_CANARY}` },
        ],
      },
    ]);
    const harness = createDirectSetupInferenceHarness({
      runOpenshell: commandRouter.runOpenshell,
      overrides: {
        isRoutedInferenceProvider: (provider) => provider === "nvidia-router",
        exitProcess,
        reconcileModelRouter,
        routedInference: { upsertRoutedProvider },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "router/model",
        "nvidia-router",
        "http://host.openshell.internal:4000/v1",
        "NVIDIA_INFERENCE_API_KEY",
      ),
    ).rejects.toThrow("EXIT_CALLED:41");

    expect(reconcileModelRouter).toHaveBeenCalledOnce();
    expect(upsertRoutedProvider).toHaveBeenCalledOnce();
    expect(commandRouter.callCount("routed-inference-set")).toBe(1);
    expect(harness.commands.at(-1)).toMatchObject({ ignoreError: true });
    expect(exitProcess).toHaveBeenCalledOnce();
    expect(exitProcess).toHaveBeenCalledWith(41);
    expect(harness.errors.join("\n")).toContain("routed apply failed");
    expect(harness.errors.join("\n")).not.toContain(NVIDIA_REDACTION_CANARY);
    expectNoPostFailureSideEffects(harness, [
      "inference set -g nemoclaw --no-verify --provider nvidia-router --model router/model",
    ]);
  });

  it("runs shared finalization after routed inference setup succeeds", async () => {
    const exitProcess = createInjectedExit();
    const reconcileModelRouter = vi.fn(async () => {});
    const upsertRoutedProvider = vi.fn(() => ({ ok: true, result: {} }));
    const harness = createDirectSetupInferenceHarness({
      overrides: {
        isRoutedInferenceProvider: (provider) => provider === "nvidia-router",
        exitProcess,
        reconcileModelRouter,
        routedInference: { upsertRoutedProvider },
      },
    });

    await expect(
      harness.setupInference(
        "test-box",
        "router/model",
        "nvidia-router",
        "http://host.openshell.internal:4000/v1",
        "NVIDIA_INFERENCE_API_KEY",
      ),
    ).resolves.toEqual({ ok: true });

    expect(reconcileModelRouter).toHaveBeenCalledOnce();
    expect(upsertRoutedProvider).toHaveBeenCalledOnce();
    expect(harness.commands).toEqual([
      {
        command:
          "inference set -g nemoclaw --no-verify --provider nvidia-router --model router/model",
        ignoreError: true,
        env: undefined,
      },
    ]);
    expect(harness.verifyInferenceRoute).toHaveBeenCalledOnce();
    expect(harness.verifyInferenceRoute).toHaveBeenCalledWith(
      "nemoclaw",
      "nvidia-router",
      "router/model",
    );
    expect(harness.verifyOnboardInferenceSmoke).toHaveBeenCalledOnce();
    expect(harness.verifyOnboardInferenceSmoke).toHaveBeenCalledWith({
      provider: "nvidia-router",
      model: "router/model",
      endpointUrl: "http://host.openshell.internal:4000/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    expect(harness.updateSandbox).toHaveBeenCalledOnce();
    expect(harness.updateSandbox).toHaveBeenCalledWith("test-box", {
      model: "router/model",
      provider: "nvidia-router",
      endpointUrl: "http://host.openshell.internal:4000/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: null,
      gatewayName: "nemoclaw",
    });
    expect(harness.logs).toEqual(["  ✓ Inference route set: nvidia-router / router/model"]);
    expect(harness.errors).toEqual([]);
    expect(exitProcess).not.toHaveBeenCalled();
  });
});
