// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withCredentialOverrides } from "../../credentials/scoped-overrides";
import { createManagedProviderAdapter } from "../../adapters/openshell/managed-provider-adapter";
import { noAuthProxy, withOllamaProxyLifecycleTransaction } from "../../inference/ollama/proxy";
import { hydrateCredentialEnv } from "../credential-env";
import { setupRemoteProviderInference } from "./remote";
import type { RemoteProviderDeps } from "./types";
import { stopDestroyedSandboxProxy } from "../../actions/sandbox/destroy-preflight";
import type { SandboxEntry } from "../../state/registry";

vi.mock("../../inference/ollama/proxy", () => ({
  noAuthProxy: vi.fn(),
  withOllamaProxyLifecycleTransaction: vi.fn(),
}));

const PROVIDER = "compatible-anthropic-endpoint";
const MODEL = "custom-model";
const ENDPOINT = "https://inference.example";
const OPENAI_SURFACE = `${ENDPOINT}/v1`;
const CREDENTIAL_ENV = "COMPATIBLE_ANTHROPIC_API_KEY";
const SANDBOX = "target-box";
const NO_AUTH_ENV = "NEMOCLAW_OLLAMA_PROXY_TOKEN";
const SUCCESS = { status: 0, stdout: "", stderr: "" };
const ANTHROPIC_PROVIDER = {
  ...SUCCESS,
  stdout: `Name: ${PROVIDER}\nType: anthropic\nCredential keys: ${CREDENTIAL_ENV}\nConfig keys: ANTHROPIC_BASE_URL`,
};

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
  const runOpenshell = vi.fn((args: string[], _options?: { ignoreError?: boolean }) =>
    args[0] === "provider" && args[1] === "get" ? ANTHROPIC_PROVIDER : SUCCESS,
  );
  const upsertProvider = vi.fn(async () => ({ ok: true }));
  const probeOpenAiLikeEndpoint = vi.fn(() => ({ ok: true }));
  const hydrateCredential = vi.fn((_name: string) => "test-secret");
  const exitProcess = vi.fn((code: number): never => {
    throw new Error(`EXIT_CALLED:${code}`);
  });
  const error = vi.fn();
  const inferenceRouteMutator: RemoteProviderDeps["inferenceRouteMutator"] = {
    setInferenceRoute: vi.fn(async (request) => {
      const args = [
        "inference",
        "set",
        "-g",
        request.target.gatewayName,
        ...(request.verification === "skip" ? ["--no-verify"] : []),
        "--provider",
        request.route.provider,
        "--model",
        request.route.model,
        ...(request.verificationTimeoutSeconds === undefined
          ? []
          : ["--timeout", String(request.verificationTimeoutSeconds)]),
      ];
      const result = runOpenshell(args, { ignoreError: true });
      return result.status === 0
        ? { ok: true as const }
        : {
            ok: false as const,
            ambiguous: false,
            error: {
              kind: "command" as const,
              reason: "failed" as const,
              exitCode: result.status,
              message: String(result.stderr || result.stdout || "route update failed"),
            },
          };
    }),
  };
  const reserveSandboxInferenceRoute = vi.fn<RemoteProviderDeps["reserveSandboxInferenceRoute"]>(
    () => true,
  );
  const deps = {
    runOpenshell,
    gatewayName: "nemoclaw",
    inferenceRouteMutator,
    upsertProvider,
    verifyInferenceRoute: vi.fn(),
    verifyOnboardInferenceSmoke: vi.fn(),
    isNonInteractive: vi.fn(() => true),
    registry: { updateSandbox: vi.fn(() => true) },
    reserveSandboxInferenceRoute,
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
      "llama-cpp": {
        label: "Local llama.cpp",
        providerName: "llama-cpp-local",
        providerType: "openai",
        credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        endpointUrl: "http://127.0.0.1:8081/v1",
        helpUrl: null,
        modelMode: "input",
        defaultModel: "",
        skipVerify: true,
      },
    },
    hydrateCredentialEnv: hydrateCredential,
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
  } satisfies RemoteProviderDeps;

  return {
    deps,
    runOpenshell,
    upsertProvider,
    probeOpenAiLikeEndpoint,
    exitProcess,
    error,
  };
}

beforeEach(() => {
  vi.mocked(withOllamaProxyLifecycleTransaction).mockImplementation(async (operation) =>
    operation(),
  );
});

afterEach(() => {
  vi.mocked(noAuthProxy).mockReset();
  vi.mocked(withOllamaProxyLifecycleTransaction).mockReset();
  delete process.env[NO_AUTH_ENV];
  vi.unstubAllEnvs();
});

describe("OpenAI-compatible scoped credential registration", () => {
  it("passes the scoped key only in the authorized provider-registration environment", async () => {
    vi.stubEnv("COMPATIBLE_API_KEY", undefined);
    const harness = createHarness();
    harness.deps.hydrateCredentialEnv.mockImplementation((name: string) => {
      const value = hydrateCredentialEnv(name);
      if (!value) {
        throw new Error(`Missing scoped credential '${name}'.`);
      }
      return value;
    });

    await withCredentialOverrides({ COMPATIBLE_API_KEY: "runtime-only-secret" }, async () => {
      await expect(
        setupRemoteProviderInference(
          {
            sandboxName: SANDBOX,
            model: MODEL,
            provider: "compatible-endpoint",
            endpointUrl: "https://inference.example/v1",
            credentialEnv: "COMPATIBLE_API_KEY",
            preferredInferenceApi: "openai-completions",
            pinnedAddresses: ["93.184.216.34"],
          },
          harness.deps,
        ),
      ).resolves.toEqual({ done: false });

      expect(harness.upsertProvider).toHaveBeenCalledWith(
        "compatible-endpoint",
        "openai",
        "COMPATIBLE_API_KEY",
        "https://inference.example/v1",
        { COMPATIBLE_API_KEY: "runtime-only-secret" },
      );
      expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
    });

    expect(process.env.COMPATIBLE_API_KEY).toBeUndefined();
  });
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
    expect(harness.runOpenshell).toHaveBeenNthCalledWith(
      1,
      ["provider", "get", PROVIDER],
      expect.objectContaining({ ignoreError: true, suppressOutput: true }),
    );
    expect(harness.runOpenshell).toHaveBeenNthCalledWith(
      2,
      ["provider", "delete", PROVIDER],
      expect.objectContaining({
        ignoreError: true,
        suppressOutput: true,
      }),
    );
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
    expect(harness.runOpenshell.mock.invocationCallOrder[1]).toBeLessThan(
      harness.upsertProvider.mock.invocationCallOrder[0],
    );
  });

  it("authorizes detach recovery only for the current sandbox (#6294)", async () => {
    const harness = createHarness();
    const providerAdapter = createManagedProviderAdapter(harness.runOpenshell);
    const deleteProvider = vi.spyOn(providerAdapter, "deleteProvider");
    const attached = {
      status: 1,
      stdout: "",
      stderr: `provider '${PROVIDER}' is attached to sandbox(es): ${SANDBOX}`,
    };
    harness.runOpenshell.mockReturnValueOnce(ANTHROPIC_PROVIDER).mockReturnValueOnce(attached);

    await expect(
      setupRemoteProviderInference(makeArgs(SANDBOX), { ...harness.deps, providerAdapter }),
    ).resolves.toEqual({ done: false });

    expect(harness.runOpenshell.mock.calls.slice(0, 4).map(([args]) => args)).toEqual([
      ["provider", "get", PROVIDER],
      ["provider", "delete", PROVIDER],
      ["sandbox", "provider", "detach", SANDBOX, PROVIDER],
      ["provider", "delete", PROVIDER],
    ]);
    expect(deleteProvider).toHaveBeenCalledTimes(2);
    expect(harness.upsertProvider).toHaveBeenCalledWith(
      PROVIDER,
      "openai",
      CREDENTIAL_ENV,
      OPENAI_SURFACE,
      { [CREDENTIAL_ENV]: "test-secret" },
    );
    expect(harness.runOpenshell.mock.invocationCallOrder[3]).toBeLessThan(
      harness.upsertProvider.mock.invocationCallOrder[0],
    );
  });

  it("does not retry deletion or register a provider after an uncertain detach", async () => {
    const harness = createHarness();
    const providerAdapter = createManagedProviderAdapter(harness.runOpenshell);
    harness.deps.redact.mockImplementation((value) =>
      value.replaceAll("test-secret", "[redacted]"),
    );
    vi.spyOn(providerAdapter, "detachProvider").mockResolvedValue({
      ok: false,
      error: { kind: "command", reason: "uncertain", message: "outcome unknown: test-secret" },
    });
    harness.runOpenshell.mockReturnValueOnce(ANTHROPIC_PROVIDER).mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: `provider '${PROVIDER}' is attached to sandbox(es): ${SANDBOX}`,
    });

    await expect(
      setupRemoteProviderInference(makeArgs(SANDBOX), { ...harness.deps, providerAdapter }),
    ).rejects.toThrow("EXIT_CALLED:1");

    expect(harness.error).toHaveBeenCalledWith(
      expect.stringContaining(`detach failures: ${SANDBOX}: outcome unknown: [redacted]`),
    );
    expect(harness.error.mock.calls.flat().join(" ")).not.toContain("test-secret");
    expect(providerAdapter.detachProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "selected" },
      sandboxName: SANDBOX,
      providerName: PROVIDER,
    });
    expect(harness.runOpenshell.mock.calls.map(([args]) => args)).toEqual([
      ["provider", "get", PROVIDER],
      ["provider", "delete", PROVIDER],
    ]);
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });

  it("fails closed when a foreign sandbox is attached (#6294)", async () => {
    const harness = createHarness();
    harness.runOpenshell.mockReturnValueOnce(ANTHROPIC_PROVIDER).mockReturnValueOnce({
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
    expect(harness.runOpenshell).toHaveBeenCalledTimes(2);
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });

  it("refuses detach recovery without a confirmed sandbox (#6294)", async () => {
    const harness = createHarness();
    harness.runOpenshell.mockReturnValueOnce(ANTHROPIC_PROVIDER).mockReturnValueOnce({
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
    expect(harness.runOpenshell).toHaveBeenCalledTimes(2);
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });

  it("reports a redacted provider lookup failure through the setup result", async () => {
    const harness = createHarness();
    harness.runOpenshell.mockReturnValueOnce({
      status: 1,
      stdout: "",
      stderr: "unauthorized token=secret",
    });
    harness.deps.redact.mockImplementation((value: string) => value.replaceAll("secret", "safe"));

    await expect(setupRemoteProviderInference(makeArgs(SANDBOX), harness.deps)).rejects.toThrow(
      "EXIT_CALLED:1",
    );

    expect(harness.error).toHaveBeenCalledWith(
      "  Failed to inspect provider 'compatible-anthropic-endpoint' before replacement: OpenShell could not authenticate the provider operation.",
    );
    expect(JSON.stringify(harness.error.mock.calls)).not.toContain("secret");
    expect(harness.upsertProvider).not.toHaveBeenCalled();
  });
});

describe("OpenAI-compatible no-auth provider registration", () => {
  it.each(["compatible-endpoint", "compatible-anthropic-endpoint"])(
    "publishes the pending %s owner before a waiting destroy checks the proxy",
    async (provider) => {
      const harness = createHarness();
      const prior = { name: "old-owner", provider: "ollama-local" } as SandboxEntry;
      const pending = { name: SANDBOX, provider, credentialEnv: NO_AUTH_ENV } as SandboxEntry;
      const entries = [prior];
      let proxyRunning = true;
      const restore = vi.fn();
      vi.mocked(noAuthProxy).mockReturnValue({
        baseUrl: "http://host.openshell.internal:11435/v1",
        credentialValue: "proxy-token",
        persist: vi.fn(),
        restore,
      });
      harness.deps.reserveSandboxInferenceRoute.mockImplementation(() => {
        entries.push(pending);
        return true;
      });
      vi.mocked(withOllamaProxyLifecycleTransaction).mockImplementation(async (operation) => {
        const result = await operation();
        stopDestroyedSandboxProxy(
          prior.name,
          prior,
          () => ({ sandboxes: entries, defaultSandbox: null }),
          {
            killStaleProxyIfUnused: (hasOwner) => {
              proxyRunning = hasOwner();
              return !proxyRunning;
            },
          },
        );
        return result;
      });

      await expect(
        setupRemoteProviderInference(
          {
            ...makeArgs(SANDBOX),
            provider,
            credentialEnv: NO_AUTH_ENV,
            endpointUrl: "http://localhost:8000/v1",
            preferredInferenceApi: "anthropic-messages",
          },
          harness.deps,
        ),
      ).resolves.toEqual({ done: false });

      expect(entries).toEqual([prior, pending]);
      expect(proxyRunning).toBe(true);
      expect(restore).not.toHaveBeenCalled();
    },
  );
  const args = {
    sandboxName: SANDBOX,
    model: MODEL,
    provider: "compatible-endpoint",
    endpointUrl: "http://localhost:11434/v1",
    credentialEnv: NO_AUTH_ENV,
    preferredInferenceApi: "openai-completions",
    pinnedAddresses: ["127.0.0.1"],
  };

  it("reserves an unpublished owner before retaining a proxy after an ambiguous route result", async () => {
    const harness = createHarness();
    const events: string[] = [];
    const pendingOwners: SandboxEntry[] = [];
    const persist = vi.fn(() => events.push("persist"));
    const restore = vi.fn(() => events.push("restore"));
    vi.mocked(noAuthProxy).mockReturnValue({
      baseUrl: "http://host.openshell.internal:11435/v1",
      credentialValue: "proxy-token",
      persist,
      restore,
    });
    harness.deps.inferenceRouteMutator = {
      setInferenceRoute: vi.fn(async () => {
        events.push("mutate");
        return {
          ok: false as const,
          ambiguous: true,
          error: {
            kind: "command" as const,
            reason: "indeterminate" as const,
            exitCode: null,
            message: "route result unknown",
          },
        };
      }),
    };
    harness.deps.reserveSandboxInferenceRoute.mockImplementation((name, route) => {
      events.push("reserve");
      pendingOwners.push({
        name,
        ...route,
        credentialEnv: NO_AUTH_ENV,
        pendingRouteReservation: true,
      });
      return true;
    });
    vi.mocked(withOllamaProxyLifecycleTransaction).mockImplementation(async (operation) => {
      try {
        return await operation();
      } finally {
        events.push("destroy-check");
        let proxyRunning = false;
        stopDestroyedSandboxProxy(
          "old-owner",
          { name: "old-owner", provider: "ollama-local" },
          () => ({ sandboxes: [], defaultSandbox: null }),
          {
            listInferenceRouteOwners: () => pendingOwners,
            killStaleProxyIfUnused: (hasOwner) => {
              proxyRunning = hasOwner();
              return !proxyRunning;
            },
          },
        );
        expect(proxyRunning).toBe(true);
      }
    });

    await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow("EXIT_CALLED:1");

    expect(events).toEqual(["mutate", "reserve", "persist", "destroy-check"]);
    expect(pendingOwners).toEqual([
      expect.objectContaining({
        name: SANDBOX,
        provider: "compatible-endpoint",
        model: MODEL,
        credentialEnv: NO_AUTH_ENV,
        pendingRouteReservation: true,
      }),
    ]);
    expect(restore).not.toHaveBeenCalled();
    expect(harness.deps.registry.updateSandbox).not.toHaveBeenCalled();
    expect(harness.deps.log).not.toHaveBeenCalledWith(expect.stringContaining("✓"));
  });

  it.each([
    ["returns false", () => false, "Could not reserve durable ownership"],
    [
      "throws",
      () => {
        throw new Error("reservation write outcome unknown");
      },
      "reservation write outcome unknown",
    ],
  ])(
    "retains the proxy when ambiguous-route ownership persistence $0",
    async (_, reserve, message) => {
      const harness = createHarness();
      const persist = vi.fn();
      const restore = vi.fn();
      vi.mocked(noAuthProxy).mockReturnValue({
        baseUrl: "http://host.openshell.internal:11435/v1",
        credentialValue: "proxy-token",
        persist,
        restore,
      });
      harness.deps.inferenceRouteMutator = {
        setInferenceRoute: vi.fn(async () => ({
          ok: false as const,
          ambiguous: true,
          error: {
            kind: "command" as const,
            reason: "indeterminate" as const,
            exitCode: null,
            message: "route result unknown",
          },
        })),
      };
      harness.deps.reserveSandboxInferenceRoute.mockImplementation(reserve);

      await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow(message);
      expect(persist).toHaveBeenCalledOnce();
      expect(restore).not.toHaveBeenCalled();
      expect(harness.deps.registry.updateSandbox).not.toHaveBeenCalled();
    },
  );

  it("rejects a proxy-backed route without a named owner before provider or route mutation", async () => {
    const harness = createHarness();
    const restore = vi.fn();
    vi.mocked(noAuthProxy).mockReturnValue({
      baseUrl: "http://host.openshell.internal:11435/v1",
      credentialValue: "proxy-token",
      persist: vi.fn(),
      restore,
    });

    await expect(
      setupRemoteProviderInference({ ...args, sandboxName: null }, harness.deps),
    ).rejects.toThrow("A named sandbox is required");
    expect(harness.upsertProvider).not.toHaveBeenCalled();
    expect(harness.deps.inferenceRouteMutator.setInferenceRoute).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
  });

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

    expect(noAuthProxy).toHaveBeenCalledWith("http://localhost:11434/v1");
    expect(withOllamaProxyLifecycleTransaction).toHaveBeenCalledOnce();
    expect(harness.upsertProvider).toHaveBeenCalledWith(
      "compatible-endpoint",
      "openai",
      NO_AUTH_ENV,
      "http://host.openshell.internal:11435/v1",
      { [NO_AUTH_ENV]: "proxy-token" },
    );
    expect(persist).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(harness.runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--no-verify",
        "--provider",
        "compatible-endpoint",
        "--model",
        MODEL,
        "--timeout",
        "60",
      ],
      { ignoreError: true },
    );
  });

  it("carries recorded legacy-route authority to final proxy setup", async () => {
    const harness = createHarness();
    vi.mocked(noAuthProxy).mockReturnValue({
      baseUrl: "http://host.openshell.internal:12435/v1",
      credentialValue: "proxy-token",
      persist: vi.fn(),
      restore: vi.fn(),
    });

    await expect(
      setupRemoteProviderInference(
        { ...args, allowLegacyRecordedNoAuthEndpoint: true },
        harness.deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(noAuthProxy).toHaveBeenCalledWith("http://localhost:11434/v1", {
      allowLegacyRecordedEndpoint: true,
    });
  });

  it.each([
    { outcome: "rejected", reserve: () => false, message: "Could not reserve the inference route" },
    {
      outcome: "thrown",
      reserve: () => {
        throw new Error("reservation failed");
      },
      message: "reservation failed",
    },
  ])("retains proxy state when route reservation is $outcome", async ({ reserve, message }) => {
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
    harness.deps.reserveSandboxInferenceRoute.mockImplementation(reserve);

    await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow(message);
    expect(persist).toHaveBeenCalledOnce();
    expect(restore).not.toHaveBeenCalled();
    expect(process.env[NO_AUTH_ENV]).toBe("proxy-token");
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
    harness.upsertProvider.mockResolvedValue({ ok: false });

    await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow("EXIT_CALLED:1");
    expect(persist).not.toHaveBeenCalled();
    expect(restore).toHaveBeenCalledOnce();
    expect(process.env[NO_AUTH_ENV]).toBe("committed-token");
  });

  it("restores committed proxy state when registration throws unexpectedly (#7424)", async () => {
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
    harness.upsertProvider.mockImplementation(() => {
      throw new Error("unexpected registration failure");
    });

    await expect(setupRemoteProviderInference(args, harness.deps)).rejects.toThrow(
      "unexpected registration failure",
    );
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
    harness.upsertProvider.mockResolvedValue({ ok: false });
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

describe("llama.cpp existing-server provider registration", () => {
  it("registers the fixed llama.cpp gateway endpoint with NEMOCLAW_LLAMACPP_LOCAL_TOKEN (#8161)", async () => {
    const harness = createHarness();
    harness.deps.hydrateCredentialEnv.mockReturnValue("llama-secret");

    await expect(
      setupRemoteProviderInference(
        {
          sandboxName: SANDBOX,
          model: "team/model-alias",
          provider: "llama-cpp-local",
          endpointUrl: "http://127.0.0.1:8081/v1",
          credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
          preferredInferenceApi: "openai-completions",
        },
        harness.deps,
      ),
    ).resolves.toEqual({ done: false });

    expect(harness.upsertProvider).toHaveBeenCalledWith(
      "llama-cpp-local",
      "openai",
      "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      "http://host.openshell.internal:8081/v1",
      { NEMOCLAW_LLAMACPP_LOCAL_TOKEN: "llama-secret" },
    );
    expect(harness.runOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--no-verify",
        "--provider",
        "llama-cpp-local",
        "--model",
        "team/model-alias",
      ],
      { ignoreError: true },
    );
  });
});
