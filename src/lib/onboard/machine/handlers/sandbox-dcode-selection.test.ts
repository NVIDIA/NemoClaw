// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession, type Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import { handleSandboxState } from "./sandbox";
import { baseOptions, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
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

function dcodeOptions(deps: ReturnType<typeof createDeps>["deps"]) {
  return {
    ...baseOptions(deps, completedSession()),
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
      agent: { name: "langchain-deepagents-code" },
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toEqual({
      recreate: false,
      toolDisclosure: "progressive",
      observabilityEnabled: true,
      observabilityRequestedExplicitly: true,
      dcodeAutoApprovalMode: "disabled",
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
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getSandboxRegistryEntry: (name: string) => ({
        ...dcodeRegistryEntry(name),
        dcodeAutoApprovalMode: "disabled",
      }),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...dcodeOptions(deps),
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
      dcodeAutoApprovalMode: "thread-opt-in",
    });
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] DCode auto-approval capability changed; recreating sandbox.",
    );
  });

  it("repairs a not-ready DCode sandbox before recreating for mode drift (#6478)", async () => {
    const session = completedSession();
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "not_ready",
      getSandboxRegistryEntry: (name: string) => ({
        ...dcodeRegistryEntry(name),
        dcodeAutoApprovalMode: "disabled",
      }),
      updateSession: vi.fn((mutator: (value: Session) => Session | void) => {
        return mutator(session) ?? session;
      }),
    });

    await handleSandboxState({
      ...dcodeOptions(deps),
      requestedDcodeAutoApprovalMode: "thread-opt-in",
    });

    expect(calls.repairSandbox).toHaveBeenCalledWith("saved");
    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toMatchObject({
      recreate: true,
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
    );
    expect(calls.createSandbox.mock.calls[0]?.at(-1)).toEqual({
      recreate: true,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      dcodeAutoApprovalMode: "disabled",
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
      recreate: true,
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      dcodeAutoApprovalMode: "disabled",
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
    expect(calls.skipped).toHaveBeenCalledWith("sandbox", "saved");
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
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: true, unknown: true }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: (name) => ({
        ...dcodeRegistryEntry(name),
        fromDockerfile: "/tmp/CustomDockerfile",
      }),
    });

    await handleSandboxState({
      ...dcodeOptions(deps),
      fromDockerfile: "/tmp/CustomDockerfile",
    });

    expect(getDcodeSelectionDrift).not.toHaveBeenCalled();
    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).toHaveBeenCalledWith("saved", {
      pendingRouteReservation: undefined,
    });
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
    const getDcodeSelectionDrift = vi.fn(() => ({ changed: false, unknown: false }));
    const { deps, calls } = createDeps({
      getSandboxReuseState: () => "ready",
      getDcodeSelectionDrift,
      getSandboxRegistryEntry: (name) =>
        dcodeRegistryEntry(name, { provider: "old-provider", model: "old-model" }),
    });

    await handleSandboxState(dcodeOptions(deps));

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).toHaveBeenCalledWith("saved", {
      provider: "provider",
      model: "model",
    });
    expect(calls.updateSandbox).toHaveBeenCalledWith("saved", {
      pendingRouteReservation: undefined,
    });
  });
});
