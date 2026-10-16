// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { nativeLocalSetupReceipt } from "../../../../../test/support/native-local-setup-harness";
import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

// Host-wide GC locking is covered by sandbox-route-mutation-lock.test.ts.
vi.mock("../../sandbox-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox-registration")>()),
  withSandboxImageRegistrationFence: async <T>(operation: () => Promise<T> | T): Promise<T> =>
    operation(),
}));

vi.mock("../../sandbox-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox-lifecycle")>()),
  reserveRecoveredSandboxInferenceRoute: <R>(
    reserve: (name: string, route: R) => boolean,
    name: string,
    route: R,
  ) => reserve(name, route),
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

  it("keeps the published route until the resumed recreate passes backup", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    const reserveSandboxInferenceRoute = vi.fn(() => {
      registryEntry.pendingRouteReservation = true;
      registryEntry.reservationSessionId = session.sessionId;
      return true;
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      expect(registryEntry.pendingRouteReservation).toBeUndefined();
      const intent = args.at(-2) as {
        reservePublishedRouteAfterBackup: () => void | Promise<void>;
      };
      await intent.reservePublishedRouteAfterBackup();
      expect(registryEntry).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: session.sessionId,
      });
      return "saved";
    });
    const { deps } = createDeps(
      {
        createSandbox,
        reserveSandboxInferenceRoute,
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

    expect(reserveSandboxInferenceRoute).toHaveBeenCalledExactlyOnceWith("saved", {
      provider: "provider",
      model: "model",
      endpointUrl: null,
      endpointSource: null,
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      reservationSessionId: session.sessionId,
    });
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(reserveSandboxInferenceRoute.mock.invocationCallOrder[0]).toBeGreaterThan(
      createSandbox.mock.invocationCallOrder[0]!,
    );
  });

  it("checks peers without rejecting the published source of a deferred model change", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    let gatewayLockHeld = false;
    const withGatewayRouteMutationLock = async <T>(
      _name: string,
      operation: () => Promise<T> | T,
    ): Promise<T> => {
      expect(gatewayLockHeld).toBe(false);
      gatewayLockHeld = true;
      try {
        return await operation();
      } finally {
        gatewayLockHeld = false;
      }
    };
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "old-model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
      createdAt: "2026-09-16T00:00:00.000Z",
    };
    const checkGatewayRouteCompatibility = vi.fn((request: { sandboxName: string | null }) =>
      request.sandboxName === null
        ? {
            ok: false as const,
            gatewayName: "nemoclaw",
            sandboxName: null,
            route: { provider: "provider", model: "changed-model" },
            conflicts: [{ sandboxName: "saved", reason: "provider-model" as const }],
          }
        : { ok: true as const },
    );
    const reserveSandboxInferenceRoute = vi.fn(() => {
      registryEntry.model = "changed-model";
      registryEntry.pendingRouteReservation = true;
      registryEntry.reservationSessionId = session.sessionId;
      return true;
    });
    const deferredInferenceRoute = vi.fn(async (reserve: () => void) => {
      expect(gatewayLockHeld).toBe(true);
      expect(registryEntry.model).toBe("old-model");
      reserve();
    });
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      expect(registryEntry.model).toBe("old-model");
      const intent = args.at(-2) as {
        reservePublishedRouteAfterBackup: () => Promise<void>;
      };
      await intent.reservePublishedRouteAfterBackup();
      return "saved";
    });
    const { deps } = createDeps(
      {
        checkGatewayRouteCompatibility,
        createSandbox,
        reserveSandboxInferenceRoute,
        withGatewayRouteMutationLock,
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: () => registryEntry,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      recreateSandbox: () => true,
      sandboxName: "saved",
      model: "changed-model",
      deferredInferenceRoute,
    });

    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "saved" }),
    );
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(deferredInferenceRoute).toHaveBeenCalledOnce();
    expect(reserveSandboxInferenceRoute).toHaveBeenCalledOnce();
    expect(gatewayLockHeld).toBe(false);
  });

  it("checks peers before a fresh non-forced model change resolves to recreation", async () => {
    const session = createSession({ sandboxName: "saved" });
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "old-model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      gatewayName: "nemoclaw",
    };
    const checkGatewayRouteCompatibility = vi.fn((request: { sandboxName: string | null }) =>
      request.sandboxName === "saved"
        ? { ok: true as const }
        : {
            ok: false as const,
            gatewayName: "nemoclaw",
            sandboxName: null,
            route: { provider: "provider", model: "changed-model" },
            conflicts: [{ sandboxName: "saved", reason: "provider-model" as const }],
          },
    );
    const deferredInferenceRoute = vi.fn(async (reserve: () => void) => reserve());
    const createSandbox = vi.fn(async (...args: unknown[]) => {
      const intent = args.at(-2) as {
        recreate: boolean;
        reservePublishedRouteAfterBackup: () => Promise<void>;
      };
      expect(intent.recreate).toBe(false);
      await intent.reservePublishedRouteAfterBackup();
      return "saved";
    });
    const { deps } = createDeps(
      {
        checkGatewayRouteCompatibility,
        createSandbox,
        getSandboxRegistryEntry: () => registryEntry,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: "saved",
      model: "changed-model",
      deferredInferenceRoute,
    });

    expect(checkGatewayRouteCompatibility).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "saved" }),
    );
    expect(createSandbox).toHaveBeenCalledOnce();
    expect(deferredInferenceRoute).toHaveBeenCalledOnce();
  });

  it("does not reserve again when the session already owns the pending create reservation", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const registryEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    };
    const createSandbox = vi.fn(async () => "saved");
    const { deps, calls } = createDeps(
      {
        createSandbox,
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

    expect(createSandbox).toHaveBeenCalledOnce();
    expect(calls.reserveRoute).not.toHaveBeenCalled();
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
    expect(calls.reserveRoute).not.toHaveBeenCalled();
    expect(finalizeSandboxRouteReservation).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(registryEntry).toMatchObject({
      pendingRouteReservation: true,
      reservationSessionId: "session-new",
    });
  });
});

function nativeRecreationHarness(agent = "langchain-deepagents-code") {
  const session = createSession({ sandboxName: "saved" });
  const row: SandboxEntry = {
    name: "saved",
    agent,
    provider: "vllm-local",
    model: "meta-llama",
    endpointUrl: "http://host.openshell.internal:8000/v1",
    gatewayName: "nemoclaw",
    preferredInferenceApi: "openai-completions",
  };
  const source = structuredClone(row);
  const attachment = nativeLocalSetupReceipt({
    ...(agent === "pi" ? { agent: "pi" as const } : {}),
    provider: "vllm-local",
    sandboxName: "saved",
    gatewayName: "nemoclaw",
    endpointUrl: row.endpointUrl!,
    authMode: "sentinel",
  });
  const reserve = vi.fn((_name: string, route: Record<string, unknown>) => {
    Object.assign(row, route, { pendingRouteReservation: true });
    return true;
  });
  const { deps, calls } = createDeps(
    { reserveSandboxInferenceRoute: reserve, getSandboxRegistryEntry: () => row },
    session,
  );
  const resolve: NonNullable<
    NonNullable<Parameters<typeof createDeps>[0]>["resolveSandboxCreateIntent"]
  > = deps.resolveSandboxCreateIntent;
  deps.resolveSandboxCreateIntent = async (input: Parameters<typeof resolve>[0]) => ({
    ...(await resolve(input)),
    nativeLocalProviderAttachment: input.nativeLocalProviderAttachment,
  });
  const run = () =>
    handleSandboxState({
      ...baseOptions(deps, session),
      sandboxName: row.name,
      agent: { name: row.agent! },
      provider: row.provider!,
      model: source.model!,
      endpointUrl: row.endpointUrl!,
      recreateSandbox: () => true,
      stagedNativeLocalRecreation: { source, attachment },
    });
  return { row, source, attachment, session, reserve, deps, calls, run };
}

describe.each(["langchain-deepagents-code", "pi"])("legacy %s recreation publication", (agent) => {
  it("publishes the native attachment only at the post-backup replacement seam (#13197)", async () => {
    const { row, source, attachment, session, reserve, deps, run } = nativeRecreationHarness(agent);
    deps.createSandbox = async (...args: unknown[]) => {
      expect(row).toEqual(source);
      expect(reserve).not.toHaveBeenCalled();
      const intent = args.at(-2) as {
        resolved: { inferenceProvider: string; nativeLocalProviderAttachment: unknown };
        reservePublishedRouteAfterBackup: () => Promise<void>;
      };
      expect(intent.resolved).toMatchObject({
        inferenceProvider: attachment.providerName,
        nativeLocalProviderAttachment: attachment,
      });
      await intent.reservePublishedRouteAfterBackup();
      expect(row.nativeLocalProviderAttachment).toEqual(attachment);
      return "saved";
    };
    await run();
    expect(reserve).toHaveBeenCalledExactlyOnceWith(
      "saved",
      expect.objectContaining({
        nativeLocalProviderAttachment: attachment,
        reservationSessionId: session.sessionId,
      }),
    );
  });

  it("preserves the legacy source when backup rejects recreation (#13197)", async () => {
    const { row, source, reserve, deps, run } = nativeRecreationHarness(agent);
    deps.createSandbox = async () => {
      throw new Error("backup refused");
    };
    await expect(run()).rejects.toThrow("backup refused");
    expect(reserve).not.toHaveBeenCalled();
    expect(row).toEqual(source);
  });

  it("rejects a changed legacy source before starting recreation (#13197)", async () => {
    const { row, reserve, calls, run } = nativeRecreationHarness(agent);
    row.model = "another-model";
    await expect(run()).rejects.toThrow("legacy route ownership changed");
    expect(reserve).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });
});
