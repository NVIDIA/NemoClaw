// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getEffectiveReasoningEffort, type InferenceSelection } from "../../inference/selection";
import { createSession, type SessionUpdates } from "../../state/onboard-session";
import { removeSandbox } from "../../state/registry";
import type { InferenceRouteReservationAuthority } from "../types";
import { context, createPhases } from "./core-flow-phases-test-fixtures";

describe("core onboard flow reasoning effort", () => {
  it("carries the requested reasoning effort from the provider phase into sandbox creation (#12744)", async () => {
    const durableSession = createSession();
    const sandboxName = `reasoning-effort-${durableSession.sessionId}`;
    const recordStepComplete = vi.fn(async (_stepName: string, updates: SessionUpdates = {}) => {
      Object.assign(durableSession, updates);
      return durableSession;
    });
    // Both forwarding steps are only observable from the selection that
    // reaches createSandbox: the provider phase has to publish the effort on
    // the flow context, and the sandbox phase has to read it back off its own
    // options. Asserting the effective effort as well as the raw field pins
    // the fallback too, because a dropped effort reads as "endpoint-default".
    let observedSelection: InferenceSelection | null = null;
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const authority = args[14] as InferenceRouteReservationAuthority | null;
      observedSelection = authority?.selection ?? null;
      return "created-sandbox";
    });
    const { providerInference: providerPhase, sandbox: sandboxPhase } = createPhases({
      providerDeps: {
        setupNim: vi.fn(async () => ({
          model: "nvidia/test",
          provider: "compatible-endpoint",
          endpointUrl: "https://example.test/v1",
          endpointSource: "onboard" as const,
          credentialEnv: "COMPATIBLE_API_KEY",
          hermesAuthMethod: null,
          hermesToolGateways: [],
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: "true",
          compatibleEndpointReasoningEffort: "high",
          nimContainer: null,
        })),
        recordStepComplete,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
      },
      sandboxDeps: {
        createSandbox,
        promptValidatedSandboxName: vi.fn(async () => sandboxName),
      },
    });

    try {
      const providerResult = await providerPhase.run(
        context({ fresh: true, session: durableSession, sandboxName }),
      );
      expect(providerResult.context.compatibleEndpointReasoningEffort).toBe("high");

      await sandboxPhase.run(providerResult.context);

      expect(createSandbox).toHaveBeenCalledOnce();
      expect(observedSelection).toMatchObject({
        provider: "compatible-endpoint",
        compatibleEndpointReasoningEffort: "high",
      });
      expect(getEffectiveReasoningEffort(observedSelection)).toBe("high");
    } finally {
      removeSandbox(sandboxName);
    }
  });
});
