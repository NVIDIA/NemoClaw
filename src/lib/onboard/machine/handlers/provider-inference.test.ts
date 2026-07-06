// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session, type SessionUpdates } from "../../../state/onboard-session";
import { patchStagedDockerfile } from "../../dockerfile-patch";
import { clearCompatibleEndpointReasoning } from "../../reasoning-mode";
import {
  handleProviderInferenceState,
  type ProviderInferenceStateOptions,
  type ProviderSelectionResult,
} from "./provider-inference";

type Gpu = { type: string } | null;
type Agent = { name: string; inference?: { provider_type?: string } } | null;
type Host = { cpus?: number };

const baseSelection: ProviderSelectionResult = {
  model: "nvidia/test",
  provider: "nvidia-prod",
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  hermesAuthMethod: null,
  hermesToolGateways: [],
  preferredInferenceApi: "openai-responses",
  compatibleEndpointReasoning: null,
  nimContainer: null,
};

function createDeps(
  overrides: Partial<ProviderInferenceStateOptions<Gpu, Agent, Host>["deps"]> = {},
) {
  const calls = {
    setupNim: vi.fn(async () => ({ ...baseSelection })),
    setupInference: vi.fn(async () => ({ ok: true as const })),
    startStep: vi.fn(async () => undefined),
    complete: vi.fn(async () => createSession()),
    skipped: vi.fn(),
    recoverProvider: vi.fn(
      async (_provider: string | null | undefined, credentialEnv: string | null | undefined) => ({
        forceInferenceSetup: false,
        credentialEnv: credentialEnv ?? null,
      }),
    ),
    surfaceReady: vi.fn(() => true),
    recordSkip: vi.fn(async () => createSession()),
    repairEvent: vi.fn(async () => createSession()),
    hydrate: vi.fn(),
    repair: vi.fn(),
    routeReady: vi.fn(() => false),
    reconcileRouter: vi.fn(async () => undefined),
    reupsertRoutedProvider: vi.fn(
      (_provider: string, endpointUrl: string | null, _credentialEnv: string | null) => ({
        ok: true as const,
        endpointUrl: "http://host.openshell.internal:4000/v1",
      }),
    ),
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
      normalizeHermesAuthMethod: (value: string | null | undefined) =>
        value === "oauth" || value === "api_key" ? value : null,
      setupNim: calls.setupNim,
      setupInference: calls.setupInference,
      startRecordedStep: calls.startStep,
      recordStepComplete: calls.complete,
      toSessionUpdates: (updates: Record<string, unknown>) => updates as SessionUpdates,
      skippedStepMessage: calls.skipped,
      ensureResumeProviderReady: calls.recoverProvider,
      isResumeProviderSurfaceReady: calls.surfaceReady,
      recordStateSkipped: calls.recordSkip,
      recordRepairEvent: calls.repairEvent,
      hydrateCredentialEnv: calls.hydrate,
      configureCompatibleEndpointReasoning: async (value?: string | null) =>
        value === "true" ? "true" : "false",
      clearCompatibleEndpointReasoning: () => null,
      repairLocalInferenceSystemdOverrideOrExit: calls.repair,
      isNonInteractive: () => true,
      getOpenshellBinary: () => "/usr/bin/openshell",
      needsBedrockRuntimeAdapter: () => false,
      isInferenceRouteReady: calls.routeReady,
      isRoutedInferenceProvider: (provider: string) => provider === "nvidia-router",
      reconcileModelRouter: calls.reconcileRouter,
      reupsertRoutedProvider: calls.reupsertRoutedProvider,
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
    fresh: false,
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
      compatibleEndpointReasoning: session?.compatibleEndpointReasoning ?? null,
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
    expect(calls.setupNim).toHaveBeenCalledWith({ type: "nvidia" }, null, null, true);
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
      "NVIDIA_INFERENCE_API_KEY",
      null,
      [],
      { allowToolsIncompatible: false, preferredInferenceApi: "openai-responses" },
    );
    expect(calls.deleteEnv).toHaveBeenCalledWith("NVIDIA_INFERENCE_API_KEY");
    expect(result).toMatchObject({
      sandboxName: "my-assistant",
      model: "nvidia/test",
      provider: "nvidia-prod",
      preferredInferenceApi: "openai-responses",
      compatibleEndpointReasoning: null,
    });
    expect(result.stateResult).toEqual({
      type: "transition",
      next: "sandbox",
      transitionKind: "advance",
      updates: undefined,
      metadata: { state: "inference", provider: "nvidia-prod", model: "nvidia/test" },
    });
    expect(result.retryStateResults).toEqual([]);
    expect(result.stateResults).toEqual([
      {
        type: "transition",
        next: "inference",
        transitionKind: "advance",
        updates: undefined,
        metadata: { state: "provider_selection", provider: "nvidia-prod", model: "nvidia/test" },
      },
      result.stateResult,
    ]);
  });

  it("uses the managed OpenAI frontend for fresh Hermes custom Anthropic routes (#6289)", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "compatible-anthropic-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-v3",
      endpointUrl: "https://inference-api.nvidia.com",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    }));
    const { deps, calls } = createDeps({ setupNim });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps),
      agent: { name: "hermes" },
      sandboxName: "hermes-custom",
    });

    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({
        provider: "compatible-anthropic-endpoint",
        endpointUrl: "https://inference-api.nvidia.com",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "hermes-custom",
      "nvidia/nvidia/nemotron-3-super-v3",
      "compatible-anthropic-endpoint",
      "https://inference-api.nvidia.com",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      null,
      [],
      { allowToolsIncompatible: false, preferredInferenceApi: "openai-completions" },
    );
    expect(result.preferredInferenceApi).toBe("openai-completions");
  });

  it("repairs recovered Hermes custom Anthropic API metadata during rebuild (#6289)", async () => {
    const session = createSession({
      agent: "hermes",
      sandboxName: "hermes-custom",
      provider: "compatible-anthropic-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-v3",
      endpointUrl: "https://inference-api.nvidia.com",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    });
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      agent: { name: "hermes" },
      sandboxName: "hermes-custom",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({ preferredInferenceApi: "anthropic-messages" }),
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "hermes-custom",
      "nvidia/nvidia/nemotron-3-super-v3",
      "compatible-anthropic-endpoint",
      "https://inference-api.nvidia.com",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      null,
      [],
      { allowToolsIncompatible: false, preferredInferenceApi: "openai-completions" },
    );
    expect(calls.complete).toHaveBeenCalledWith(
      "inference",
      expect.objectContaining({ preferredInferenceApi: "openai-completions" }),
    );
    expect(result.preferredInferenceApi).toBe("openai-completions");
  });

  it("repairs a stale live provider even when Hermes metadata already says OpenAI (#6289)", async () => {
    const session = createSession({
      agent: "hermes",
      sandboxName: "hermes-custom",
      provider: "compatible-anthropic-endpoint",
      model: "nvidia/nvidia/nemotron-3-super-v3",
      endpointUrl: "https://inference-api.nvidia.com",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      isResumeProviderSurfaceReady: vi.fn(() => false),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      agent: { name: "hermes" },
      sandboxName: "hermes-custom",
    });

    expect(calls.log).toHaveBeenCalledWith(
      "  [resume] Refreshing the gateway provider to match the required inference surface.",
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "hermes-custom",
      "nvidia/nvidia/nemotron-3-super-v3",
      "compatible-anthropic-endpoint",
      "https://inference-api.nvidia.com",
      "COMPATIBLE_ANTHROPIC_API_KEY",
      null,
      [],
      { allowToolsIncompatible: false, preferredInferenceApi: "openai-completions" },
    );
  });

  describe("compatible endpoint reasoning mode", () => {
    it("records reasoning state during provider selection", async () => {
      const setupNim = vi.fn(async () => ({
        ...baseSelection,
        compatibleEndpointReasoning: "true",
        provider: "compatible-endpoint",
        credentialEnv: "COMPATIBLE_API_KEY",
      }));
      const { deps } = createDeps({ setupNim });

      const result = await handleProviderInferenceState({
        ...baseOptions(deps),
        env: { NEMOCLAW_REASONING: "true" },
      });

      expect(result).toMatchObject({
        compatibleEndpointReasoning: "true",
        provider: "compatible-endpoint",
      });
    });

    it("clears stale resumed state before writing a non-compatible artifact", async () => {
      vi.stubEnv("NEMOCLAW_REASONING", "true");
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-reasoning-resume-"));
      const dockerfilePath = path.join(tempDir, "Dockerfile");
      fs.writeFileSync(dockerfilePath, "ARG NEMOCLAW_REASONING=false\n");
      const session = createSession({
        provider: "nvidia-prod",
        model: "nvidia/test",
        compatibleEndpointReasoning: "true",
      });
      session.steps.provider_selection.status = "complete";
      const setupInference = vi.fn(async () => {
        expect(process.env.NEMOCLAW_REASONING).toBeUndefined();
        patchStagedDockerfile(
          dockerfilePath,
          "nvidia/test",
          "https://chat.example",
          "build-1",
          "nvidia-prod",
        );
        return { ok: true as const };
      });
      const { deps } = createDeps({
        clearCompatibleEndpointReasoning,
        setupInference,
        isInferenceRouteReady: vi.fn(() => false),
      });

      try {
        const result = await handleProviderInferenceState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName: "my-assistant",
        });

        expect(setupInference).toHaveBeenCalledOnce();
        expect(result.compatibleEndpointReasoning).toBeNull();
        expect(fs.readFileSync(dockerfilePath, "utf-8")).toContain("ARG NEMOCLAW_REASONING=false");
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it("disables recorded provider recovery during fresh provider selection", async () => {
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps),
      fresh: true,
      sandboxName: "dcode-station",
    });

    expect(calls.setupNim).toHaveBeenCalledWith({ type: "nvidia" }, "dcode-station", null, false);
  });

  it("does not use resume shortcuts when fresh is also set", async () => {
    const session = createSession({ provider: "ollama-local", model: "llama3.1" });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      fresh: true,
      sandboxName: "dcode-station",
    });

    expect(calls.recoverProvider).not.toHaveBeenCalled();
    expect(calls.skipped).not.toHaveBeenCalledWith("provider_selection", expect.anything());
    expect(calls.setupNim).toHaveBeenCalledWith({ type: "nvidia" }, "dcode-station", null, false);
    expect(calls.setupInference).toHaveBeenCalled();
  });

  it("uses a preflighted authoritative rebuild selection despite an incomplete old step marker", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "mock/mcp-bridge",
      endpointUrl: "https://compatible.example.test/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      authoritativeResumeConfig: true,
      sandboxName: "mcp-rebuild",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.recoverProvider).toHaveBeenCalledWith("compatible-endpoint", "COMPATIBLE_API_KEY");
    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "mock/mcp-bridge",
        endpointUrl: "https://compatible.example.test/v1",
      }),
    );
    expect(result).toMatchObject({
      provider: "compatible-endpoint",
      model: "mock/mcp-bridge",
      endpointUrl: "https://compatible.example.test/v1",
      preferredInferenceApi: "openai-completions",
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

    expect(calls.error).toHaveBeenCalledWith(
      "  Inference selection did not yield a provider/model.",
    );
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

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow(
      "recording failed",
    );

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

  it("coerces a resumed anthropic-messages seed for an OpenAI-only agent (#6294)", async () => {
    const session = createSession({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: {
        name: "langchain-deepagents-code",
        inference: { provider_type: "openai_compatible" },
      },
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      preferredInferenceApi: "openai-completions",
    });
    // Heal: the coerced seed forces inference setup so the gateway provider
    // registration is refreshed for the OpenAI surface.
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "claude-sonnet-proxy",
      "compatible-anthropic-endpoint",
      null,
      "COMPATIBLE_ANTHROPIC_API_KEY",
      null,
      [],
      expect.objectContaining({ preferredInferenceApi: "openai-completions" }),
    );
    // The coerced value is persisted only after the setup succeeded, with the
    // inference step record — never with a pre-setup provider_selection write
    // that would disarm the heal if the first attempt failed.
    expect(calls.complete).not.toHaveBeenCalledWith("provider_selection", expect.anything());
    expect(calls.complete).toHaveBeenCalledWith(
      "inference",
      expect.objectContaining({ preferredInferenceApi: "openai-completions" }),
    );
  });

  it("re-arms the heal when the forced inference setup does not complete (#6294)", async () => {
    const session = createSession({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    });
    session.steps.provider_selection.status = "complete";
    const setupInference = vi
      .fn()
      .mockResolvedValueOnce({ retry: "selection" as const })
      .mockResolvedValue({ ok: true as const });
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      setupInference,
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: {
        name: "langchain-deepagents-code",
        inference: { provider_type: "openai_compatible" },
      },
    });

    // The failed heal must not persist the coerced value anywhere, so the
    // next resume sees the stale seed and forces the heal again.
    expect(calls.complete).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ preferredInferenceApi: "openai-completions" }),
    );
    // The retry falls back to provider selection (setupNim ran).
    expect(result.retryStateResults.length).toBeGreaterThan(0);
  });

  it("keeps a resumed anthropic-messages seed for agents that speak Anthropic natively", async () => {
    const session = createSession({
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: { name: "openclaw", inference: { provider_type: "gateway_managed" } },
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      preferredInferenceApi: "anthropic-messages",
    });
    // Unchanged seed keeps the plain-resume shortcut: no re-record, no forced
    // inference setup.
    expect(calls.complete).not.toHaveBeenCalledWith("provider_selection", expect.anything());
    expect(calls.setupInference).not.toHaveBeenCalled();
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
      { allowToolsIncompatible: false },
    );
  });

  it("refreshes compatible-endpoint route directly when the host credential is available", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      hydrateCredentialEnv: vi.fn(() => "host-key"),
      isInferenceRouteReady: vi.fn(() => true),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.skipped).not.toHaveBeenCalledWith(
      "inference",
      "compatible-endpoint / nvidia/nemotron",
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "nvidia/nemotron",
      "compatible-endpoint",
      "https://integrate.api.nvidia.com/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      { allowToolsIncompatible: false },
    );
    expect(calls.log).toHaveBeenCalledWith(
      "  [resume] Refreshing compatible-endpoint inference route for messaging.",
    );
  });

  it("revalidates recovered identity before reusing a gateway credential on messaging resume", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      messagingPlan: {
        schemaVersion: 1,
        sandboxName: "my-assistant",
        agent: "openclaw",
        workflow: "rebuild",
        channels: [
          {
            channelId: "telegram",
            displayName: "Telegram",
            authMode: "token-paste",
            active: true,
            selected: true,
            configured: true,
            disabled: false,
            inputs: [],
            hooks: [],
          },
        ],
        disabledChannels: [],
        credentialBindings: [],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      },
    });
    session.steps.provider_selection.status = "complete";
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      model: "nvidia/nemotron",
      provider: "compatible-endpoint",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    }));
    const { deps, calls } = createDeps({
      setupNim,
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(setupNim).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "nvidia/nemotron",
      "compatible-endpoint",
      "https://integrate.api.nvidia.com/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      {
        allowToolsIncompatible: false,
        skipHostInferenceSmoke: true,
        reuseGatewayCredentialWithoutLocalKey: true,
        preferredInferenceApi: "openai-completions",
      },
    );
    expect(calls.log).toHaveBeenCalledWith(
      "  [resume] Revalidating recovered compatible-endpoint identity before reusing its gateway credential.",
    );
  });

  it("keeps the compatible-endpoint resume shortcut when no messaging channels are selected", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
    });

    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith(
      "inference",
      "compatible-endpoint / nvidia/nemotron",
    );
  });

  it("keeps the compatible-endpoint resume shortcut for Hermes messaging", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      hydrateCredentialEnv: vi.fn(() => null),
      isInferenceRouteReady: vi.fn(() => true),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      agent: { name: "hermes" },
      selectedMessagingChannels: ["slack"],
    });

    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith(
      "inference",
      "compatible-endpoint / nvidia/nemotron",
    );
  });

  it("runs compatible-endpoint route refresh with host smoke when the credential is locally hydrated", async () => {
    const session = createSession({
      provider: "compatible-endpoint",
      model: "nvidia/nemotron",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      hydrateCredentialEnv: vi.fn(() => "nvapi-test"),
      isInferenceRouteReady: vi.fn(() => true),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "my-assistant",
      selectedMessagingChannels: ["telegram"],
    });

    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "nvidia/nemotron",
      "compatible-endpoint",
      "https://integrate.api.nvidia.com/v1",
      "COMPATIBLE_API_KEY",
      null,
      [],
      { allowToolsIncompatible: false },
    );
    expect(calls.log).toHaveBeenCalledWith(
      "  [resume] Refreshing compatible-endpoint inference route for messaging.",
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

  // #5974 instance 5: the Model Router Python preflight (`prepareModelRouterVenv`)
  // throws a plain Error (e.g. "above supported ceiling", with no `oclif.exit`)
  // out of `reconcileModelRouter`. The routed branch must catch that throw and
  // exit non-zero via `exitProcess(1)` so onboard reports the failure to `$?`,
  // rather than the throw being swallowed or riding the oclif runner. The error
  // reasons themselves are locked by `model-router-python.test.ts`.
  it("exits non-zero when model router reconciliation throws (#5974)", async () => {
    const session = createSession({ provider: "nvidia-router", model: "router/model" });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      reconcileModelRouter: vi.fn(async () => {
        throw new Error("version 3.14.0 above supported ceiling 3.14.0 (exclusive)");
      }),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "router-sandbox",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.exit).toHaveBeenCalledWith(1);
    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to reconcile model router"),
    );
  });

  // Regression: #4564. On resume the routed provider was only reconciled, never
  // re-upserted, so a stale localhost base URL recorded by an earlier run could
  // survive in the gateway and break inference.local from the sandbox.
  it("re-upserts the routed provider with the host alias on resume (#4564)", async () => {
    const session = createSession({
      provider: "nvidia-router",
      model: "router/model",
      endpointUrl: "http://localhost:4000/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "router-sandbox",
    });

    expect(calls.reconcileRouter).toHaveBeenCalledOnce();
    expect(calls.reupsertRoutedProvider).toHaveBeenCalledWith(
      "nvidia-router",
      "http://localhost:4000/v1",
      "NVIDIA_INFERENCE_API_KEY",
    );
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(result.endpointUrl).toBe("http://host.openshell.internal:4000/v1");
  });

  it("aborts resume when re-upserting the routed provider fails (#4564)", async () => {
    const session = createSession({
      provider: "nvidia-router",
      model: "router/model",
      endpointUrl: "http://localhost:4000/v1",
    });
    session.steps.provider_selection.status = "complete";
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      reupsertRoutedProvider: vi.fn(() => ({
        ok: false,
        endpointUrl: "http://host.openshell.internal:4000/v1",
        message: "provider update failed",
        status: 7,
      })),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "router-sandbox",
      }),
    ).rejects.toThrow("exit 7");

    expect(calls.error).toHaveBeenCalledWith("  provider update failed");
    expect(calls.exit).toHaveBeenCalledWith(7);
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
    expect(result.retryStateResults).toEqual([
      {
        type: "transition",
        next: "provider_selection",
        transitionKind: "retry",
        updates: undefined,
        metadata: {
          state: "inference",
          provider: "nvidia-prod",
          model: "bad",
          reason: "selection_retry",
        },
      },
    ]);
    expect(result.stateResult).toMatchObject({ next: "sandbox", transitionKind: "advance" });
    expect(
      result.stateResults.map((stateResult) => [stateResult.next, stateResult.transitionKind]),
    ).toEqual([
      ["inference", "advance"],
      ["provider_selection", "retry"],
      ["inference", "advance"],
      ["sandbox", "advance"],
    ]);
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

  // Regression: #4241. When the provider selection step accepted a no-tools
  // Ollama model (the user answered "yes" to the override prompt or
  // NEMOCLAW_OLLAMA_REQUIRE_TOOLS=0 was set), the same flag must reach
  // setupInference so the second validateOllamaModel pass does not reject the
  // model on the same condition and bounce the user back to model selection.
  it("forwards allowToolsIncompatible from provider selection into setupInference (#4241)", async () => {
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "tinyllama:1.1b",
      endpointUrl: "http://127.0.0.1:11434/v1",
      credentialEnv: null,
      allowToolsIncompatible: true,
    }));
    const { deps, calls } = createDeps({ setupNim });

    await handleProviderInferenceState(baseOptions(deps));

    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "tinyllama:1.1b",
      "ollama-local",
      "http://127.0.0.1:11434/v1",
      null,
      null,
      [],
      { allowToolsIncompatible: true, preferredInferenceApi: "openai-responses" },
    );
  });
});
