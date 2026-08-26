// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { apfCreateFingerprintFields, apfCreateIntentFields, handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

describe("APF sandbox create selection", () => {
  it("binds selection to the future deferred create intent (#9833)", () => {
    expect(apfCreateIntentFields(true)).toEqual({
      apfInterceptorRequested: true,
      deferSandboxEffectsUntilPolicyVerification: true,
    });
    expect(apfCreateIntentFields(false)).toEqual({});
  });

  it("adds a checkpoint fingerprint field only for APF creation (#9833)", () => {
    expect(apfCreateFingerprintFields(false)).toEqual([]);
    expect(apfCreateFingerprintFields(true)).toEqual(["apf-interceptor"]);
  });

  it("defers fresh-create credentials behind the verified APF effect callback (#9833)", async () => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps(
      {
        getSandboxRegistryEntry: (name) => ({
          name,
          gatewayName: "nemoclaw",
          pendingRouteReservation: true,
          reservationSessionId: session.sessionId,
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          webSearchEnabled: false,
          toolDisclosure: "progressive",
          fromDockerfile: null,
          hermesAuthMethod: null,
        }),
        getSandboxRecreateObservation: () => ({
          state: "missing" as const,
          liveIdentityFingerprint: null,
        }),
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      fresh: true,
      apfInterceptorRequested: true,
    });

    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    const createCall = calls.createSandbox.mock.calls[0] ?? [];
    expect(createCall.at(-2)).toMatchObject({
      apfInterceptorRequested: true,
      deferSandboxEffectsUntilPolicyVerification: true,
    });
    const activateVerifiedEffects = createCall.at(-1);
    expect(activateVerifiedEffects).toEqual(expect.any(Function));

    const sessionUpdatesBeforeVerifiedEffects = calls.updateSession.mock.calls.length;
    await (activateVerifiedEffects as unknown as (context: unknown) => Promise<void>)({
      revalidatePolicyRequirements: () => undefined,
    });
    expect(calls.updateSession.mock.calls.length).toBeGreaterThan(
      sessionUpdatesBeforeVerifiedEffects,
    );
  });

  it("rejects registered sandbox adoption before credential staging (#9833)", async () => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps({}, session);

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        fresh: true,
        apfInterceptorRequested: true,
      }),
    ).rejects.toThrow(/cannot adopt registered sandbox/u);

    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["Ready", { state: "ready" as const, liveIdentityFingerprint: "a".repeat(64) }],
    ["not Ready", { state: "not_ready" as const, liveIdentityFingerprint: null }],
  ])("rejects a %s sandbox before credential staging (#9833)", async (_label, observation) => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps(
      {
        getSandboxRegistryEntry: () => null,
        getSandboxRecreateObservation: () => observation,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        fresh: true,
        apfInterceptorRequested: true,
      }),
    ).rejects.toThrow(/cannot adopt live sandbox/u);

    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });
});
