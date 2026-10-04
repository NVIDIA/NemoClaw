// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import { decisionSelected, decisionUnset } from "../../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../../state/onboard-checkpoint-migrate";
import { createSession, type Session } from "../../../state/onboard-session";
import type { SandboxEntry } from "../../../state/registry";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  recordSandboxRecreateTargetCreated,
  type SandboxRecreateObservation,
} from "../../sandbox-recreate-transaction";
import { handleSandboxState } from "./sandbox";
import { baseOptions, bindJournaledRecreate, createDeps } from "./sandbox-test-fixtures";

it("journals not-ready repair on the selected non-default gateway (#6492)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const sourceEntry = {
    name: "saved",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions",
    webSearchEnabled: false,
    toolDisclosure: "progressive" as const,
    fromDockerfile: null,
    hermesAuthMethod: null,
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    imageTag: "openshell/sandbox-from:old",
    workload: {
      schemaVersion: 1 as const,
      kind: "legacy-dockerfile" as const,
      reference: "openshell/sandbox-from:old",
      shared: false as const,
    },
  };
  let replacementEntry = {
    ...sourceEntry,
    imageTag: "openshell/sandbox-from:new",
    workload: {
      ...sourceEntry.workload,
      reference: "openshell/sandbox-from:new",
    },
    lifecycleGeneration: "replacement-generation",
    lifecycleLiveIdentityFingerprint: fingerprintSandboxRecreateValue("replacement-identity"),
  };
  const phases: Array<string | null> = [];
  const updateSession = vi.fn((mutator: (value: Session) => Session | void) => {
    mutator(session);
    phases.push(session.checkpoint?.sandboxRecreate?.phase ?? null);
    return session;
  });
  const getSandboxRecreateObservation = vi.fn(
    () =>
      ({
        state: "not_ready",
        liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
      }) as const,
  );
  let currentEntry = sourceEntry;
  const createSandbox = vi.fn(async () => {
    const transaction =
      session.checkpoint?.sandboxRecreate ??
      (() => {
        throw new Error("missing recreate transaction");
      })();
    advanceSandboxRecreateTransaction(session, transaction.id, "deleting");
    advanceSandboxRecreateTransaction(session, transaction.id, "deleted");
    advanceSandboxRecreateTransaction(session, transaction.id, "creating");
    replacementEntry = {
      ...replacementEntry,
      lifecycleGeneration: transaction.targetGeneration,
    };
    currentEntry = replacementEntry;
    recordSandboxRecreateTargetCreated(session, transaction.id, {
      state: "ready",
      liveIdentityFingerprint: replacementEntry.lifecycleLiveIdentityFingerprint,
    });
    return "saved";
  });
  const retireReplacedSandboxWorkload = vi.fn(() => ({
    status: "failed" as const,
    engineDisplayName: "Docker",
    reference: sourceEntry.imageTag,
  }));
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation,
      getSandboxRegistryEntry: () => currentEntry,
      updateSession,
      createSandbox,
      retireReplacedSandboxWorkload,
      cliName: () => "nemohermes",
    },
    session,
  );

  await handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
    gatewayName: "nemoclaw-31818",
  });

  expect(createSandbox).toHaveBeenCalledOnce();
  const createIntent = createSandbox.mock.calls[0]?.at(-2);
  expect(createIntent).toMatchObject({
    recreate: true,
    recreateTransaction: {
      id: expect.any(String),
      targetGeneration: expect.any(String),
      targetIntentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    },
  });
  expect(getSandboxRecreateObservation).toHaveBeenCalledWith("saved");
  expect(retireReplacedSandboxWorkload).toHaveBeenCalledExactlyOnceWith(
    "saved",
    replacementEntry.lifecycleGeneration,
    replacementEntry.lifecycleLiveIdentityFingerprint,
    expect.objectContaining({
      name: "saved",
      imageTag: sourceEntry.imageTag,
      workload: sourceEntry.workload,
    }),
    replacementEntry,
  );
  expect(createSandbox.mock.invocationCallOrder[0]).toBeLessThan(
    retireReplacedSandboxWorkload.mock.invocationCallOrder[0],
  );
  expect(calls.note).toHaveBeenCalledWith(expect.stringContaining("run 'nemohermes gc'"));
  const orderedPhases = phases.filter((phase, index) => index === 0 || phase !== phases[index - 1]);
  expect(orderedPhases).toEqual([null, "created", "registry_committing", "completed", null]);
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});

it.each([
  "replacement-unproven",
  "shared-image",
  "authority-unproven",
  "no-owned-image",
  "image-reused",
] as const)(
  "reports the bounded %s image-retirement skip after journaled recreation",
  async (reason) => {
    const session = createSession({ sandboxName: "saved", agent: "openclaw" });
    const journal = bindJournaledRecreate(session);
    const sourceEntry: SandboxEntry = {
      name: "saved",
      provider: "provider",
      model: "model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      webSearchEnabled: false,
      toolDisclosure: "progressive",
      fromDockerfile: null,
      hermesAuthMethod: null,
      imageTag: "openshell/sandbox-from:old",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:old",
        shared: false,
      },
    };
    const retireReplacedSandboxWorkload = vi.fn(() => ({
      status: "skipped" as const,
      reason,
    }));
    const { deps, calls } = createDeps(
      {
        getSandboxReuseState: () => "not_ready",
        getSandboxRecreateObservation: journal.observe,
        getSandboxRegistryEntry: () => sourceEntry,
        createSandbox: journal.completeCreate,
        retireReplacedSandboxWorkload,
      },
      session,
    );

    await handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
    });

    const diagnostics = calls.note.mock.calls
      .map(([message]) => message)
      .filter((message) => message.startsWith("  Obsolete sandbox image retirement skipped:"));
    expect(diagnostics).toEqual([`  Obsolete sandbox image retirement skipped: ${reason}`]);
    expect(retireReplacedSandboxWorkload).toHaveBeenCalledOnce();
  },
);

it("does not carry a recorded preset list through post-delete onboard resume", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const sourceEntry: SandboxEntry = {
    name: "saved",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions" as const,
    webSearchEnabled: false,
    toolDisclosure: "progressive" as const,
    fromDockerfile: null,
    hermesAuthMethod: null,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
  const targetIntentFingerprint = fingerprintSandboxRecreateValue({
    sandboxName: "saved",
    agent: "openclaw",
  });
  const transaction = beginSandboxRecreateTransaction(session, {
    sandboxName: "saved",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    sourceEntry,
    observation: {
      state: "ready",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
    },
    targetIntentFingerprint,
  });
  advanceSandboxRecreateTransaction(session, transaction.id, "deleting");
  advanceSandboxRecreateTransaction(session, transaction.id, "deleted");
  // The outer rebuild replaces the retired onboarding session before it starts
  // the inner onboarding run. The replacement session's sandbox step is
  // incomplete even though the preserved recreate journal owns the deleted source.
  session.steps.sandbox.status = "pending";
  session.machine.state = "sandbox";

  let currentEntry = sourceEntry;
  let observation: SandboxRecreateObservation = {
    state: "missing" as const,
    liveIdentityFingerprint: null,
  };
  const createSandbox = vi.fn(async (...args: unknown[]) => {
    const createIntent = args.at(-2);
    expect(createIntent).toMatchObject({
      recreate: true,
      recreateJournalTargetIntentFingerprint: targetIntentFingerprint,
      resolved: {
        policy: { options: { additionalPresets: [] } },
      },
      recreateTransaction: {
        id: transaction.id,
        targetGeneration: transaction.targetGeneration,
        targetIntentFingerprint,
      },
    });
    advanceSandboxRecreateTransaction(session, transaction.id, "creating");
    const targetLiveIdentityFingerprint = fingerprintSandboxRecreateValue("openshell-target-id");
    observation = {
      state: "ready",
      liveIdentityFingerprint: targetLiveIdentityFingerprint,
    };
    recordSandboxRecreateTargetCreated(session, transaction.id, observation);
    currentEntry = {
      ...sourceEntry,
      lifecycleGeneration: transaction.targetGeneration,
      lifecycleLiveIdentityFingerprint: targetLiveIdentityFingerprint,
    };
    return "saved";
  });
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => observation.state,
      getSandboxRecreateObservation: () => observation,
      getSandboxRegistryEntry: () => currentEntry,
      createSandbox,
    },
    session,
  );

  await handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
    recreateSandbox: () => true,
    recreateJournalTargetIntentFingerprint: targetIntentFingerprint,
  });

  expect(createSandbox).toHaveBeenCalledOnce();
  expect(calls.note).toHaveBeenCalledWith("  [resume] Continuing journaled sandbox recreation.");
  expect(calls.repairEvent).not.toHaveBeenCalled();
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});

it("removes the journaled source image after resuming a registered replacement", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const sourceEntry = {
    name: "saved",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions" as const,
    webSearchEnabled: false,
    toolDisclosure: "progressive" as const,
    fromDockerfile: null,
    hermesAuthMethod: null,
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    openshellDriver: "docker",
    imageTag: "openshell/sandbox-from:old",
    workload: {
      schemaVersion: 1 as const,
      kind: "legacy-dockerfile" as const,
      reference: "openshell/sandbox-from:old",
      shared: false as const,
    },
  };
  const sourceIdentity = fingerprintSandboxRecreateValue("source-id");
  const targetIdentity = fingerprintSandboxRecreateValue("target-id");
  let replacementRegistered = false;
  let replacementEntry = {
    ...sourceEntry,
    imageTag: "openshell/sandbox-from:new",
    workload: { ...sourceEntry.workload, reference: "openshell/sandbox-from:new" },
    lifecycleGeneration: "missing",
    lifecycleLiveIdentityFingerprint: targetIdentity,
  };
  const createSandbox = vi
    .fn()
    .mockImplementationOnce(async () => {
      const transaction =
        session.checkpoint?.sandboxRecreate ??
        (() => {
          throw new Error("missing recreate transaction");
        })();
      advanceSandboxRecreateTransaction(session, transaction.id, "deleting");
      advanceSandboxRecreateTransaction(session, transaction.id, "deleted");
      advanceSandboxRecreateTransaction(session, transaction.id, "creating");
      replacementEntry = {
        ...replacementEntry,
        lifecycleGeneration: transaction.targetGeneration,
      };
      replacementRegistered = true;
      recordSandboxRecreateTargetCreated(session, transaction.id, {
        state: "ready",
        liveIdentityFingerprint: targetIdentity,
      });
      return "saved";
    })
    .mockResolvedValue("saved");
  const retireReplacedSandboxWorkload = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error("interrupted after replacement registration");
    })
    .mockReturnValue({
      status: "removed" as const,
      engineDisplayName: "Docker",
      reference: sourceEntry.imageTag,
    });
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: () =>
        replacementRegistered
          ? { state: "ready" as const, liveIdentityFingerprint: targetIdentity }
          : { state: "not_ready" as const, liveIdentityFingerprint: sourceIdentity },
      getSandboxRegistryEntry: () => (replacementRegistered ? replacementEntry : sourceEntry),
      createSandbox,
      retireReplacedSandboxWorkload,
    },
    session,
  );
  const options = {
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
    gatewayName: "nemoclaw-31818",
  };

  await expect(handleSandboxState(options)).rejects.toThrow(
    /interrupted after replacement registration/u,
  );
  expect(calls.repairEvent).toHaveBeenLastCalledWith("state.repair.failed", {
    state: "sandbox",
    error: "interrupted after replacement registration",
    metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
  });
  const journal = session.checkpoint?.sandboxRecreate;
  expect(journal?.sourceWorkload?.imageTag).toBe(sourceEntry.imageTag);
  expect(journal?.id).toBeTruthy();
  expect(journal?.targetGeneration).toBeTruthy();

  await handleSandboxState(options);

  expect(createSandbox).toHaveBeenCalledTimes(2);
  expect(createSandbox.mock.calls[1]?.at(-2)).toMatchObject({
    recreateTransaction: {
      id: journal?.id,
      targetGeneration: journal?.targetGeneration,
    },
  });
  expect(retireReplacedSandboxWorkload).toHaveBeenNthCalledWith(
    2,
    "saved",
    journal?.targetGeneration,
    journal?.targetLiveIdentityFingerprint,
    expect.objectContaining({
      name: "saved",
      openshellDriver: "docker",
      imageTag: sourceEntry.imageTag,
      workload: sourceEntry.workload,
    }),
    replacementEntry,
  );
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});

it("rejects an active recreate journal on a different gateway authority (#6492)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  const sourceEntry = {
    name: "saved",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions" as const,
    webSearchEnabled: false,
    toolDisclosure: "progressive" as const,
    fromDockerfile: null,
    hermesAuthMethod: null,
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
  };
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  beginSandboxRecreateTransaction(session, {
    sandboxName: "saved",
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    sourceEntry,
    observation: {
      state: "not_ready",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
    },
    targetIntentFingerprint: fingerprintSandboxRecreateValue({
      sandboxName: "saved",
      agent: "openclaw",
    }),
    id: "11111111-1111-4111-8111-111111111111",
    targetGeneration: "22222222-2222-4222-8222-222222222222",
    now: "2026-07-28T07:00:00.000Z",
  });
  session.checkpoint = {
    ...session.checkpoint,
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const currentEntry = {
    ...sourceEntry,
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
  const getSandboxRecreateObservation = vi.fn(() => ({
    state: "not_ready" as const,
    liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
  }));
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation,
      getSandboxRegistryEntry: () => currentEntry,
    },
    session,
  );

  await expect(
    handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      gatewayName: "nemoclaw",
    }),
  ).rejects.toThrow(/journaled gateway.*does not match the selected gateway authority/i);
  expect(getSandboxRecreateObservation).not.toHaveBeenCalled();
  expect(calls.createSandbox).not.toHaveBeenCalled();
  expect(calls.removeSandbox).not.toHaveBeenCalled();
});

it("refuses an unjournaled same-name replacement when the bound gateway authority does not match the requested gateway (#7736)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const getSandboxRecreateObservation = vi.fn(() => ({
    state: "not_ready" as const,
    liveIdentityFingerprint: fingerprintSandboxRecreateValue("openshell-source-id"),
  }));
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation,
    },
    session,
  );

  await expect(
    handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      gatewayName: "nemoclaw",
    }),
  ).rejects.toThrow(/no recreate transaction proves ownership/i);
  expect(calls.removeSandbox).not.toHaveBeenCalled();
  expect(calls.createSandbox).not.toHaveBeenCalled();
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});

it("refuses an unjournaled legacy same-name repair without gateway authority (#7736)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionUnset(),
  };
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
    },
    session,
  );

  await expect(
    handleSandboxState({
      ...baseOptions(deps, session),
      resume: true,
      sandboxName: "saved",
      gatewayName: "nemoclaw",
    }),
  ).rejects.toThrow(/no recreate transaction proves ownership/i);
  expect(calls.removeSandbox).not.toHaveBeenCalled();
  expect(calls.createSandbox).not.toHaveBeenCalled();
  expect(session.checkpoint?.sandboxRecreate).toBeNull();
});

it("creates a missing sandbox from a preserved registry row without removing the row (#7736)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const reservedEntry = {
    name: "saved",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions" as const,
    webSearchEnabled: false,
    toolDisclosure: "progressive" as const,
    fromDockerfile: null,
    hermesAuthMethod: null,
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    imageTag: "openshell/sandbox-from:new",
  };
  const createSandbox = vi.fn(async () => "saved");
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "missing",
      getSandboxRegistryEntry: () => reservedEntry,
      createSandbox,
    },
    session,
  );

  await handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
    gatewayName: "nemoclaw-31818",
  });

  expect(createSandbox).toHaveBeenCalledOnce();
  expect(calls.removeSandbox).not.toHaveBeenCalled();
  expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
});

it("keeps durable state and emits no success when FSM CAS save throws (#10491)", async () => {
  const session = createSession({ sandboxName: "saved", agent: "openclaw" });
  session.steps.sandbox.status = "complete";
  session.machine.state = "agent_setup";
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "saved", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const oldJournal = session.checkpoint?.sandboxRecreate ?? null;
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRegistryEntry: () => ({
        name: "saved",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        provider: "provider",
        model: "model",
      }),
      getSandboxRecreateObservation: () => ({
        state: "not_ready",
        liveIdentityFingerprint: fingerprintSandboxRecreateValue("source-id"),
      }),
      compareAndSwapSession: vi.fn((matches, mutator) => {
        const transient = structuredClone(session);
        return matches(transient)
          ? (mutator(transient),
            (() => {
              throw new Error("durable CAS save failed");
            })())
          : ("mismatch" as const);
      }),
    },
    session,
  );

  await expect(
    handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" }),
  ).rejects.toThrow("durable CAS save failed");
  expect(session.checkpoint?.sandboxRecreate ?? null).toEqual(oldJournal);
  expect(calls.createSandbox).not.toHaveBeenCalled();
  expect(calls.complete).not.toHaveBeenCalled();
});

it("opens the lifecycle journal for a fresh route reservation before creation (#9833)", async () => {
  const session = createSession({ sandboxName: "fresh", agent: "openclaw" });
  session.checkpoint = {
    ...deriveCheckpointFromSession(session),
    sandboxIdentity: decisionSelected({ name: "fresh", agent: "openclaw" }),
    gatewayAuthority: decisionSelected({
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      mode: "nemoclaw-managed",
      source: "standalone",
      endpoint: null,
      stateDir: null,
      supervisor: null,
      requiredCapabilities: [],
    }),
  };
  const reservation: SandboxEntry = {
    name: "fresh",
    provider: "provider",
    model: "model",
    endpointUrl: null,
    preferredInferenceApi: "openai-completions",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    pendingRouteReservation: true,
    reservationSessionId: session.sessionId,
  };
  let observation: SandboxRecreateObservation = {
    state: "missing",
    liveIdentityFingerprint: null,
  };
  const createSandbox = vi.fn(async (...args: unknown[]) => {
    const transaction = session.checkpoint?.sandboxRecreate;
    expect(transaction).toBeDefined();
    expect(args.at(-2)).toMatchObject({
      recreate: true,
      recreateTransaction: {
        id: transaction?.id,
        targetGeneration: transaction?.targetGeneration,
      },
    });
    advanceSandboxRecreateTransaction(session, transaction!.id, "creating");
    observation = {
      state: "ready",
      liveIdentityFingerprint: fingerprintSandboxRecreateValue("fresh-id"),
    };
    recordSandboxRecreateTargetCreated(session, transaction!.id, observation);
    return "fresh";
  });
  const { deps } = createDeps(
    {
      getSandboxRegistryEntry: () => reservation,
      getSandboxRecreateObservation: () => observation,
      createSandbox,
    },
    session,
  );

  await handleSandboxState({ ...baseOptions(deps, session), sandboxName: "fresh" });

  expect(createSandbox).toHaveBeenCalledOnce();
  expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
});

it("preserves registry state until journaled messaging recreation commits (#7736)", async () => {
  const session = createSession();
  const journal = bindJournaledRecreate(session);
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "ready",
      getSandboxRecreateObservation: journal.observe,
      getStoredMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "1" }),
      hydrateMessagingChannelConfig: () => ({ TELEGRAM_REQUIRE_MENTION: "0" }),
      messagingChannelConfigsEqual: () => false,
      createSandbox: journal.completeCreate,
    },
    session,
  );

  await handleSandboxState({
    ...baseOptions(deps, session),
    resume: true,
    sandboxName: "saved",
  });

  expect(calls.note).toHaveBeenCalledWith(
    "  [resume] Messaging channel configuration changed; recreating sandbox.",
  );
  expect(calls.removeSandbox).not.toHaveBeenCalled();
});

it("journals not-ready resumed sandboxes before recreation (#7736)", async () => {
  const session = createSession({ sandboxName: "saved" });
  const journal = bindJournaledRecreate(session);
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: journal.observe,
      createSandbox: journal.completeCreate,
    },
    session,
  );

  await handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" });

  expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
    state: "sandbox",
    metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
  });
  expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.completed", {
    state: "sandbox",
    metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
  });
});

it("records failed repair events when journaled replacement creation fails (#7736)", async () => {
  const session = createSession({ sandboxName: "saved" });
  const journal = bindJournaledRecreate(session);
  const { deps, calls } = createDeps(
    {
      getSandboxReuseState: () => "not_ready",
      getSandboxRecreateObservation: journal.observe,
      createSandbox: vi.fn(async () => {
        throw new Error("cleanup failed");
      }),
    },
    session,
  );

  await expect(
    handleSandboxState({ ...baseOptions(deps, session), resume: true, sandboxName: "saved" }),
  ).rejects.toThrow("cleanup failed");

  expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.started", {
    state: "sandbox",
    metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
  });
  expect(calls.repairEvent).toHaveBeenCalledWith("state.repair.failed", {
    state: "sandbox",
    error: "cleanup failed",
    metadata: { repair: "recorded-sandbox-cleanup", sandboxName: "saved" },
  });
  expect(calls.repairEvent).not.toHaveBeenCalledWith("state.repair.completed", expect.anything());
});
