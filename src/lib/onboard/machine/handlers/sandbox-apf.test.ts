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

  it("rejects fresh creation before credential staging until the exact gate exists (#9833)", async () => {
    const session = createSession({ apfInterceptorRequested: true });
    const { deps, calls } = createDeps(
      {
        getSandboxRegistryEntry: () => null,
        getSandboxRecreateObservation: () => ({
          state: "missing" as const,
          liveIdentityFingerprint: null,
        }),
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        fresh: true,
        apfInterceptorRequested: true,
      }),
    ).rejects.toThrow(/exact post-create policy verification.*no sandbox was created/u);

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
