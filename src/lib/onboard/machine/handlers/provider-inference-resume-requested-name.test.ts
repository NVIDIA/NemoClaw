// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Resume must honor the sandbox name the operator passed this run via --name
// or NEMOCLAW_SANDBOX_NAME, as the bare-resume guard instructs (#8953). Kept
// out of provider-inference.test.ts for the test-file size budget.

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

function interruptedResumeSession() {
  const session = createSession({
    provider: "nvidia-prod",
    model: "nvidia/nemotron-test",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
    preferredInferenceApi: "openai-responses",
  });
  session.steps.provider_selection.status = "complete";
  return session;
}

describe("resume with an operator-requested sandbox name (#8953)", () => {
  it("reserves the requested name on non-interactive resume without prompting", async () => {
    const session = interruptedResumeSession();
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "fvr-p09-resume",
      requestedSandboxName: "fvr-p09-resume",
    });

    expect(calls.promptName).not.toHaveBeenCalled();
    expect(calls.reserveRoute).toHaveBeenCalledWith(
      "fvr-p09-resume",
      expect.objectContaining({ reservationSessionId: session.sessionId }),
    );
    expect(result.sandboxName).toBe("fvr-p09-resume");
  });

  it("still prompts on interactive resume so the operator can confirm the name", async () => {
    const session = interruptedResumeSession();
    const { deps, calls } = createDeps({
      isInferenceRouteReady: vi.fn(() => true),
      isNonInteractive: () => false,
    });
    calls.promptName.mockResolvedValueOnce("prompted-sandbox");

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "fvr-p09-resume",
      requestedSandboxName: "fvr-p09-resume",
    });

    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(result.sandboxName).toBe("prompted-sandbox");
  });

  it("still prompts when the requested name differs from the resume context name", async () => {
    const session = interruptedResumeSession();
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });
    calls.promptName.mockResolvedValueOnce("prompted-sandbox");

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "stale-sandbox",
      requestedSandboxName: "other-box",
    });

    expect(calls.promptName).toHaveBeenCalledWith(null);
    expect(result.sandboxName).toBe("prompted-sandbox");
  });
});
