// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
  type ProviderSelectionResult,
} from "./provider-inference";

type Gpu = { type: string } | null;
type Agent = { name: string } | null;
type Host = { cpus?: number };

const baseSelection: ProviderSelectionResult = {
  model: "nvidia/test",
  provider: "nvidia-prod",
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  credentialEnv: "NVIDIA_API_KEY",
  hermesAuthMethod: null,
  hermesToolGateways: [],
  preferredInferenceApi: "openai-responses",
  nimContainer: null,
};

function createDeps(overrides: Partial<ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"]> = {}) {
  const calls = {
    setupNim: vi.fn(async () => ({ ...baseSelection })),
    setupInference: vi.fn(async () => ({ ok: true as const })),
    startStep: vi.fn(async () => undefined),
    complete: vi.fn(async () => createSession()),
    skipped: vi.fn(),
    recoverProvider: vi.fn(async (_provider: string | null | undefined, credentialEnv: string | null | undefined) => ({
      forceInferenceSetup: false,
      credentialEnv: credentialEnv ?? null,
    })),
    recordSkip: vi.fn(async () => createSession()),
    repairEvent: vi.fn(async () => createSession()),
    hydrate: vi.fn(),
    repair: vi.fn(),
    routeReady: vi.fn(() => false),
    reconcileRouter: vi.fn(async () => undefined),
    updateSandbox: vi.fn(),
    promptName: vi.fn(async () => "my-assistant"),
    promptYesNo: vi.fn(async () => true),
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    }),
    deleteEnv: vi.fn(),
  };
  return {
    calls,
    deps: {
      normalizeHermesAuthMethod: (value: string | null | undefined) => value ?? null,
      setupNim: calls.setupNim,
      setupInference: calls.setupInference,
      startRecordedStep: calls.startStep,
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      ensureResumeProviderReady: calls.recoverProvider,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      hydrateCredentialEnv: calls.hydrate,
      repairLocalInferenceSystemdOverrideOrExit: calls.repair,
      isNonInteractive: () => true,
      getOpenshellBinary: () => "/usr/bin/openshell",
      needsBedrockRuntimeAdapter: () => false,
      isInferenceRouteReady: calls.routeReady,
      isRoutedInferenceProvider: (provider: string) => provider === "nvidia-router",
      reconcileModelRouter: calls.reconcileRouter,
      registryUpdateSandbox: calls.updateSandbox,
      promptValidatedSandboxName: calls.promptName,
      assessHost: () => ({ cpus: 8 }),
      formatSandboxBuildEstimateNote: () => "estimate",
      formatOnboardConfigSummary: (options: {
        provider: string;
        model: string;
        sandboxName: string;
      }) => `summary:${options.provider}/${options.model}/${options.sandboxName}`,
      promptYesNoOrDefault: calls.promptYesNo,
      cliName: () => "nemoclaw",
      log: calls.log,
      error: calls.error,
      exitProcess: calls.exit,
      deleteEnv: calls.deleteEnv,
      ...overrides,
    },
  };
}

function baseOptions(
  deps: ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"],
  session: Session | null = createSession(),
): ProviderInferenceStateOptions<Gpu, Agent, Host> {
  return {
    resume: false,
    session,
    gpu: { type: "nvidia" },
    sandboxName: null,
    agent: null,
    initial: {
      model: session?.model ?? null,
      provider: session?.provider ?? null,
      endpointUrl: session?.endpointUrl ?? null,
      credentialEnv: session?.credentialEnv ?? null,
      hermesAuthMethod: session?.hermesAuthMethod ?? null,
      hermesToolGateways: session?.hermesToolGateways ?? [],
      preferredInferenceApi: session?.preferredInferenceApi ?? null,
      nimContainer: session?.nimContainer ?? null,
      webSearchConfig: session?.webSearchConfig ?? null,
    },
    selectedMessagingChannels: [],
    env: {},
    constants: {
      hermesProviderName: "hermes-provider",
      hermesApiKeyAuthMethod: "api_key",
      hermesApiKeyCredentialEnv: "NOUS_API_KEY",
    },
    deps,
  };
}

describe("handleProviderInferenceState", () => {
  it("runs provider selection and inference setup on a fresh flow", async () => {
    const { deps, calls } = createDeps();

    const result = await handleProviderInferenceState(baseOptions(deps));

    expect(calls.startStep).toHaveBeenNthCalledWith(1, "provider_selection");
    expect(calls.setupNim).toHaveBeenCalledWith({ type: "nvidia" }, null, null);
    expect(calls.complete).toHaveBeenCalledWith("provider_selection", expect.objectContaining({ provider: "nvidia-prod" }));
    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(calls.log).toHaveBeenCalledWith("summary:nvidia-prod/nvidia/test/my-assistant");
    expect(calls.startStep).toHaveBeenNthCalledWith(2, "inference", {
      provider: "nvidia-prod",
      model: "nvidia/test",
    });
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "nvidia/test",
      "nvidia-prod",
      "https://integrate.api.nvidia.com/v1",
      "NVIDIA_API_KEY",
      null,
      [],
    );
    expect(calls.deleteEnv).toHaveBeenCalledWith("NVIDIA_API_KEY");
    expect(result).toMatchObject({
      sandboxName: "my-assistant",
      model: "nvidia/test",
      provider: "nvidia-prod",
      preferredInferenceApi: "openai-responses",
    });
  });

  it("clears non-NVIDIA provider credentials when inference setup fails", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
    }));
    const setupInference = vi.fn(async () => {
      throw new Error("probe failed");
    });
    const { deps, calls } = createDeps({ setupNim, setupInference });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("probe failed");

    expect(calls.deleteEnv).toHaveBeenCalledWith("COMPATIBLE_API_KEY");
  });

  it("exits through the injected CLI boundary when provider selection is incomplete", async () => {
    const setupNim = vi.fn(async () => ({ ...baseSelection, model: null }));
    const { deps, calls } = createDeps({ setupNim });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith("  Inference selection did not yield a provider/model.");
    expect(calls.exit).toHaveBeenCalledWith(1);
    expect(calls.complete).not.toHaveBeenCalledWith("provider_selection", expect.anything());
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("clears provider credentials when inference step recording fails", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "compatible-endpoint",
      credentialEnv: "COMPATIBLE_API_KEY",
    }));
    const startRecordedStep = vi.fn(async (stepName: string) => {
      if (stepName === "inference") throw new Error("recording failed");
    });
    const { deps, calls } = createDeps({ setupNim, startRecordedStep });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("recording failed");

    expect(calls.deleteEnv).toHaveBeenCalledWith("COMPATIBLE_API_KEY");
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("skips provider selection and inference setup when resume state is already ready", async () => {
    const session = createSession({
      provider: "ollama-local",
      model: "llama3.1",
      credentialEnv: null,
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.recoverProvider).toHaveBeenCalledWith("ollama-local", null);
    expect(calls.skipped).toHaveBeenCalledWith("provider_selection", "ollama-local / llama3.1");
    expect(calls.recordSkip).toHaveBeenCalledWith("provider_selection", {
      reason: "resume",
      provider: "ollama-local",
      model: "llama3.1",
    });
    expect(calls.hydrate).toHaveBeenCalledWith(null);
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "provider_selection",
      metadata: { repair: "ollama-systemd-loopback" },
    });
    expect(calls.repair).toHaveBeenCalledWith("ollama-local", deps.isNonInteractive);
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
      state: "provider_selection",
      metadata: { repair: "ollama-systemd-loopback" },
    });
    expect(calls.skipped).toHaveBeenCalledWith("inference", "ollama-local / llama3.1");
    expect(calls.recordSkip).toHaveBeenCalledWith("inference", {
      reason: "resume",
      provider: "ollama-local",
      model: "llama3.1",
    });
    expect(result).toMatchObject({ provider: "ollama-local", model: "llama3.1" });
  });

  it("records failed Ollama repair events before propagating resume repair errors", async () => {
    const session = createSession({
      provider: "ollama-local",
      model: "llama3.1",
      credentialEnv: null,
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      repairLocalInferenceSystemdOverrideOrExit: vi.fn(() => {
        throw new Error("repair failed");
      }),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "my-assistant",
      }),
    ).rejects.toThrow("repair failed");

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "provider_selection",
      metadata: { repair: "ollama-systemd-loopback" },
    });
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.failed", {
      state: "provider_selection",
      error: "repair failed",
      metadata: { repair: "ollama-systemd-loopback" },
    });
    expect(calls.repairEvent).not.toHaveBeenCalledWith("state.repair.completed", expect.anything());
  });

  it("reruns inference setup when resumed provider recovery forces recreation", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "custom-model",
      credentialEnv: null,
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      ensureResumeProviderReady: vi.fn(async () => ({
        forceInferenceSetup: true,
        credentialEnv: "COMPATIBLE_API_KEY",
      })),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.hydrate).toHaveBeenCalledWith("COMPATIBLE_API_KEY");
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "custom-model",
      "compatible-endpoint",
      null,
      "COMPATIBLE_API_KEY",
      null,
      [],
    );
  });

  it("reconciles model router on resumed routed inference", async () => {
    const session = createSession({ provider: "nvidia-router", model: "router/model" });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "router-sandbox",
    });

    expect(calls.reconcileRouter).toHaveBeenCalledOnce();
  });

  it("returns to provider selection when inference setup requests a retry", async () => {
    const setupNim = vi
      .fn()
      .mockResolvedValueOnce({ ...baseSelection, model: "bad" })
      .mockResolvedValueOnce({ ...baseSelection, model: "good" });
    const setupInference = vi
      .fn()
      .mockResolvedValueOnce({ retry: "selection" as const })
      .mockResolvedValueOnce({ ok: true as const });
    const { deps, calls } = createDeps({ setupNim, setupInference });

    const result = await handleProviderInferenceState(baseOptions(deps));

    expect(setupNim).toHaveBeenCalledTimes(2);
    expect(setupInference).toHaveBeenCalledTimes(2);
    expect(result.model).toBe("good");
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection");
  });

  it("aborts before inference setup when the configuration summary is rejected", async () => {
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      promptYesNoOrDefault: vi.fn(async () => false),
    });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("exit 0");

    expect(calls.exit).toHaveBeenCalledWith(0);
    expect(calls.setupInference).not.toHaveBeenCalled();
  });
});
