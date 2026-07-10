// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { classifySandboxRecoveryAuthority } from "../../provider-recovery";
import { handleProviderInferenceState } from "./provider-inference";
import { baseOptions, createDeps } from "./provider-inference.test-support";

describe("provider inference recovery gating", () => {
  it.each([
    { label: "fresh provider selection", fresh: true, sandboxName: "dcode-station" },
    { label: "brand-new sandbox identity (#6630)", fresh: false, sandboxName: "dc-after" },
  ])("disables recorded provider recovery for $label", async ({ fresh, sandboxName }) => {
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps),
      fresh,
      sandboxName,
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      sandboxName,
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      expect.any(String),
    );
  });

  it("rejects a matching session whose sandbox step is incomplete (#6630)", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
  });

  it("allows recovery for a registered sandbox", async () => {
    const getAuthority = vi.fn((name: string) =>
      name === "dc-after" ? ("authorized" as const) : ("missing" as const),
    );
    const { deps, calls } = createDeps({ getSandboxRecoveryAuthority: getAuthority });

    await handleProviderInferenceState({
      ...baseOptions(deps),
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      expect.any(String),
    );
    expect(getAuthority).toHaveBeenCalledWith("dc-after", expect.any(String));
  });

  it.each([
    { label: "orphaned", reservationSessionId: undefined },
    { label: "owned by another session", reservationSessionId: "session-other" },
  ])("rejects an $label pending reservation despite a completed session (#6630)", async ({
    reservationSessionId,
  }) => {
    const session = createSession();
    session.sandboxName = "dc-after";
    session.steps.sandbox.status = "complete";
    const entry: SandboxEntry = {
      name: "dc-after",
      pendingRouteReservation: true,
      ...(reservationSessionId ? { reservationSessionId } : {}),
    };
    const getAuthority = vi.fn((_name: string, sessionId: string | null | undefined) =>
      classifySandboxRecoveryAuthority(entry, sessionId),
    );
    const { deps, calls } = createDeps({ getSandboxRecoveryAuthority: getAuthority });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      false,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
    expect(getAuthority).toHaveBeenCalledWith("dc-after", session.sessionId);
  });

  it("allows recovery for the current session's pending reservation (#6630)", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    session.steps.sandbox.status = "complete";
    const entry: SandboxEntry = {
      name: "dc-after",
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    };
    const getAuthority = vi.fn((_name: string, sessionId: string | null | undefined) =>
      classifySandboxRecoveryAuthority(entry, sessionId),
    );
    const { deps, calls } = createDeps({ getSandboxRecoveryAuthority: getAuthority });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
    expect(getAuthority).toHaveBeenCalledWith("dc-after", session.sessionId);
  });

  it("forces route setup and rechecks ownership after recorded selection (#6630)", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    session.steps.sandbox.status = "complete";
    const persistedAfterSelection = createSession({ sessionId: "session-after-selection" });
    let authority: "authorized" | "unauthorized" = "authorized";
    const getAuthority = vi.fn((_name: string, sessionId: string | null | undefined) =>
      sessionId === session.sessionId ? authority : "unauthorized",
    );
    const setupNim = vi.fn(async () => {
      authority = "unauthorized";
      return {
        model: "nvidia/test",
        provider: "nvidia-prod",
        endpointUrl: "https://integrate.api.nvidia.com/v1",
        credentialEnv: "NVIDIA_INFERENCE_API_KEY",
        hermesAuthMethod: null,
        hermesToolGateways: [],
        preferredInferenceApi: "openai-responses",
        compatibleEndpointReasoning: null,
        nimContainer: null,
        recoveredFromSandbox: true,
      };
    });
    let setupInferenceCalls = 0;
    const { deps } = createDeps({
      getSandboxRecoveryAuthority: getAuthority,
      setupNim,
      setupInference: async (...args) => {
        setupInferenceCalls += 1;
        const options = args[7];
        expect(options?.reservationSessionId).toBe(session.sessionId);
        expect(options?.isRecordedProviderRecoveryAuthorized).toBeTypeOf("function");
        expect(options?.isRecordedProviderRecoveryAuthorized?.()).toBe(false);
        return { ok: true as const };
      },
      recordStepComplete: async () => persistedAfterSelection,
      isInferenceRouteReady: () => true,
    });

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "dc-after",
    });

    expect(setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
    expect(getAuthority).toHaveBeenNthCalledWith(1, "dc-after", session.sessionId);
    expect(getAuthority).toHaveBeenLastCalledWith("dc-after", session.sessionId);
    expect(setupInferenceCalls).toBe(1);
  });

  it("composes persisted route reservation ownership with resume recovery (#6626, #6630)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-recovery-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../../../state/registry");
      const recovery = await import("../../provider-recovery");
      const sessionId = "session-current";
      const route = {
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "CUSTOM_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
      };

      for (const { sandboxName, reservationSessionId, expectedRecovery } of [
        {
          sandboxName: "owned-reservation",
          reservationSessionId: sessionId,
          expectedRecovery: true,
        },
        {
          sandboxName: "foreign-reservation",
          reservationSessionId: "session-other",
          expectedRecovery: false,
        },
        {
          sandboxName: "ownerless-reservation",
          reservationSessionId: undefined,
          expectedRecovery: false,
        },
      ]) {
        registry.reserveSandboxInferenceRoute(sandboxName, {
          ...route,
          reservationSessionId,
        });
        expect(registry.getSandbox(sandboxName)).toMatchObject({
          pendingRouteReservation: true,
          ...(reservationSessionId ? { reservationSessionId } : {}),
        });

        const session = createSession({ sessionId });
        session.sandboxName = sandboxName;
        session.steps.sandbox.status = "complete";
        const { deps, calls } = createDeps({
          getSandboxRecoveryAuthority: recovery.getSandboxRecoveryAuthority,
        });

        await handleProviderInferenceState({
          ...baseOptions(deps, session),
          resume: true,
          sandboxName,
        });

        expect(calls.setupNim).toHaveBeenCalledWith(
          { type: "nvidia" },
          sandboxName,
          null,
          expectedRecovery,
          "nemoclaw",
          expect.any(Function),
          expect.any(Function),
          sessionId,
        );
      }
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("allows recovery for a matching completed session sandbox", async () => {
    const session = createSession();
    session.sandboxName = "dc-after";
    session.steps.sandbox.status = "complete";
    const { deps, calls } = createDeps();

    await handleProviderInferenceState({
      ...baseOptions(deps, session),
      sandboxName: "dc-after",
    });

    expect(calls.setupNim).toHaveBeenCalledWith(
      { type: "nvidia" },
      "dc-after",
      null,
      true,
      "nemoclaw",
      expect.any(Function),
      expect.any(Function),
      session.sessionId,
    );
  });
});
