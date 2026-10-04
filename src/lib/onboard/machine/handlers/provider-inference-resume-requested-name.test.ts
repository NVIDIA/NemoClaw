// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Resume must honor the sandbox name the operator passed this run via --name
// or NEMOCLAW_SANDBOX_NAME, as the non-interactive resume name check in
// session-bootstrap.ts instructs (#8953). This file is separate from
// provider-inference.test.ts because ci/test-file-size-budget.json caps that
// file at 1500 lines.

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { applySessionRecovery } from "../../session-recovery";
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

  it("re-reserves a completed sandbox route when resuming a failed session (#10236)", async () => {
    const session = interruptedResumeSession();
    session.status = "failed";
    session.machine = {
      ...session.machine,
      state: "failed",
    };
    session.failure = {
      step: "policies",
      message: "interrupted",
      recordedAt: "2026-08-26T00:00:00.000Z",
    };
    session.steps.policies.status = "failed";
    applySessionRecovery(session, "2026-08-26T00:01:00.000Z");
    session.failure = null;
    session.status = "in_progress";
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps({ isInferenceRouteReady: vi.fn(() => true) });

    const result = await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "fvr-p09-resume",
      requestedSandboxName: "fvr-p09-resume",
    });

    expect(calls.setupNim).not.toHaveBeenCalled();
    expect(calls.setupInference).not.toHaveBeenCalled();
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
