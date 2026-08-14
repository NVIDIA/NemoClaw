// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type SessionUpdates } from "../../../state/onboard-session";
import { createProviderReviewDeps } from "../../setup-inference";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, baseSelection, createDeps } from "./provider-inference.test-support";

describe("provider inference review recovery", () => {
  it("rejects configuration review with a non-zero exit before inference setup (#8686)", async () => {
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      promptYesNoOrDefault: vi.fn(async () => false),
    });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.complete.mock.calls.some(([stepName]) => stepName === "provider_selection")).toBe(
      false,
    );
    expect(calls.checkpointSandboxIdentity).toHaveBeenCalledWith("my-assistant", null);
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/test",
    });
    expect(calls.rejected).toHaveBeenCalledWith("provider_selection");
    expect(calls.exit).toHaveBeenCalledWith(1);
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
    const promptYesNoOrDefault = vi.fn(async () => true);
    const { deps, calls } = createDeps({ isNonInteractive: () => false, promptYesNoOrDefault });

    await handleProviderInferenceState(baseOptions(deps));

    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(calls.checkpointSandboxIdentity).toHaveBeenCalledWith("my-assistant", null);
    expect(promptYesNoOrDefault).toHaveBeenCalledWith("  Apply this configuration?", null, true);
    expect(calls.checkpointSandboxIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      promptYesNoOrDefault.mock.invocationCallOrder[0],
    );
    expect(calls.setupInference).toHaveBeenCalled();
    expect(calls.complete).toHaveBeenCalledWith(
      "provider_selection",
      expect.objectContaining({ provider: "nvidia-prod", model: "nvidia/test" }),
    );
    expect(calls.exit).not.toHaveBeenCalled();
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
      promptYesNoOrDefault: vi.fn(async () => true),
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
    const promptYesNoOrDefault = vi.fn(async () => false);
    const { deps, calls } = createDeps({ isNonInteractive: () => false, promptYesNoOrDefault });

    await expect(
      handleProviderInferenceState({ ...baseOptions(deps), sandboxName: "supplied-review" }),
    ).rejects.toThrow("exit 1");

    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.checkpointSandboxIdentity).toHaveBeenCalledWith("supplied-review", null);
    expect(calls.checkpointSandboxIdentity.mock.invocationCallOrder[0]).toBeLessThan(
      promptYesNoOrDefault.mock.invocationCallOrder[0],
    );
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/test",
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
      promptYesNoOrDefault: vi.fn(async () => false),
    });

    await expect(handleProviderInferenceState(baseOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "ollama-local",
      model: "qwen3.5:9b",
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
      promptYesNoOrDefault: vi.fn(async () => true),
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
    const promptYesNoOrDefault = vi.fn(async () => true);
    const { deps, calls } = createDeps({ isNonInteractive: () => true, promptYesNoOrDefault });

    await handleProviderInferenceState(baseOptions(deps));

    expect(promptYesNoOrDefault).not.toHaveBeenCalled();
    expect(calls.startStep).toHaveBeenCalledWith("provider_selection", {
      provider: "nvidia-prod",
      model: "nvidia/test",
    });
    expect(calls.setupInference).toHaveBeenCalled();
  });

  function failedReviewSession() {
    const session = createSession({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
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
    const promptYesNoOrDefault = vi.fn(async () => true);
    const { deps, calls } = createDeps({
      isNonInteractive: () => false,
      promptYesNoOrDefault,
      isInferenceRouteReady: vi.fn(() => false),
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(promptYesNoOrDefault).toHaveBeenCalledWith("  Apply this configuration?", null, true);
    expect(calls.setupInference).toHaveBeenCalledWith(
      "review-interrupted",
      "qwen3.5:9b",
      "ollama-local",
      null,
      null,
      null,
      [],
      expect.any(Object),
    );
  });

  it("bypasses review when non-interactive resume reuses an interrupted selection (#8687)", async () => {
    const session = failedReviewSession();
    const promptYesNoOrDefault = vi.fn(async () => true);
    const { deps, calls } = createDeps({
      isNonInteractive: () => true,
      promptYesNoOrDefault,
      isInferenceRouteReady: vi.fn(() => false),
    });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "review-interrupted",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(promptYesNoOrDefault).not.toHaveBeenCalled();
    expect(calls.setupInference).toHaveBeenCalledWith(
      "review-interrupted",
      "qwen3.5:9b",
      "ollama-local",
      null,
      null,
      null,
      [],
      expect.any(Object),
    );
    expect(result).toMatchObject({
      sandboxName: "review-interrupted",
      provider: "ollama-local",
      model: "qwen3.5:9b",
    });
  });
});
