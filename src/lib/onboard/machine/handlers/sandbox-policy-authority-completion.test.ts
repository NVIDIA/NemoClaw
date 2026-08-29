// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import { baseOptions, bindJournaledRecreate, createDeps } from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
  detectUnconfiguredMessagingChannels: vi.fn(() => []),
}));

function refuseAt(targetOperation: string) {
  const actions = new Map<string, () => void>([
    [
      targetOperation,
      () => {
        throw new Error("external policy authority must supply the final sandbox entries");
      },
    ],
  ]);
  return vi.fn((input: { operation: string }) => actions.get(input.operation)?.());
}

describe("sandbox completion policy authority", () => {
  it("rechecks immediately before sandbox creation (#9833)", async () => {
    const preflightPolicyRequirements = refuseAt("create sandbox 'my-assistant'");
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("rechecks after the inner create before registry or session completion (#9833)", async () => {
    const preflightPolicyRequirements = refuseAt("complete the created sandbox");
    const { deps, calls } = createDeps({ preflightPolicyRequirements });

    await expect(handleSandboxState(baseOptions(deps))).rejects.toThrow(
      /external policy authority must supply/u,
    );

    expect(calls.createSandbox).toHaveBeenCalledOnce();
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("rechecks after repair persistence before registry completion (#9833)", async () => {
    const session = createSession({ sandboxName: "saved" });
    const journal = bindJournaledRecreate(session);
    const preflightPolicyRequirements = refuseAt("complete sandbox repair");
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "not_ready",
        getSandboxRecreateObservation: journal.observe,
        createSandbox: journal.completeCreate,
        preflightPolicyRequirements,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
      state: "sandbox",
      metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
    });
    expect(calls.updateSandbox).not.toHaveBeenCalled();
    expect(calls.complete).not.toHaveBeenCalled();
  });

  it("rechecks before recording reused sandbox state (#9833)", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const preflightPolicyRequirements = refuseAt("record reused sandbox state for 'saved'");
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRegistryEntry: () => ({
          name: "saved",
          pendingRouteReservation: true,
          reservationSessionId: session.sessionId,
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          toolDisclosure: "progressive",
          fromDockerfile: null,
          hermesAuthMethod: null,
        }),
        preflightPolicyRequirements,
      },
      session,
    );

    await expect(
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
      }),
    ).rejects.toThrow(/external policy authority must supply/u);

    expect(calls.createSandbox).not.toHaveBeenCalled();
    expect(calls.skipped).not.toHaveBeenCalled();
  });

  it.each([
    {
      operation: "register the created sandbox",
      registryCalls: 0,
      completionCalls: 0,
    },
    {
      operation: "complete the sandbox onboarding session",
      registryCalls: 1,
      completionCalls: 0,
    },
    {
      operation: "record the final sandbox creation receipt",
      registryCalls: 1,
      completionCalls: 1,
    },
  ])(
    "rechecks before $operation mutation (#9833)",
    async ({ operation, registryCalls, completionCalls }) => {
      const session = createSession();
      const preflightPolicyRequirements = refuseAt(operation);
      const { deps, calls, getSession } = createDeps({ preflightPolicyRequirements }, session);

      await expect(handleSandboxState(baseOptions(deps, session))).rejects.toThrow(
        /external policy authority must supply/u,
      );

      expect(calls.updateSandbox).toHaveBeenCalledTimes(registryCalls);
      expect(calls.complete).toHaveBeenCalledTimes(completionCalls);
      expect(getSession().checkpoint?.effectGroups.sandbox_create).toBeUndefined();
      expect(getSession().checkpoint?.effectGroups.sandbox_register).toBeUndefined();
    },
  );
});
