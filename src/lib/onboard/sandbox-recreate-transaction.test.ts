// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointSandboxRecreatePhase,
  CheckpointSandboxRecreateTransaction,
} from "../state/onboard-checkpoint-types";
import { createSession } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import {
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  clearCompletedSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  fingerprintSandboxLiveIdentity,
  fingerprintSandboxRecreateValue,
  fingerprintSandboxRegistryEntry,
  matchingSandboxRecreateTransaction,
  planSandboxRecreateRecovery,
  type SandboxRecreateObservation,
  selectedGatewayForSandboxRecreate,
} from "./sandbox-recreate-transaction";

const ISO = "2026-07-27T20:00:00.000Z";
const TX_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_GENERATION = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = fingerprintSandboxRecreateValue("openshell-source-id");
const TARGET_ID = fingerprintSandboxRecreateValue("target-id");
const TARGET_INTENT = fingerprintSandboxRecreateValue({
  agent: "openclaw",
  provider: "nvidia",
});
const SOURCE_ENTRY: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  provider: "nvidia",
  model: "model-a",
  credentialEnv: "NVIDIA_API_KEY",
  gatewayName: "nemoclaw-31818",
  gatewayPort: 31818,
};

function beginInput(observation: SandboxRecreateObservation) {
  return {
    sandboxName: "alpha",
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    sourceEntry: SOURCE_ENTRY,
    observation,
    targetIntentFingerprint: TARGET_INTENT,
    now: ISO,
    id: TX_ID,
    targetGeneration: TARGET_GENERATION,
  } as const;
}

function transactionAt(
  phase: CheckpointSandboxRecreatePhase,
): CheckpointSandboxRecreateTransaction {
  return {
    version: 1,
    id: TX_ID,
    revision: 3,
    sandboxName: "alpha",
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    sourceRegistryFingerprint: fingerprintSandboxRegistryEntry(SOURCE_ENTRY),
    sourceLiveIdentityFingerprint: SOURCE_ID,
    targetIntentFingerprint: TARGET_INTENT,
    targetGeneration: TARGET_GENERATION,
    targetLiveIdentityFingerprint: TARGET_ID,
    phase,
    startedAt: ISO,
    updatedAt: ISO,
  };
}

describe("sandbox recreate journal", () => {
  it("binds a secret-free transaction to a non-default gateway before deletion (#6492)", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    const transaction = beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );

    expect(transaction).toMatchObject({
      id: TX_ID,
      sandboxName: "alpha",
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      targetGeneration: TARGET_GENERATION,
      phase: "planned",
    });
    expect(session.checkpoint?.sandboxRecreate).toBe(transaction);
    const serialized = JSON.stringify(transaction);
    expect(serialized).not.toContain("NVIDIA_API_KEY");
    expect(serialized).not.toContain("model-a");
  });

  it("starts at deleted when the source is already absent", () => {
    const session = createSession({ sandboxName: "alpha" });

    expect(
      beginSandboxRecreateTransaction(
        session,
        beginInput({ state: "missing", liveIdentityFingerprint: null }),
      ).phase,
    ).toBe("deleted");
  });

  it("fails closed when a live source has no stable OpenShell identity", () => {
    const session = createSession({ sandboxName: "alpha" });

    expect(() =>
      beginSandboxRecreateTransaction(
        session,
        beginInput({ state: "not_ready", liveIdentityFingerprint: null }),
      ),
    ).toThrow(/did not report a stable sandbox Id/i);
  });

  it("reuses only the same durable target intent", () => {
    const session = createSession({ sandboxName: "alpha" });
    const first = beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );

    expect(
      beginSandboxRecreateTransaction(
        session,
        beginInput({ state: "missing", liveIdentityFingerprint: null }),
      ),
    ).toBe(first);
    expect(() =>
      beginSandboxRecreateTransaction(session, {
        ...beginInput({ state: "missing", liveIdentityFingerprint: null }),
        targetIntentFingerprint: "f".repeat(64),
      }),
    ).toThrow(/different recreate transaction in progress/i);
  });

  it("advances monotonically and clears only after completion", () => {
    const session = createSession({ sandboxName: "alpha" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );

    expect(advanceSandboxRecreateTransaction(session, TX_ID, "deleting", ISO)).toMatchObject({
      phase: "deleting",
      revision: 1,
    });
    expect(() => advanceSandboxRecreateTransaction(session, TX_ID, "planned", ISO)).toThrow(
      /cannot move backward/i,
    );
    expect(() => clearCompletedSandboxRecreateTransaction(session, TX_ID)).toThrow(/not complete/i);
    advanceSandboxRecreateTransaction(session, TX_ID, "completed", ISO);
    clearCompletedSandboxRecreateTransaction(session, TX_ID);
    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("requires the exact journal handoff at the lower create boundary", () => {
    const session = createSession({ sandboxName: "alpha" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );

    expect(
      matchingSandboxRecreateTransaction(session, {
        sandboxName: "alpha",
        gatewayName: "nemoclaw-31818",
        targetIntentFingerprint: TARGET_INTENT,
        transactionId: TX_ID,
        targetGeneration: TARGET_GENERATION,
      }),
    ).toEqual(session.checkpoint?.sandboxRecreate);
    expect(() =>
      matchingSandboxRecreateTransaction(session, {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        targetIntentFingerprint: TARGET_INTENT,
        transactionId: TX_ID,
        targetGeneration: TARGET_GENERATION,
      }),
    ).toThrow(/does not match the requested replacement/i);
  });

  it("persists deletion and creation phases through the lower runtime boundary", () => {
    const session = createSession({ sandboxName: "alpha" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );
    let observation: SandboxRecreateObservation = {
      state: "ready",
      liveIdentityFingerprint: SOURCE_ID,
    };
    const runtime = createSandboxRecreateRuntime(
      {
        loadSession: () => session,
        updateSession: (mutator) => {
          mutator(session);
          return session;
        },
      },
      {
        id: TX_ID,
        targetGeneration: TARGET_GENERATION,
        targetIntentFingerprint: TARGET_INTENT,
      },
      "alpha",
      "nemoclaw-31818",
      SOURCE_ENTRY,
      () => observation,
      () => undefined,
    );

    runtime.advance("deleting");
    observation = { state: "missing", liveIdentityFingerprint: null };
    runtime.confirmDeleted();
    runtime.advance("creating");
    observation = { state: "ready", liveIdentityFingerprint: TARGET_ID };
    runtime.recordCreated();

    expect(runtime).toMatchObject({
      acceptedTarget: false,
      targetGeneration: TARGET_GENERATION,
    });
    expect(runtime.registrationFields).toEqual({
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    });
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "created",
      revision: 4,
      targetLiveIdentityFingerprint: TARGET_ID,
    });
  });

  it("recovers or rejects at every resumed-onboard mutation boundary (#6492)", () => {
    const session = createSession({ sandboxName: "alpha" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );
    let observation: SandboxRecreateObservation = {
      state: "ready",
      liveIdentityFingerprint: SOURCE_ID,
    };
    let registryEntry: SandboxEntry = SOURCE_ENTRY;
    const sessionStore = {
      loadSession: () => session,
      updateSession: (mutator: (current: ReturnType<typeof createSession>) => void) => {
        mutator(session);
        return session;
      },
    };
    const request = {
      id: TX_ID,
      targetGeneration: TARGET_GENERATION,
      targetIntentFingerprint: TARGET_INTENT,
    };
    const restart = () =>
      createSandboxRecreateRuntime(
        sessionStore,
        request,
        "alpha",
        "nemoclaw-31818",
        registryEntry,
        () => observation,
        () => undefined,
      );

    let runtime = restart();
    expect(runtime.acceptedTarget).toBe(false);

    runtime.advance("deleting");
    expect(restart().acceptedTarget).toBe(false);

    observation = { state: "missing", liveIdentityFingerprint: null };
    runtime.confirmDeleted();
    runtime = restart();
    expect(runtime.acceptedTarget).toBe(false);

    runtime.advance("creating");
    expect(restart().acceptedTarget).toBe(false);

    observation = { state: "ready", liveIdentityFingerprint: TARGET_ID };
    runtime.recordCreated();
    expect(() => restart()).toThrow(/registration did not commit/i);

    registryEntry = {
      ...SOURCE_ENTRY,
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    };
    expect(restart().acceptedTarget).toBe(true);

    advanceSandboxRecreateTransaction(session, TX_ID, "registry_committing", ISO);
    expect(restart().acceptedTarget).toBe(true);
    advanceSandboxRecreateTransaction(session, TX_ID, "completed", ISO);
    expect(restart().acceptedTarget).toBe(true);
    clearCompletedSandboxRecreateTransaction(session, TX_ID);
    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("selects only the checkpoint-authorized non-default gateway", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    session.checkpoint = {
      ...deriveCheckpointFromSession(session),
      sandboxIdentity: decisionSelected({ name: "alpha", agent: "openclaw" }),
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

    expect(selectedGatewayForSandboxRecreate(session.checkpoint, "nemoclaw-31818")).toEqual({
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
    });
    expect(selectedGatewayForSandboxRecreate(session.checkpoint, "nemoclaw")).toBeNull();
  });
});

describe("sandbox recreate recovery", () => {
  it.each([
    "planned",
    "deleting",
  ] as const)("continues source deletion from %s when both identities still match", (phase) => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt(phase),
        { state: "ready", liveIdentityFingerprint: SOURCE_ID },
        SOURCE_ENTRY,
      ),
    ).toEqual({ action: "continue_delete" });
  });

  it.each([
    "planned",
    "deleting",
    "deleted",
    "creating",
  ] as const)("continues target creation from %s when the source is durably absent", (phase) => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt(phase),
        { state: "missing", liveIdentityFingerprint: null },
        SOURCE_ENTRY,
      ),
    ).toEqual({ action: "continue_create" });
  });

  it.each([
    "planned",
    "deleting",
    "deleted",
    "creating",
    "created",
    "registry_committing",
    "completed",
  ] as const)("accepts the ready target from %s when its generation and live identity match", (phase) => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt(phase),
        { state: "ready", liveIdentityFingerprint: TARGET_ID },
        {
          ...SOURCE_ENTRY,
          lifecycleGeneration: TARGET_GENERATION,
          lifecycleLiveIdentityFingerprint: TARGET_ID,
        },
      ),
    ).toEqual({ action: "accept_target" });
  });

  it("rejects a changed source registry row before delete", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("planned"),
        { state: "ready", liveIdentityFingerprint: SOURCE_ID },
        { ...SOURCE_ENTRY, model: "changed-out-of-band" },
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/source registry row changed/),
    });
  });

  it("rejects a same-name live sandbox with a different source identity", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("deleting"),
        { state: "ready", liveIdentityFingerprint: fingerprintSandboxRecreateValue("other-id") },
        SOURCE_ENTRY,
      ),
    ).toMatchObject({ action: "reject", reason: expect.stringMatching(/source identity/) });
  });

  it("rejects a live sandbox that appears before target registration", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("creating"),
        { state: "not_ready", liveIdentityFingerprint: fingerprintSandboxRecreateValue("new-id") },
        SOURCE_ENTRY,
      ),
    ).toMatchObject({ action: "reject", reason: expect.stringMatching(/appeared/) });
  });

  it("rejects a registered target that is not ready", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("registry_committing"),
        { state: "not_ready", liveIdentityFingerprint: TARGET_ID },
        {
          ...SOURCE_ENTRY,
          lifecycleGeneration: TARGET_GENERATION,
          lifecycleLiveIdentityFingerprint: TARGET_ID,
        },
      ),
    ).toMatchObject({ action: "reject", reason: expect.stringMatching(/not ready/) });
  });

  it("rejects a ready same-name sandbox whose identity differs from the registered target", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("registry_committing"),
        { state: "ready", liveIdentityFingerprint: fingerprintSandboxRecreateValue("other-id") },
        {
          ...SOURCE_ENTRY,
          lifecycleGeneration: TARGET_GENERATION,
          lifecycleLiveIdentityFingerprint: TARGET_ID,
        },
      ),
    ).toMatchObject({ action: "reject", reason: expect.stringMatching(/not the journaled/) });
  });

  it("rejects a created target whose registry row never committed the generation", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("created"),
        { state: "ready", liveIdentityFingerprint: TARGET_ID },
        SOURCE_ENTRY,
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/did not commit the journaled generation/),
    });
  });
});

describe("OpenShell live identity", () => {
  it("hashes an ANSI-decorated Id without persisting the raw identifier", () => {
    const output = "Name: alpha\n\u001b[32mId: openshell-source-id\u001b[0m\nState: Ready\n";
    expect(fingerprintSandboxLiveIdentity(output)).toBe(SOURCE_ID);
  });

  it("returns null when OpenShell omits the Id", () => {
    expect(fingerprintSandboxLiveIdentity("Name: alpha\nState: Ready\n")).toBeNull();
  });
});
