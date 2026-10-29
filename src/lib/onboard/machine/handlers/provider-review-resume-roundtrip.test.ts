// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Ctrl+C at the configuration review, then `onboard --resume`, must give
// inference setup the endpoint that the review selected (#13802). This drives
// the review checkpoint through the real runtime boundary and session file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SetupInference, SetupInferenceDeps } from "../../setup-inference";

const ENDPOINT = "http://host.openshell.internal:11435/v1";
const originalHome = process.env.HOME;
let tmpHome: string;

async function interruptAtReview() {
  const sessionStore = await import("../../../state/onboard-session");
  const { OnboardRuntime } = await import("../runtime");
  const { OnboardRuntimeBoundary } = await import("../../runtime-boundary");
  const { toSessionUpdates } = await import("../../session-updates");
  const { handleProviderInferenceState } = await import("./provider-inference");
  const { baseOptions, baseSelection, createDeps } =
    await import("./provider-inference.test-support");
  sessionStore.saveSession(sessionStore.createSession());
  const boundary = new OnboardRuntimeBoundary({
    toSessionUpdates: (updates) =>
      toSessionUpdates(updates as Parameters<typeof toSessionUpdates>[0]),
    maybeForceE2eStepFailure: () => undefined,
    createRuntime: () => new OnboardRuntime(),
  });
  const checkpointSandboxIdentity = async (sandboxName: string) => {
    sessionStore.updateSession((current) => {
      current.sandboxName = sandboxName;
      current.sandboxPromptProgress.sandboxName = true;
      return current;
    });
  };

  const interrupted = createDeps({
    isNonInteractive: () => false,
    setupNim: vi.fn(async () => ({
      ...baseSelection,
      provider: "ollama-local",
      model: "qwen2.5:1.5b",
      endpointUrl: ENDPOINT,
      credentialEnv: null,
    })),
    prompt: vi.fn(async () => {
      throw new Error("SIGINT");
    }),
    startRecordedStep: boundary.startRecordedStep.bind(boundary),
    checkpointSandboxIdentity,
  });
  await expect(
    handleProviderInferenceState({
      ...baseOptions(interrupted.deps, sessionStore.loadSession()),
      sandboxName: "review-resume",
    }),
  ).rejects.toThrow("SIGINT");
  await boundary.recordStepFailed(
    "provider_selection",
    "Onboarding exited before the step completed.",
  );
  return {
    sessionStore,
    handleProviderInferenceState,
    baseOptions,
    baseSelection,
    createDeps,
    boundary,
    checkpointSandboxIdentity,
  };
}

describe("review interruption resume round trip (#13802)", () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-review-resume-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    process.env.HOME = originalHome;
  });

  it("attaches the recorded endpoint that deployment verification accepts", async () => {
    const { sessionStore, handleProviderInferenceState, baseOptions, createDeps } =
      await interruptAtReview();
    const { default: onboard } = (await import("../../../onboard")) as unknown as {
      default: {
        createSetupInference: (overrides?: Partial<SetupInferenceDeps>) => SetupInference;
      };
    };
    const { createDirectSetupInferenceHarnessFactory } =
      await import("../../../../../test/support/setup-inference-test-harness");
    const { onboardInferenceVerificationContext, probeOnboardInferenceInvocation } =
      await import("../../../verify-deployment");
    // Port 11435 is admitted only behind the NemoClaw-owned Ollama proxy.
    const harness = createDirectSetupInferenceHarnessFactory(onboard.createSetupInference)({
      overrides: {
        shouldFrontOllamaWithProxy: () => true,
        getOllamaProxyToken: () => "proxy-token-TEST-NOT-A-REAL-VALUE",
      },
    });

    const resumed = createDeps({
      isNonInteractive: () => true,
      isInferenceRouteReady: vi.fn(() => false),
      setupInference: harness.setupInference,
    });
    await handleProviderInferenceState({
      ...baseOptions(resumed.deps, sessionStore.loadSession()),
      resume: true,
      sandboxName: "review-resume",
      agent: { name: "openclaw" },
    });

    expect(resumed.calls.setupNim).not.toHaveBeenCalled();
    const route = harness.updateSandbox.mock.calls
      .map((call) => (call as unknown[])[1] as Record<string, unknown>)
      .find((update) => update.nativeLocalProviderAttachment);
    expect(route?.nativeLocalProviderAttachment).toEqual(
      expect.objectContaining({
        provider: "ollama-local",
        sandboxName: "review-resume",
        gatewayName: "nemoclaw",
        endpointUrl: ENDPOINT,
      }),
    );

    const session = sessionStore.loadSession();
    const verify = (attachment: unknown) =>
      onboardInferenceVerificationContext(
        "review-resume",
        "nemoclaw",
        "openclaw",
        {
          provider: session?.provider ?? null,
          model: session?.model ?? null,
          endpointUrl: session?.endpointUrl ?? null,
          preferredInferenceApi: session?.preferredInferenceApi ?? null,
        },
        { nativeLocalProviderAttachment: attachment as never },
      ).invocation;
    const probe = vi.fn(async () => ({ ok: true }) as const);
    await expect(
      probeOnboardInferenceInvocation(verify(route?.nativeLocalProviderAttachment), probe),
    ).resolves.toEqual({ ok: true });
    // The oracle rejects an attachment whose endpoint differs from the review.
    await expect(
      probeOnboardInferenceInvocation(
        verify({
          ...(route?.nativeLocalProviderAttachment as object),
          endpointUrl: "http://host.openshell.internal:11500/v1",
        }),
        probe,
      ),
    ).resolves.toEqual({
      ok: false,
      detail: "native local provider attachment is missing or invalid",
    });
    // Loading the full onboard module takes several seconds on a busy runner.
  }, 30_000);

  it("keeps an earlier-release reselection incomplete across another review interruption", async () => {
    const {
      sessionStore,
      handleProviderInferenceState,
      baseOptions,
      baseSelection,
      createDeps,
      boundary,
      checkpointSandboxIdentity,
    } = await interruptAtReview();
    const { markLastStartedStepFailed } = await import("../../exit-step-failure");
    sessionStore.updateSession((current) => {
      current.endpointUrl = null;
      return current;
    });
    const first = createDeps({
      isNonInteractive: () => false,
      isInferenceRouteReady: vi.fn(() => true),
      setupNim: vi.fn(async () => ({ ...baseSelection })),
      prompt: vi.fn(async (): Promise<string> => {
        throw new Error("interrupted after reselection");
      }),
      startRecordedStep: boundary.startRecordedStep.bind(boundary),
      recordStepComplete: boundary.recordStepComplete.bind(boundary),
      checkpointSandboxIdentity,
    });

    await expect(
      handleProviderInferenceState({
        ...baseOptions(first.deps, sessionStore.loadSession()),
        resume: true,
        sandboxName: "review-resume",
      }),
    ).rejects.toThrow("interrupted after reselection");
    expect(first.calls.setupInference).not.toHaveBeenCalled();
    expect(sessionStore.loadSession()?.steps.provider_selection.status).toBe("in_progress");
    expect(sessionStore.loadSession()?.lastStepStarted).toBe("provider_selection");
    markLastStartedStepFailed(sessionStore, "Onboarding exited before the step completed.");
    expect(sessionStore.loadSession()?.steps.provider_selection.status).toBe("failed");

    const prompt = vi.fn(async () => "1");
    const second = createDeps({
      isNonInteractive: () => false,
      isInferenceRouteReady: vi.fn(() => true),
      prompt,
      startRecordedStep: boundary.startRecordedStep.bind(boundary),
      recordStepComplete: boundary.recordStepComplete.bind(boundary),
      checkpointSandboxIdentity,
    });
    await handleProviderInferenceState({
      ...baseOptions(second.deps, sessionStore.loadSession()),
      resume: true,
      sandboxName: "review-resume",
    });

    expect(prompt).toHaveBeenCalledOnce();
    expect(second.calls.setupInference).toHaveBeenCalledOnce();
  }, 30_000);
});
