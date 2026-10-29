// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  checkGatewayRouteCompatibility,
  type CurrentGatewayRouteCompatibilityCheck,
} from "../../../inference/gateway-route-compatibility";
import {
  LLAMA_CPP_CREDENTIAL_ENV,
  LLAMA_CPP_HOST_OPENAI_BASE_URL,
} from "../../../inference/llama-cpp/contract";
import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import { createProviderReviewDeps } from "../../setup-inference";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

describe("provider inference review recovery", () => {
  it("rejects configuration review with a non-zero exit before inference setup (#8686)", async () => {
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt: vi.fn(async () => "4"),
    });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.complete.mock.calls.some(([stepName]) => stepName === "provider_selection")).toBe(
      false,
    );
    expect(calls.checkpointSandboxIdentity).toHaveBeenCalledWith("my-assistant", null);
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/test",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
    expect(calls.rejected).toHaveBeenCalledWith("provider_selection");
    expect(calls.exit).toHaveBeenCalledWith(1);
    expect(calls.deleteEnv).toHaveBeenCalledWith(baseSelection.credentialEnv);
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("replaces an explicitly rejected review selection on no-TTY resume (#8686)", async () => {
    const session = createSession({
      sandboxName: "rejected-review",
      provider: "ollama-local",
      model: "qwen3.5:9b",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.provider_selection.status = "skipped";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => false) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "rejected-review",
    });

    expect(calls.setupNim).toHaveBeenCalled();
    expect(calls.setupInference).toHaveBeenCalled();
    expect(result).toMatchObject({ provider: "nvidia-prod", model: "nvidia/test" });
    expect(
      calls.setupInference.mock.calls.some(
        ([sandboxName, selectedModel, selectedProvider]) =>
          sandboxName === "rejected-review" &&
          selectedModel === "qwen3.5:9b" &&
          selectedProvider === "ollama-local",
      ),
    ).toBe(false);
  });

  it("checkpoints a prompted sandbox identity before interactive review (#8686)", async () => {
    const prompt = vi.fn(async () => "1");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt,
    });

    await handleProviderInferenceState(baseOptions(deps));

    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(calls.checkpointSandboxIdentity).toHaveBeenCalledWith("my-assistant", null);
    expect(prompt).toHaveBeenCalledOnce();
    expect(calls.checkpointSandboxIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0],
    );
    expect(calls.setupInference).toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({ provider: "nvidia-prod", model: "nvidia/test" }),
    );
    expect(calls.exit).not.toHaveBeenCalled();
  });

  it("reselects inference and clears its discarded staged credential before Apply (#6005)", async () => {
    const setupNim = vi
      .fn()
      .mockResolvedValueOnce({ ...baseSelection, credentialEnv: "FIRST_API_KEY" })
      .mockResolvedValueOnce({
        ...baseSelection,
        provider: "openai",
        model: "gpt-5",
        credentialEnv: "OPENAI_API_KEY",
      });
    const prompt = vi.fn().mockResolvedValueOnce("2").mockResolvedValueOnce("1");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt,
      setupNim,
    });

    const result = await handleProviderInferenceState(baseOptions(deps));

    expect(setupNim).toHaveBeenCalledTimes(2);
    expect(calls.deleteEnv).toHaveBeenCalledWith("FIRST_API_KEY");
    expect(calls.deleteEnv.mock.invocationCallOrder[0]).toBeLessThan(
      setupNim.mock.invocationCallOrder[1],
    );
    expect(calls.promptName).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "gpt-5",
      "openai",
      baseSelection.endpointUrl,
      "OPENAI_API_KEY",
      null,
      [],
      expect.any(Object),
    );
    expect(result).toMatchObject({
      sandboxName: "my-assistant",
      provider: "openai",
      model: "gpt-5",
    });
  });

  it("edits the sandbox name without reopening inference before Apply (#6005)", async () => {
    const promptValidatedSandboxName = vi
      .fn()
      .mockResolvedValueOnce("first-name")
      .mockResolvedValueOnce("edited-name");
    const prompt = vi.fn().mockResolvedValueOnce("3").mockResolvedValueOnce("1");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt,
      promptValidatedSandboxName,
    });

    const result = await handleProviderInferenceState(baseOptions(deps));

    expect(calls.setupNim).toHaveBeenCalledOnce();
    expect(promptValidatedSandboxName).toHaveBeenNthCalledWith(1, null);
    expect(promptValidatedSandboxName).toHaveBeenNthCalledWith(2, null, "first-name");
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(calls.setupInference).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "edited-name",
      baseSelection.model,
      baseSelection.provider,
      baseSelection.endpointUrl,
      baseSelection.credentialEnv,
      null,
      [],
      expect.any(Object),
    );
    expect(result.sandboxName).toBe("edited-name");
  });

  it("resumes an accepted selection after inference setup throws (#8687)", async () => {
    const session = createSession({ sandboxName: "accepted-review" });
    const setupInference = vi
      .fn()
      .mockRejectedValueOnce(new Error("inference setup failed"))
      .mockResolvedValueOnce({ ok: true as const });
    const { deps, calls } = createDeps({
      setupInference,
      isInferenceRouteReady: vi.fn(() => false),
      prompt: vi.fn(async () => "1"),
    });
    calls.complete.mockImplementation(async (...args: unknown[]) => {
      const stepName = args[0] as string;
      const updates = args[1] as SessionUpdates;
      Object.assign(session, updates);
      session.steps[stepName].status = "complete";
      return session;
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        sandboxName: "accepted-review",
      }),
    ).rejects.toThrow("inference setup failed");
    expect(session.steps.provider_selection.status).toBe("complete");
    expect(session.provider).toBe("nvidia-prod");

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "accepted-review",
    });

    expect(calls.setupNim).toHaveBeenCalledTimes(1);
    expect(setupInference).toHaveBeenCalledTimes(2);
  });

  it("checkpoints a supplied sandbox identity before review (#8687)", async () => {
    const prompt = vi.fn(async () => "4");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt,
    });

    await expect(
      handleProviderInferenceState({ ...baseOptions(deps), sandboxName: "supplied-review" }),
    ).rejects.toThrow("exit 1");

    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.checkpointSandboxIdentity).toHaveBeenCalledWith("supplied-review", null);
    expect(calls.checkpointSandboxIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      prompt.mock.invocationCallOrder[0],
    );
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/test",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
    expect(calls.resolveHostLocalInferenceStartupSelection).not.toHaveBeenCalled();
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
  });

  it("does not prepare the Ollama proxy after interactive review decline (#8687)", async () => {
    const startOllamaAuthProxy = vi.fn(() => true);
    const getOllamaProxyToken = vi.fn(() => "proxy-token");
    const persistAndProbeOllamaProxy = vi.fn(async () => undefined);
    const providerReviewDeps = createProviderReviewDeps(
      vi.fn(),
      vi.fn(async () => undefined),
      {
        shouldFrontOllamaWithProxy: () => true,
        startOllamaAuthProxy,
        getOllamaProxyToken,
        persistAndProbeOllamaProxy,
      },
      (code): never => {
        throw new Error(`exit ${code}`);
      },
      vi.fn(),
    );
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "ollama-local",
        model: "qwen3.5:9b",
        endpointUrl: "http://127.0.0.1:11435/v1",
        credentialEnv: null,
      })),
      prepareLocalProviderForInference: providerReviewDeps.prepareLocalProviderForInference,
      prompt: vi.fn(async () => "4"),
    });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "ollama-local",
      model: "qwen3.5:9b",
      endpointUrl: "http://127.0.0.1:11435/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-responses",
    });
    expect(calls.prepareLocalProviderForInference).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
    expect(startOllamaAuthProxy).not.toHaveBeenCalled();
    expect(getOllamaProxyToken).not.toHaveBeenCalled();
    expect(persistAndProbeOllamaProxy).not.toHaveBeenCalled();
  });

  it("prepares the Ollama proxy after review acceptance and before inference setup (#8687)", async () => {
    const prepareLocalProviderForInference = vi.fn(async () => "proxy-token");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      setupNim: vi.fn(async () => ({
        ...baseSelection,
        provider: "ollama-local",
        model: "qwen3.5:9b",
        endpointUrl: "http://127.0.0.1:11435/v1",
        credentialEnv: null,
      })),
      prepareLocalProviderForInference,
      prompt: vi.fn(async () => "1"),
    });

    await handleProviderInferenceState(baseOptions(deps));

    expect(prepareLocalProviderForInference).toHaveBeenCalledWith("ollama-local");
    expect(prepareLocalProviderForInference.mock.invocationCallOrder[0]).toBeLessThan(
      calls.setupInference.mock.invocationCallOrder[0],
    );
    expect(calls.setupInference).toHaveBeenCalledWith(
      "my-assistant",
      "qwen3.5:9b",
      "ollama-local",
      "http://127.0.0.1:11435/v1",
      null,
      null,
      [],
      expect.objectContaining({ preparedOllamaProxyToken: "proxy-token" }),
    );
  });

  it("skips configuration review in explicit non-interactive mode (#8687)", async () => {
    const prompt = vi.fn(async () => "1");
    const { deps, calls } = createDeps({ isNonInteractive: () => true, prompt });

    await handleProviderInferenceState(baseOptions(deps));

    expect(prompt).not.toHaveBeenCalled();
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/test",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
    expect(calls.setupInference).toHaveBeenCalled();
  });

  function failedReviewSession() {
    const session = createSession({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.provider_selection.status = "failed";
    return session;
  }

  it("prompts for review when interactive resume reuses an interrupted selection (#8687)", async () => {
    const session = failedReviewSession();
    const prompt = vi.fn(async () => "1");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt,
      isInferenceRouteReady: vi.fn(() => false),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "review-interrupted",
      "qwen3.5:9b",
      "ollama-local",
      "http://host.openshell.internal:11435/v1",
      null,
      null,
      [],
      expect.any(Object),
    );
  });

  it("bypasses review when non-interactive resume reuses an interrupted selection (#8687)", async () => {
    const session = failedReviewSession();
    const prompt = vi.fn(async () => "1");
    const { deps, calls } = createDeps({
      isNonInteractive: () => true,
      prompt,
      isInferenceRouteReady: vi.fn(() => false),
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "review-interrupted",
      "qwen3.5:9b",
      "ollama-local",
      "http://host.openshell.internal:11435/v1",
      null,
      null,
      [],
      expect.any(Object),
    );
    expect(result).toMatchObject({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
    });
  });

  describe("compatible-endpoint route metadata (#13654)", () => {
    const compatibleSelection = {
      ...baseSelection,
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "COMPATIBLE_API_KEY",
      preferredInferenceApi: "openai-completions",
    };

    function interruptedCompatibleSession(
      route: { endpointUrl: string | null; preferredInferenceApi: string | null } = {
        endpointUrl: compatibleSelection.endpointUrl,
        preferredInferenceApi: compatibleSelection.preferredInferenceApi,
      },
    ) {
      const session = createSession({
        sandboxName: "dcode-resume",
        provider: compatibleSelection.provider,
        model: compatibleSelection.model,
        endpointUrl: route.endpointUrl,
        credentialEnv: route.endpointUrl ? compatibleSelection.credentialEnv : null,
        preferredInferenceApi: route.preferredInferenceApi,
        sandboxPromptProgress: {
          sandboxName: true,
          webSearch: false,
          messaging: false,
          resourceProfile: false,
        },
      });
      session.steps.provider_selection.status = "failed";
      return session;
    }

    // The real check with no other registered sandbox: the only way to fail
    // is a requested custom route without endpoint or API-family metadata.
    const checkRouteOnEmptyGateway = vi.fn<CurrentGatewayRouteCompatibilityCheck>((request) =>
      checkGatewayRouteCompatibility({ ...request, sandboxes: [] }),
    );

    it("checkpoints the endpoint, API family, and credential name before review", async () => {
      const prompt = vi.fn(async (): Promise<string> => {
        throw new Error("interrupted at review");
      });
      const { deps, calls } = createDeps({
        isNonInteractive: () => false,
        setupNim: vi.fn(async () => ({ ...compatibleSelection })),
        prompt,
      });

      await expect(
        handleProviderInferenceState({ ...baseOptions(deps), sandboxName: "dcode-resume" }),
      ).rejects.toThrow("interrupted at review");

      expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
        provider: "compatible-endpoint",
        model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      });
      expect(calls.startStep.mock.invocationCallOrder.at(-1)).toBeLessThan(
        prompt.mock.invocationCallOrder[0],
      );
      expect(calls.setupInference).not.toHaveBeenCalled();
    });

    it("shows the review again on interactive resume of the interrupted selection", async () => {
      const prompt = vi.fn(async () => "1");
      const { deps, calls } = createDeps({
        isNonInteractive: () => false,
        prompt,
        checkGatewayRouteCompatibility: checkRouteOnEmptyGateway,
        isInferenceRouteReady: vi.fn(() => false),
      });

      await handleProviderInferenceState({
        ...baseOptions(deps, interruptedCompatibleSession()),
        resume: true,
        sandboxName: "dcode-resume",
      });

      expect(checkRouteOnEmptyGateway).toHaveBeenCalledWith(
        expect.objectContaining({
          route: expect.objectContaining({
            provider: "compatible-endpoint",
            endpointUrl: "https://integrate.api.nvidia.com/v1",
            credentialEnv: "COMPATIBLE_API_KEY",
            preferredInferenceApi: "openai-completions",
          }),
        }),
      );
      expect(calls.exit).not.toHaveBeenCalled();
      expect(calls.setupNim).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledOnce();
      expect(calls.setupInference).toHaveBeenCalledWith(
        "dcode-resume",
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "compatible-endpoint",
        "https://integrate.api.nvidia.com/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        expect.any(Object),
      );
    });

    it("continues to inference setup on non-interactive resume of the interrupted selection", async () => {
      const prompt = vi.fn(async () => "1");
      const { deps, calls } = createDeps({
        isNonInteractive: () => true,
        prompt,
        checkGatewayRouteCompatibility: checkRouteOnEmptyGateway,
        isInferenceRouteReady: vi.fn(() => false),
      });

      await handleProviderInferenceState({
        ...baseOptions(deps, interruptedCompatibleSession()),
        resume: true,
        sandboxName: "dcode-resume",
      });

      expect(calls.exit).not.toHaveBeenCalled();
      expect(prompt).not.toHaveBeenCalled();
      expect(calls.setupInference).toHaveBeenCalledWith(
        "dcode-resume",
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "compatible-endpoint",
        "https://integrate.api.nvidia.com/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        expect.any(Object),
      );
    });

    it("asks for the provider again when an earlier release saved no route metadata", async () => {
      const prompt = vi.fn(async () => "1");
      const setupNim = vi.fn(async () => ({ ...compatibleSelection }));
      const { deps, calls } = createDeps({
        isNonInteractive: () => false,
        prompt,
        setupNim,
        checkGatewayRouteCompatibility: checkRouteOnEmptyGateway,
        isInferenceRouteReady: vi.fn(() => false),
      });

      await handleProviderInferenceState({
        ...baseOptions(
          deps,
          interruptedCompatibleSession({ endpointUrl: null, preferredInferenceApi: null }),
        ),
        resume: true,
        sandboxName: "dcode-resume",
      });

      expect(calls.exit).not.toHaveBeenCalled();
      expect(setupNim).toHaveBeenCalledOnce();
      expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
        provider: "compatible-endpoint",
        model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      });
      expect(calls.startStep.mock.invocationCallOrder.at(-1)).toBeLessThan(
        calls.setupInference.mock.invocationCallOrder[0],
      );
      expect(calls.setupInference).toHaveBeenCalledWith(
        "dcode-resume",
        "nvidia/nemotron-3.5-super-vl-120b-a12b",
        "compatible-endpoint",
        "https://integrate.api.nvidia.com/v1",
        "COMPATIBLE_API_KEY",
        null,
        [],
        expect.any(Object),
      );
    });

    it("still refuses a non-interactive resume of a session saved without that metadata", async () => {
      const prompt = vi.fn(async () => "1");
      const { deps, calls } = createDeps({
        isNonInteractive: () => true,
        prompt,
        checkGatewayRouteCompatibility: checkRouteOnEmptyGateway,
      });

      await expect(
        handleProviderInferenceState({
          ...baseOptions(
            deps,
            interruptedCompatibleSession({ endpointUrl: null, preferredInferenceApi: null }),
          ),
          resume: true,
          sandboxName: "dcode-resume",
        }),
      ).rejects.toThrow("exit 1");

      expect(prompt).not.toHaveBeenCalled();
      expect(calls.setupInference).not.toHaveBeenCalled();
    });
  });

  describe("compatible-anthropic-endpoint route metadata (#13654)", () => {
    const anthropicRoute = {
      provider: "compatible-anthropic-endpoint",
      model: "claude-sonnet-proxy",
      endpointUrl: "https://anthropic-proxy.example.test",
      credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
      preferredInferenceApi: "anthropic-messages",
    };
    const checkRouteOnEmptyGateway = vi.fn<CurrentGatewayRouteCompatibilityCheck>((request) =>
      checkGatewayRouteCompatibility({ ...request, sandboxes: [] }),
    );

    it("checkpoints the endpoint, API family, and credential name before review", async () => {
      const prompt = vi.fn(async (): Promise<string> => {
        throw new Error("interrupted at review");
      });
      const { deps, calls } = createDeps({
        isNonInteractive: () => false,
        setupNim: vi.fn(async () => ({ ...baseSelection, ...anthropicRoute })),
        prompt,
      });

      await expect(
        handleProviderInferenceState({ ...baseOptions(deps), sandboxName: "anthropic-resume" }),
      ).rejects.toThrow("interrupted at review");

      expect(calls.startStep).toHaveBeenCalledWith("provider_selection", anthropicRoute);
      expect(calls.setupInference).not.toHaveBeenCalled();
    });

    it("shows the review again on interactive resume of the interrupted selection", async () => {
      const prompt = vi.fn(async () => "1");
      const { deps, calls } = createDeps({
        isNonInteractive: () => false,
        prompt,
        checkGatewayRouteCompatibility: checkRouteOnEmptyGateway,
        isInferenceRouteReady: vi.fn(() => false),
      });
      const session = createSession({
        sandboxName: "anthropic-resume",
        ...anthropicRoute,
        sandboxPromptProgress: {
          sandboxName: true,
          webSearch: false,
          messaging: false,
          resourceProfile: false,
        },
      });
      session.steps.provider_selection.status = "failed";

      await handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "anthropic-resume",
      });

      expect(checkRouteOnEmptyGateway).toHaveBeenCalledWith(
        expect.objectContaining({ route: expect.objectContaining(anthropicRoute) }),
      );
      expect(calls.exit).not.toHaveBeenCalled();
      expect(prompt).toHaveBeenCalledOnce();
      expect(calls.setupInference).toHaveBeenCalledWith(
        "anthropic-resume",
        anthropicRoute.model,
        anthropicRoute.provider,
        anthropicRoute.endpointUrl,
        anthropicRoute.credentialEnv,
        null,
        [],
        expect.any(Object),
      );
    });
  });

  // llama-cpp-local is native local inference for OpenClaw, so resume uses
  // the native discovery preflight, not the shared custom-route check.
  it("checkpoints llama-cpp-local route metadata and resumes through the native preflight (#13654)", async () => {
    const llamaRoute = {
      provider: "llama-cpp-local",
      model: "local-gguf",
      endpointUrl: LLAMA_CPP_HOST_OPENAI_BASE_URL,
      credentialEnv: LLAMA_CPP_CREDENTIAL_ENV,
      preferredInferenceApi: "openai-completions",
    };
    const interrupted = createDeps({
      isNonInteractive: () => false,
      setupNim: vi.fn(async () => ({ ...baseSelection, ...llamaRoute })),
      prompt: vi.fn(async (): Promise<string> => {
        throw new Error("interrupted at review");
      }),
    });
    await expect(
      handleProviderInferenceState({
        ...baseOptions(interrupted.deps),
        sandboxName: "llama-resume",
      }),
    ).rejects.toThrow("interrupted at review");
    expect(interrupted.calls.startStep).toHaveBeenCalledWith("provider_selection", llamaRoute);

    const prompt = vi.fn(async () => "1");
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt,
      isInferenceRouteReady: vi.fn(() => false),
    });
    const session = createSession({
      sandboxName: "llama-resume",
      ...llamaRoute,
      sandboxPromptProgress: {
        sandboxName: true,
        webSearch: false,
        messaging: false,
        resourceProfile: false,
      },
    });
    session.steps.provider_selection.status = "failed";

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "llama-resume",
    });

    expect(calls.preflightGatewayRouteDiscovery).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining(llamaRoute),
        nativeLocalSelection: true,
      }),
    );
    expect(calls.exit).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("stops a non-interactive resume of an earlier-release checkpoint with no host-local endpoint", async () => {
    const session = failedReviewSession();
    session.endpointUrl = null;
    const setupNim = vi.fn(async () => ({ ...baseSelection }));
    const { deps, calls } = createDeps({
      isNonInteractive: () => true,
      setupNim,
      isInferenceRouteReady: vi.fn(() => false),
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "review-interrupted",
      }),
    ).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("without the ollama-local endpoint"),
    );
    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("onboard --fresh"));
    expect(setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
  });

  it("selects again on an interactive resume of an earlier-release checkpoint with no host-local endpoint", async () => {
    const session = failedReviewSession();
    session.endpointUrl = null;
    const setupNim = vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "qwen3.5:9b",
      endpointUrl: "http://host.openshell.internal:11435/v1",
      credentialEnv: null,
    }));
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt: vi.fn(async () => "1"),
      setupNim,
      isInferenceRouteReady: vi.fn(() => false),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
    });

    expect(calls.exit).not.toHaveBeenCalled();
    expect(setupNim).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "review-interrupted",
      "qwen3.5:9b",
      "ollama-local",
      "http://host.openshell.internal:11435/v1",
      null,
      null,
      [],
      expect.any(Object),
    );
  });

  it("runs inference setup after an endpointless review is reselected to an already ready cloud route", async () => {
    const session = failedReviewSession();
    session.endpointUrl = null;
    const setupNim = vi.fn(async () => ({ ...baseSelection }));
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      prompt: vi.fn(async () => "1"),
      setupNim,
      isInferenceRouteReady: vi.fn(() => true),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
    });

    expect(setupNim).toHaveBeenCalledOnce();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "review-interrupted",
      baseSelection.model,
      baseSelection.provider,
      baseSelection.endpointUrl,
      baseSelection.credentialEnv,
      null,
      [],
      expect.any(Object),
    );
  });
});
