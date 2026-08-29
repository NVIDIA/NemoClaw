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
      deferSandboxEffectsUntilIdentityVerification: true,
    });
    expect(apfCreateIntentFields(false)).toEqual({});
  });

  it("adds a checkpoint fingerprint field only for APF creation (#9833)", () => {
    expect(apfCreateFingerprintFields(false)).toEqual([]);
    expect(apfCreateFingerprintFields(true)).toEqual(["apf-interceptor"]);
  });

  it("defers providerless creation effects behind the verified APF callback (#9833)", async () => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps(
      {
        getSandboxRegistryEntry: (name) => ({
          name,
          gatewayName: "nemoclaw",
          pendingRouteReservation: true,
          reservationSessionId: session.sessionId,
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
      model: "",
      provider: "",
      preferredInferenceApi: null,
    });

    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.createSandbox).toHaveBeenCalledOnce();
    const createCall = calls.createSandbox.mock.calls[0] ?? [];
    expect(createCall.at(-2)).toMatchObject({
      apfInterceptorRequested: true,
      deferSandboxEffectsUntilIdentityVerification: true,
    });
    const activateVerifiedEffects = createCall.at(-1);
    expect(activateVerifiedEffects).toEqual(expect.any(Function));

    const sessionUpdatesBeforeVerifiedEffects = calls.updateSession.mock.calls.length;
    await (activateVerifiedEffects as unknown as (context: unknown) => Promise<void>)({
      revalidateSandboxIdentity: () => undefined,
    });
    expect(calls.updateSession.mock.calls.length).toBeGreaterThan(
      sessionUpdatesBeforeVerifiedEffects,
    );
  });

  it.each([
    [
      "an explicit web-search environment selection",
      { env: { NEMOCLAW_WEB_SEARCH_PROVIDER: "brave", BRAVE_API_KEY: "secret-value" } },
    ],
    ["a selected messaging channel", { selectedMessagingChannels: ["telegram"] }],
  ])("rejects %s before credential, provider, or sandbox effects", async (_label, intent) => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps({}, session);

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        ...intent,
        fresh: true,
        apfInterceptorRequested: true,
        model: "",
        provider: "",
        preferredInferenceApi: null,
      }),
    ).rejects.toThrow(/supports providerless sandbox creation only/u);

    expect(calls.configureWebSearch).not.toHaveBeenCalled();
    expect(calls.validateBrave).not.toHaveBeenCalled();
    expect(calls.setupMessaging).not.toHaveBeenCalled();
    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects a resolved APF provider plan before sandbox or provider effects (#9833)", async () => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps(
      {
        getSandboxRegistryEntry: (name) => ({
          name,
          gatewayName: "nemoclaw",
          pendingRouteReservation: true,
          reservationSessionId: session.sessionId,
        }),
        getSandboxRecreateObservation: () => ({
          state: "missing" as const,
          liveIdentityFingerprint: null,
        }),
        planRegisteredExtraProviders: () => ({
          extraProviders: [],
          staleExtraProviders: ["stale-provider"],
        }),
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        fresh: true,
        apfInterceptorRequested: true,
        model: "",
        provider: "",
        preferredInferenceApi: null,
      }),
    ).rejects.toThrow(/supports providerless sandbox creation only/u);

    expect(calls.resolveCreateIntent).not.toHaveBeenCalled();
    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("rejects registered sandbox adoption before credential staging (#9833)", async () => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps({}, session);

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        fresh: true,
        apfInterceptorRequested: true,
        model: "",
        provider: "",
        preferredInferenceApi: null,
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
        model: "",
        provider: "",
        preferredInferenceApi: null,
      }),
    ).rejects.toThrow(/cannot adopt live sandbox/u);

    expect(calls.stageCredentialProviders).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });
});
