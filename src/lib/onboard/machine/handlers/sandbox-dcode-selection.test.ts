// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, bindJournaledRecreate, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

function completedSession() {
  const session = createSession({ sandboxName: "saved" });
  session.steps.sandbox.status = "complete";
  return session;
}

function dcodeRegistryEntry(
  name: string,
  selection: Partial<Pick<SandboxEntry, "provider" | "model">> = {
    provider: "provider",
    model: "model",
  },
): SandboxEntry {
  return {
    name,
    agent: "langchain-deepagents-code",
    nemoclawVersion: "0.1.0",
    observabilityEnabled: false,
    toolDisclosure: "progressive",
    webSearchEnabled: false,
    webSearchProvider: null,
    fromDockerfile: null,
    hermesAuthMethod: null,
    ...selection,
  };
}

function dcodeOptions(
  deps: ReturnType<typeof createDeps>["deps"],
  session: Session = completedSession(),
) {
  return {
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
    agent: { name: "langchain-deepagents-code", displayName: "Deep Agents Code" },
  };
}

describe("handleSandboxState live DCode selection", () => {
  it("carries durable observability intent in the sandbox create intent", async () => {
    const session = createSession({
      observabilityEnabled: true,
      observabilityRequestedExplicitly: true,
    });
    const { deps, calls } = createDeps({
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...baseOptions(deps, session),
      fresh: true,
      agent: { name: "langchain-deepagents-code" },
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      resolved: expect.any(Object),
      recreate: false,
      toolDisclosure: "progressive",
      observabilityEnabled: true,
      endpointSource: null,
      observabilityRequestedExplicitly: true,
      dcodeAutoApprovalMode: "disabled",
      extraProviders: [],
    });
  });

  it("carries authoritative thread opt-in in the create intent (#6478)", async () => {
    const session = createSession();
    const { deps, calls } = createDeps();

    await handleSandboxState({
      ...baseOptions(deps, session),
      agent: { name: "langchain-deepagents-code" },
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      dcodeAutoApprovalMode: "thread-opt-in",
    });
  });

  it("recreates a ready DCode sandbox when the image-baked mode changes (#6478)", async () => {
    const session = completedSession();
    const journal = bindJournaledRecreate(session, "saved", "langchain-deepagents-code");
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRecreateObservation: journal.observe,
        getSandboxRegistryEntry: (name: string) => ({
          ...dcodeRegistryEntry(name),
          dcodeAutoApprovalMode: "disabled",
        }),
        createSandbox: journal.completeCreate,
        updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
          return mutator(session) ?? session;
        }),
      },
      session,
    );

    await handleSandboxState({
      ...dcodeOptions(deps, session),
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    expect(journal.completeCreate.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
      recreateTransaction: expect.any(Object),
      dcodeAutoApprovalMode: "thread-opt-in",
    });
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] DCode auto-approval capability changed; recreating sandbox.",
    );
  });

  it("repairs a not-ready DCode sandbox before recreating for mode drift (#6478)", async () => {
    const session = completedSession();
    const journal = bindJournaledRecreate(session, "saved", "langchain-deepagents-code");
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "not_ready",
        getSandboxRecreateObservation: journal.observe,
        getSandboxRegistryEntry: (name: string) => ({
          ...dcodeRegistryEntry(name),
          dcodeAutoApprovalMode: "disabled",
        }),
        createSandbox: journal.completeCreate,
        updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
          return mutator(session) ?? session;
        }),
      },
      session,
    );

    await handleSandboxState({
      ...dcodeOptions(deps, session),
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(journal.completeCreate.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
      recreateTransaction: expect.any(Object),
      dcodeAutoApprovalMode: "thread-opt-in",
    });
  });

  it("rejects malformed recorded DCode auto-approval state (#6478)", async () => {
    const { deps, calls } = createDeps({
      getSandboxRegistryEntry: (name: string) => ({
        ...dcodeRegistryEntry(name),
        dcodeAutoApprovalMode: "always" as never,
      }),
    });

    await expect(
      handleSandboxState({
        ...baseOptions(deps),
        agent: { name: "langchain-deepagents-code" },
        sandboxName: "saved",
      }),
    ).rejects.toThrow("exit 1");
    expect(calls.error).toHaveBeenCalledWith(expect.stringContaining("mode is invalid"));
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["changed", { changed: true, unknown: false }],
    ["unreadable", { changed: false, unknown: true }],
  ])("recreates a ready sandbox when live selection is %s (#6311)", async (_label, drift) => {
    const getDcodeSelectionDrift = vi.fn(() => drift);
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: (name) => dcodeRegistryEntry(name),
    });

    await handleSandboxState(dcodeOptions(deps));

    expect(getDcodeSelectionDrift).toHaveBeenCalledWith(
      "saved",
      "provider",
      "model",
      "openai-completions",
      null,
    );
    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toEqual({
      resolved: expect.any(Object),
      recreate: true,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      endpointSource: null,
      dcodeAutoApprovalMode: "disabled",
      extraProviders: [],
    });
    expect(calls.removeSandbox).not.toHaveBeenCalled();
  });

  it("preserves registry fidelity when GPU drift recreates managed DCode (#6311)", async () => {
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift: () => ({ changed: false, unknown: false }),
      hasSandboxGpuDrift: () => true,
      getSandboxRegistryEntry: (name) => dcodeRegistryEntry(name),
    });

    await handleSandboxState(dcodeOptions(deps));

    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toEqual({
      resolved: expect.any(Object),
      recreate: true,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      endpointSource: null,
      dcodeAutoApprovalMode: "disabled",
      extraProviders: [],
    });
  });

  it("reuses a ready sandbox only after the live selection is verified (#6311)", async () => {
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: false, unknown: false }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: (name) => dcodeRegistryEntry(name),
    });

    await handleSandboxState(dcodeOptions(deps));

    expect(getDcodeSelectionDrift).toHaveBeenCalledOnce();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved", "reuse");
  });

  it("reuses a ready OpenRouter-compatible sandbox after endpoint-aware verification (#9555)", async () => {
    const endpointUrl = "https://openrouter.ai/api/v1/";
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: false, unknown: false }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: (name) =>
        dcodeRegistryEntry(name, {
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
        }),
    });

    await handleSandboxState({
      ...dcodeOptions(deps),
      provider: "compatible-endpoint",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      endpointUrl,
    });

    expect(getDcodeSelectionDrift).toHaveBeenCalledWith(
      "saved",
      "compatible-endpoint",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "openai-completions",
      endpointUrl,
    );
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved", "reuse");
  });

  it("refuses managed DCode reuse when the registry record is missing (#6311)", async () => {
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: false, unknown: false }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: () => null,
    });

    await expect(handleSandboxState(dcodeOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining("missing its NemoClaw registry record"),
    );
    expect(getDcodeSelectionDrift).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
  });

  it("keeps custom DCode images outside the managed identity contract (#6311)", async () => {
    const session = completedSession();
    const registryEntry: SandboxEntry = {
      ...dcodeRegistryEntry("saved"),
      fromDockerfile: "/tmp/CustomDockerfile",
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    };
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: true, unknown: true }));
    const finalizeSandboxRouteReservation = vi.fn((name: string, sessionId: string) => {
      expect(name).toBe(registryEntry.name);
      expect(sessionId).toBe(registryEntry.reservationSessionId);
      delete registryEntry.pendingRouteReservation;
      return true;
    });
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getDcodeSelectionDrift,
        getSandboxRegistryEntry: () => registryEntry,
        finalizeSandboxRouteReservation,
      },
      session,
    );

    await handleSandboxState({
      ...dcodeOptions(deps, session),
      fromDockerfile: "/tmp/CustomDockerfile",
    });

    expect(getDcodeSelectionDrift).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(finalizeSandboxRouteReservation).toHaveBeenCalledExactlyOnceWith(
      "saved",
      session.sessionId,
    );
    expect(registryEntry.pendingRouteReservation).toBeUndefined();
    expect(registryEntry.reservationSessionId).toBe(session.sessionId);
  });

  it("fails closed for missing registry selection before live reuse (#6311)", async () => {
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: false, unknown: false }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: (name) => dcodeRegistryEntry(name, {}),
    });

    await expect(handleSandboxState(dcodeOptions(deps))).rejects.toThrow("exit 1");

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("backfills stale registry selection after verified live reuse (#6311)", async () => {
    const session = completedSession();
    const registryEntry: SandboxEntry = {
      ...dcodeRegistryEntry("saved", { provider: "old-provider", model: "old-model" }),
      pendingRouteReservation: true,
      reservationSessionId: session.sessionId,
    };
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: false, unknown: false }));
    const updateSandboxRegistry = vi.fn(
      (_name: string, updates: Record<string, unknown>) => {
        Object.assign(registryEntry, updates);
      },
    );
    const finalizeSandboxRouteReservation = vi.fn((name: string, sessionId: string) => {
      expect(name).toBe(registryEntry.name);
      expect(sessionId).toBe(registryEntry.reservationSessionId);
      delete registryEntry.pendingRouteReservation;
      return true;
    });
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getDcodeSelectionDrift,
        getSandboxRegistryEntry: () => registryEntry,
        updateSandboxRegistry,
        finalizeSandboxRouteReservation,
      },
      session,
    );

    await handleSandboxState(dcodeOptions(deps, session));

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(updateSandboxRegistry).toHaveBeenCalledWith("saved", {
      provider: "provider",
      model: "model",
    });
    expect(finalizeSandboxRouteReservation).toHaveBeenCalledExactlyOnceWith(
      "saved",
      session.sessionId,
    );
    expect(registryEntry).toMatchObject({
      provider: "provider",
      model: "model",
      reservationSessionId: session.sessionId,
    });
    expect(registryEntry.pendingRouteReservation).toBeUndefined();
  });
});
