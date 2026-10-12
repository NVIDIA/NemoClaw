// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../../../state/onboard-session";
import { recordCheckpointEffectGroup } from "../../checkpoint-record";
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

const GPU_PROOF = {
  status: "verified",
  cudaVerified: true,
  at: "2026-09-28T00:00:00.000Z",
};
const RECORDED_RECEIPTS = [
  ["omits the GPU proof", { sandboxGpuEnabled: true, mode: "auto" }],
  ["contains the GPU proof", { sandboxGpuEnabled: true, mode: "auto", sandboxGpuProof: GPU_PROOF }],
] as const;

async function prepareResumedGpuSandboxRecreate(
  resumedGpuMode: string,
  recordedGpuSettings: object,
) {
  const session = createSession({ sandboxName: "saved" });
  const journal = bindJournaledRecreate(session);
  const firstRun = createDeps(
    {
      createSandbox: vi.fn(async (...args: unknown[]) => {
        Object.assign(args[10] as object, { sandboxGpuProof: GPU_PROOF });
        return "saved";
      }),
    },
    session,
  );
  await handleSandboxState({
    ...baseOptions(firstRun.deps, session),
    sandboxName: "saved",
    sandboxGpuConfig: { sandboxGpuEnabled: true, mode: "auto" },
  });
  recordCheckpointEffectGroup(
    session,
    "sandbox_create",
    (session.checkpoint?.effectGroups.sandbox_create?.fingerprint ?? "").replace(
      JSON.stringify({ sandboxGpuEnabled: true, mode: "auto" }),
      JSON.stringify(recordedGpuSettings),
    ),
  );
  expect(session.checkpoint?.effectGroups.sandbox_create?.fingerprint).toContain(
    JSON.stringify(recordedGpuSettings),
  );
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: journal.observe,
      createSandbox: journal.completeCreate,
    },
    session,
  );
  return {
    calls,
    journal,
    resume: () =>
      handleSandboxState({
        ...baseOptions(deps, session),
        resume: true,
        sandboxName: "saved",
        sandboxGpuConfig: { sandboxGpuEnabled: true, mode: resumedGpuMode },
      }),
  };
}

describe("handleSandboxState resume recreation", () => {
  it.each(RECORDED_RECEIPTS)(
    "recreates a not-ready GPU sandbox on resume when the recorded create receipt %s",
    async (_receipt, recordedGpuSettings) => {
      const { calls, journal, resume } = await prepareResumedGpuSandboxRecreate(
        "auto",
        recordedGpuSettings,
      );

      await resume();

      expect(calls.note).toHaveBeenCalledWith(
        "  [resume] Recorded sandbox 'saved' exists but is not ready; recreating it.",
      );
      expect(calls.exit).not.toHaveBeenCalled();
      expect(journal.completeCreate).toHaveBeenCalledTimes(1);
    },
  );

  it.each(RECORDED_RECEIPTS)(
    "rejects recreating a not-ready GPU sandbox on resume when the sandbox GPU mode changed and the recorded create receipt %s",
    async (_receipt, recordedGpuSettings) => {
      const { calls, journal, resume } = await prepareResumedGpuSandboxRecreate(
        "1",
        recordedGpuSettings,
      );

      await expect(resume()).rejects.toThrow("exit 1");

      expect(calls.error).toHaveBeenCalledWith(
        "  A previous onboarding attempt recorded sandbox 'saved' with different build or policy inputs than this run requests.",
      );
      expect(journal.completeCreate).not.toHaveBeenCalled();
    },
  );

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
