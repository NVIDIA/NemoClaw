// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

describe("sandbox route publication", () => {
  it("reuses an already-published route without finalizing a stale session reservation", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      gatewayName: "nemoclaw",
    };
    const finalizeSandboxRouteReservation = vi.fn(() => false);
    const { deps } = createDeps(
      {
        finalizeSandboxRouteReservation,
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: () => registryEntry,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(finalizeSandboxRouteReservation).not.toHaveBeenCalled();
  });

  it("publishes the current inference reservation after completing Ready sandbox reuse", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
      toolDisclosure: "progressive",
    };
    const updateSandboxRegistry = vi.fn((_name: string, updates: Record<string, unknown>) => {
      Object.assign(registryEntry, updates);
    });
    const finalizeSandboxRouteReservation = vi.fn((name: string, sessionId: string) => {
      expect(name).toBe(registryEntry.name);
      expect(sessionId).toBe(registryEntry.reservationSessionId);
      delete registryEntry.pendingRouteReservation;
      return true;
    });
    const { deps, calls } = createDeps(
      {
        createSandbox: vi.fn(async () => "saved"),
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: () => registryEntry,
        updateSandboxRegistry,
        finalizeSandboxRouteReservation,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(finalizeSandboxRouteReservation).toHaveBeenCalledExactlyOnceWith(
      "saved",
      session.sessionId,
    );
    expect(finalizeSandboxRouteReservation.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateSandboxRegistry.mock.invocationCallOrder[0]!,
    );
    expect(finalizeSandboxRouteReservation.mock.invocationCallOrder[0]).toBeGreaterThan(
      calls.recordSkip.mock.invocationCallOrder[0]!,
    );
    expect(registryEntry.pendingRouteReservation).toBeUndefined();
    expect(registryEntry.reservationSessionId).toBe(session.sessionId);
  });

  it("keeps a created registration pending when post-create metadata fails", async () => {
    const session = createSession();
    const registryEntry: SandboxEntry = {
      name: "my-assistant",
      provider: "provider",
      model: "model",
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    };
    const finalizeSandboxRouteReservation = vi.fn(() => true);
    const { deps, calls } = createDeps(
      {
        getSandboxRegistryEntry: () => registryEntry,
        finalizeSandboxRouteReservation,
        updateSandboxRegistry: vi.fn(() => {
          throw new Error("metadata write failed");
        }),
      },
      session,
    );

    await expect(handleSandboxState(baseOptions(deps, session))).rejects.toThrow(
      "metadata write failed",
    );

    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(finalizeSandboxRouteReservation).not.toHaveBeenCalled();
    expect(registryEntry).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    });
  });

  it("passes route ownership to the verified create boundary after reservation ownership changes", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      pendingRouteReservation: true,
      reservationSessionId: "session-new",
    };
    const finalizeSandboxRouteReservation = vi.fn(
      (_name: string, sessionId: string) => sessionId === registryEntry.reservationSessionId,
    );
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      expect(args[14]).toEqual({
        sessionId: session.sessionId,
        selection: {
          provider: "provider",
          model: "model",
          endpointUrl: null,
          endpointSource: null,
          credentialEnv: null,
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
      });
      throw new Error("route reservation changed at the verified create boundary");
    });
    const { deps, calls } = createDeps(
      {
        createSandbox,
        finalizeSandboxRouteReservation,
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: () => registryEntry,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow("route reservation changed at the verified create boundary");

    expect(createSandbox).toHaveBeenCalledOnce();
    expect(finalizeSandboxRouteReservation).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(registryEntry).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: "session-new",
    });
  });
});
