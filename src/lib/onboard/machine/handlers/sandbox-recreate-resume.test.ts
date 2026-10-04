// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { handleSandboxState } from "./sandbox";
import {
  baseOptions,
  bindJournaledRecreate,
  createDeps,
  makeMinimalPlan,
} from "./sandbox-test-fixtures";

vi.mock("../../messaging-channel-setup", () => ({
  detectMessagingChannelsFromEnv: vi.fn(() => []),
}));

describe("handleSandboxState resume recreation", () => {
  it("recreates a ready sandbox when its baked reasoning capability drifted (#7570)", async () => {
    const session = createSession({ sandboxName: "saved" });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session);
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRecreateObservation: journal.observe,
        getSandboxRegistryEntry: () => ({
          name: "saved",
          provider: "compatible-endpoint",
          model: "model",
          endpointUrl: "https://chat.example",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: "false",
          toolDisclosure: "progressive",
        }),
        createSandbox: journal.completeCreate,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      provider: "compatible-endpoint",
      endpointUrl: "https://chat.example",
      credentialEnv: "COMPATIBLE_API_KEY",
      compatibleEndpointReasoning: "true",
    });

    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Compatible endpoint reasoning capability changed; recreating sandbox.",
    );
    expect(calls.recordSkip).not.toHaveBeenCalled();
    expect(journal.completeCreate).toHaveBeenCalledWith(
      expect.anything(),
      "model",
      "compatible-endpoint",
      "openai-completions",
      "saved",
      null,
      [],
      null,
      null,
      null,
      expect.anything(),
      null,
      [],
      null,
      {
        sessionId: session.sessionId,
        selection: {
          provider: "compatible-endpoint",
          model: "model",
          endpointUrl: "https://chat.example",
          endpointSource: null,
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
          compatibleEndpointReasoning: "true",
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
      },
      expect.objectContaining({ compatibleEndpointReasoning: "true", recreate: true }),
      undefined,
    );
  });

  it("honors explicit recreate requests for completed ready sandboxes", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session);
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "ready",
        getSandboxRecreateObservation: journal.observe,
        planRegisteredExtraProviders: vi.fn(() => ({
          extraProviders: ["healthy-extra-provider"],
          staleExtraProviders: [],
        })),
        getSandboxRegistryEntry: () => ({
          name: "saved",
          provider: "provider",
          model: "model",
          endpointUrl: null,
          preferredInferenceApi: "openai-completions",
          toolDisclosure: "progressive",
          fromDockerfile: null,
          hermesAuthMethod: null,
        }),
        createSandbox: journal.completeCreate,
      },
      session,
    );

    const result = await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      recreateSandbox: () => true,
    });

    expect(calls.skipped).not.toHaveBeenCalled();
    expect(calls.note).toHaveBeenCalledWith(
      "  [resume] Recreate sandbox requested; recreating sandbox.",
    );
    expect(deps.planRegisteredExtraProviders).toHaveBeenCalledWith("nemoclaw");
    expect(calls.removeSandbox).not.toHaveBeenCalled();
    expect(journal.completeCreate).toHaveBeenCalledTimes(1);
    const createSandboxCall = journal.completeCreate.mock.calls[0] as unknown[];
    expect(createSandboxCall[4]).toBe("saved");
    expect(createSandboxCall[14]).toEqual({
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
    expect(createSandboxCall[15]).toMatchObject({
      extraProviders: ["healthy-extra-provider"],
      recreate: true,
    });
    expect(result.sandboxName).toBe("saved");
  });

  it("passes an authoritative empty extra-provider list after reconciliation prunes stale names", async () => {
    const session = createSession({
      sandboxName: "saved",
      messagingPlan: makeMinimalPlan("saved", "openclaw", ["slack"]),
    });
    session.steps.sandbox.status = "complete";
    const journal = bindJournaledRecreate(session);
    const { deps } = createDeps(
      {
        getSandboxReuseState: () => "missing",
        getSandboxRecreateObservation: journal.observe,
        planRegisteredExtraProviders: vi.fn(() => ({
          extraProviders: [],
          staleExtraProviders: ["stale-extra-provider"],
        })),
        createSandbox: journal.completeCreate,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    expect(deps.planRegisteredExtraProviders).toHaveBeenCalledWith("nemoclaw");
    expect(journal.completeCreate).toHaveBeenCalledTimes(1);
    const createSandboxCall = journal.completeCreate.mock.calls[0] as unknown[];
    expect(createSandboxCall[14]).toEqual({
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
    expect(createSandboxCall[15]).toMatchObject({
      extraProviders: [],
      recreate: true,
      resolved: expect.objectContaining({ staleExtraProviders: ["stale-extra-provider"] }),
    });
  });
});
