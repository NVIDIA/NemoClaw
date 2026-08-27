// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  serializedHostLocalInferenceReceipt,
  serializedLlamaCppHostLocalInferenceReceipt,
} from "../../../test/helpers/host-local-inference-receipt";
import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { decisionSelected } from "../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../state/onboard-checkpoint-migrate";
import type {
  CheckpointSandboxRecreatePhase,
  CheckpointSandboxRecreateTransaction,
} from "../state/onboard-checkpoint-types";
import { createSession } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import { createSandboxHostLocalInferenceProvenance } from "../state/registry/host-local-inference";
import { encodeManagedStartupProfile } from "./managed-startup/profile";
import { createDockerRuntimeProviderBundle } from "./runtime-provider/docker";
import { createRuntimeProviderBundleRegistry } from "./runtime-provider/registry";
import {
  abandonSandboxRecreateTransaction,
  advanceSandboxRecreateTransaction,
  assertSandboxRecreateSourceProof,
  beginSandboxRecreateTransaction,
  captureCreatedSandboxLifecycleRegistration,
  clearCompletedSandboxRecreateTransaction,
  createCreatedSandboxLifecycle,
  createSandboxRecreateRuntime,
  fingerprintSandboxLiveIdentity,
  fingerprintSandboxRecreateValue,
  fingerprintSandboxRegistryEntry,
  matchingSandboxRecreateTransaction,
  planSandboxRecreateRecovery,
  revalidateCreatedSandboxLifecycleRegistration,
  retireReplacedSandboxWorkload,
  type SandboxRecreateObservation,
  SandboxRecreateSourceMismatchError,
  sandboxRecreateSourceProof,
  sandboxRecreateSourceWorkloadEntry,
  selectCreatedSandboxLifecycleRegistration,
  selectSandboxRecreateTargetIntentFingerprint,
  selectedGatewayForSandboxRecreate,
} from "./sandbox-recreate-transaction";
import { nativeArtifactWorkloadReceiptFixture } from "./workload/native-artifact-test-fixture";

const ISO = "2026-07-27T20:00:00.000Z";
const TX_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_GENERATION = "22222222-2222-4222-8222-222222222222";
const SOURCE_ID = fingerprintSandboxRecreateValue("openshell-source-id");
const TARGET_ID = fingerprintSandboxRecreateValue("target-id");
const FOREIGN_ID = fingerprintSandboxRecreateValue("foreign-openshell-source-id");
const TARGET_INTENT = fingerprintSandboxRecreateValue({
  agent: "openclaw",
  provider: "nvidia",
});
const CREATED_TARGET = { sandboxName: "alpha", gatewayName: "owner-gateway" };
const SOURCE_ENTRY: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  provider: "nvidia",
  model: "model-a",
  credentialEnv: "NVIDIA_API_KEY",
  gatewayName: "nemoclaw-31818",
  gatewayPort: 31818,
  openshellDriver: "docker",
  imageTag: "openshell/sandbox-from:old",
  workload: {
    schemaVersion: 1,
    kind: "legacy-dockerfile",
    reference: "openshell/sandbox-from:old",
    shared: false,
  },
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
    sourceWorkload: {
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:old",
      workload: {
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:old",
        shared: false,
      },
    },
    targetIntentFingerprint: TARGET_INTENT,
    targetGeneration: TARGET_GENERATION,
    targetLiveIdentityFingerprint: TARGET_ID,
    phase,
    startedAt: ISO,
    updatedAt: ISO,
  };
}

function freshTransactionAt(
  phase: CheckpointSandboxRecreatePhase,
): CheckpointSandboxRecreateTransaction {
  return {
    ...transactionAt(phase),
    sourceRegistryFingerprint: fingerprintSandboxRecreateValue(null),
    sourceLiveIdentityFingerprint: null,
    sourceWorkload: null,
  };
}

function creatingLifecycleFixture(generationOverride?: string) {
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
  return {
    lifecycle: createCreatedSandboxLifecycle(
      runtime,
      CREATED_TARGET,
      () => observation,
      generationOverride,
    ),
    session,
    setObservation: (next: SandboxRecreateObservation) => {
      observation = next;
    },
  };
}

describe("sandbox recreate target intent selection", () => {
  it("keeps the active transaction target when the requested target changes", () => {
    const transaction = transactionAt("planned");
    const changedTarget = fingerprintSandboxRecreateValue({
      agent: "hermes",
      provider: "ollama",
    });

    expect(
      selectSandboxRecreateTargetIntentFingerprint(transaction, changedTarget, TARGET_INTENT),
    ).toBe(TARGET_INTENT);
  });

  it("uses the requested target when no active transaction exists", () => {
    expect(selectSandboxRecreateTargetIntentFingerprint(null, TARGET_INTENT, null)).toBe(
      TARGET_INTENT,
    );
  });

  it("uses the requested target when the active transaction was not handed off", () => {
    const transaction = transactionAt("planned");
    const changedTarget = fingerprintSandboxRecreateValue({
      agent: "hermes",
      provider: "ollama",
    });

    expect(selectSandboxRecreateTargetIntentFingerprint(transaction, changedTarget, null)).toBe(
      changedTarget,
    );
  });
});

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
    expect(sandboxRecreateSourceWorkloadEntry(transaction)).toMatchObject({
      name: "alpha",
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:old",
      workload: SOURCE_ENTRY.workload,
    });
    const serialized = JSON.stringify(transaction);
    expect(serialized).not.toContain("NVIDIA_API_KEY");
    expect(serialized).not.toContain("model-a");
  });

  it("journals a fresh create only after OpenShell proves the name is absent (#9833)", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    const transaction = beginSandboxRecreateTransaction(session, {
      ...beginInput({ state: "missing", liveIdentityFingerprint: null }),
      sourceEntry: null,
    });

    expect(transaction).toMatchObject({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      sourceRegistryFingerprint: fingerprintSandboxRecreateValue(null),
      sourceLiveIdentityFingerprint: null,
      sourceWorkload: null,
      phase: "deleted",
    });
    expect(session.checkpoint?.sandboxRecreate).toBe(transaction);
  });

  it("refuses an absent-source journal when OpenShell reports a same-name sandbox (#9833)", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });

    expect(() =>
      beginSandboxRecreateTransaction(session, {
        ...beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
        sourceEntry: null,
      }),
    ).toThrow(/without its source registry row.*same-name sandbox/su);
  });

  it("retains a shared source image after reconstructing an interrupted replacement", () => {
    const source = {
      ...SOURCE_ENTRY,
      workload: { ...SOURCE_ENTRY.workload, shared: true },
    } as unknown as SandboxEntry;
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    const transaction = beginSandboxRecreateTransaction(session, {
      ...beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
      sourceEntry: source,
    });
    const restoredSource = sandboxRecreateSourceWorkloadEntry(transaction);
    const removeImage = vi.fn(() => ({ status: 0 }));
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);
    const replacement: SandboxEntry = {
      ...SOURCE_ENTRY,
      imageTag: "openshell/sandbox-from:new",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "openshell/sandbox-from:new",
        shared: false,
      },
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    };

    expect(restoredSource?.workload?.shared).toBe(true);
    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        TARGET_GENERATION,
        TARGET_ID,
        restoredSource ?? SOURCE_ENTRY,
        replacement,
        { runtimeProviders },
      ),
    ).toEqual({ status: "skipped", reason: "shared-image" });
    expect(removeImage).not.toHaveBeenCalled();
  });

  it("removes the owned source image when a native-artifact replacement retains a stale imageTag (#8178)", () => {
    const removeImage = vi.fn(() => ({ status: 0 }));
    const runtimeProviders = createRuntimeProviderBundleRegistry([
      ["docker", createDockerRuntimeProviderBundle({ removeImage })],
    ]);
    const replacement: SandboxEntry = {
      ...SOURCE_ENTRY,
      workload: nativeArtifactWorkloadReceiptFixture(
        encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
      ),
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    };

    expect(
      retireReplacedSandboxWorkload(
        "alpha",
        TARGET_GENERATION,
        TARGET_ID,
        SOURCE_ENTRY,
        replacement,
        { runtimeProviders },
      ),
    ).toEqual({
      status: "removed",
      engineDisplayName: "Docker",
      reference: SOURCE_ENTRY.imageTag,
    });
    expect(removeImage).toHaveBeenCalledExactlyOnceWith(SOURCE_ENTRY.imageTag, {
      ignoreError: true,
      timeout: 30_000,
    });
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
    runtime.recordCreated(observation);

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

  it("rejects a malformed replacement identity before the recreate journal records it (#8942)", () => {
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

    expect(() =>
      runtime.recordCreated({
        state: "ready",
        liveIdentityFingerprint: "not-a-fingerprint",
      }),
    ).toThrow(/valid live identity fingerprint/u);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "creating",
      targetLiveIdentityFingerprint: null,
    });
  });

  it("proves the journaled source at the delete edge before onboarding removes it", () => {
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

    observation = { state: "ready", liveIdentityFingerprint: FOREIGN_ID };
    expect(() => runtime.beginDelete()).toThrow(/not the journaled source/i);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "planned", revision: 0 });

    observation = { state: "ready", liveIdentityFingerprint: SOURCE_ID };
    expect(runtime.beginDelete()).toBe("source");
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "deleting" });

    observation = { state: "missing", liveIdentityFingerprint: null };
    expect(runtime.beginDelete()).toBe("missing");
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "deleting" });
  });

  it("refuses to open the delete edge when no transaction proves the source (#7736)", () => {
    const session = createSession({ sandboxName: "alpha" });
    const runtime = createSandboxRecreateRuntime(
      {
        loadSession: () => session,
        updateSession: (mutator: (current: typeof session) => void) => {
          mutator(session);
          return session;
        },
      },
      undefined,
      "alpha",
      "nemoclaw-31818",
      SOURCE_ENTRY,
      () => ({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
      () => undefined,
    );

    expect(() => runtime.beginDelete()).toThrow(/no recreate transaction proves ownership/i);
    expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
  });

  it("scopes the delete edge to the journaled gateway, not the ambient one", () => {
    const session = createSession({ sandboxName: "alpha" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );
    const probedGateways: string[] = [];
    const sessionStore = {
      loadSession: () => session,
      updateSession: (mutator: (current: typeof session) => void) => {
        mutator(session);
        return session;
      },
    };
    const request = {
      id: TX_ID,
      targetGeneration: TARGET_GENERATION,
      targetIntentFingerprint: TARGET_INTENT,
    };
    const observe = (_sandboxName: string, gatewayName: string): SandboxRecreateObservation => {
      probedGateways.push(gatewayName);
      return { state: "ready", liveIdentityFingerprint: SOURCE_ID };
    };

    const runtime = createSandboxRecreateRuntime(
      sessionStore,
      request,
      "alpha",
      "nemoclaw-31818",
      SOURCE_ENTRY,
      observe,
      () => undefined,
    );
    runtime.beginDelete();

    expect(runtime.journaledGatewayName).toBe("nemoclaw-31818");
    expect(new Set(probedGateways)).toEqual(new Set(["nemoclaw-31818"]));
    expect(() =>
      createSandboxRecreateRuntime(
        sessionStore,
        request,
        "alpha",
        "nemoclaw",
        SOURCE_ENTRY,
        observe,
        () => undefined,
      ),
    ).toThrow(/does not match the requested replacement/i);
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
    runtime.recordCreated(observation);
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
  it.each(["planned", "deleting"] as const)(
    "continues source deletion from %s when both identities still match",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          transactionAt(phase),
          { state: "ready", liveIdentityFingerprint: SOURCE_ID },
          SOURCE_ENTRY,
        ),
      ).toEqual({ action: "continue_delete" });
    },
  );

  it.each(["planned", "deleting", "deleted", "creating"] as const)(
    "continues target creation from %s when the source is durably absent",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          transactionAt(phase),
          { state: "missing", liveIdentityFingerprint: null },
          SOURCE_ENTRY,
        ),
      ).toEqual({ action: "continue_create" });
    },
  );

  it.each([
    "planned",
    "deleting",
    "deleted",
    "creating",
    "created",
    "registry_committing",
    "completed",
  ] as const)(
    "accepts the ready target from %s when its generation and live identity match",
    (phase) => {
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
    },
  );

  it("rejects a changed source registry row before delete", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("planned"),
        { state: "ready", liveIdentityFingerprint: SOURCE_ID },
        { ...SOURCE_ENTRY, imageTag: "changed-out-of-band" },
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/source registry row changed/),
    });
  });

  it("keeps the preserved source row after the replacement reserves its inference route", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("deleted"),
        { state: "missing", liveIdentityFingerprint: null },
        {
          ...SOURCE_ENTRY,
          pendingRouteReservation: true,
          reservationSessionId: "session-9",
          model: "model-b",
          endpointUrl: "https://api.example.test/v1",
          gatewayPort: undefined,
        },
      ),
    ).toEqual({ action: "continue_create" });
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

  it("rejects a different same-name sandbox after a fresh target identity was journaled (#9833)", () => {
    expect(
      planSandboxRecreateRecovery(
        freshTransactionAt("created"),
        { state: "ready", liveIdentityFingerprint: FOREIGN_ID },
        null,
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/not the journaled created sandbox/u),
    });
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

describe("source registry fingerprint", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("survives the route reservation the replacement onboard writes (#1904)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-recreate-journal-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../state/registry");
      const lifecycleGeneration = "00000000-0000-4000-8000-000000000001";
      const lifecycleLiveIdentityFingerprint = "a".repeat(64);
      registry.registerSandbox({
        name: "alpha",
        agent: "openclaw",
        agentVersion: "2026.3.11",
        createdAt: ISO,
        imageTag: "nemoclaw/openclaw:2026.3.11",
        provider: "compatible-endpoint",
        model: "model-a",
        endpointUrl: "https://api.example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration,
        lifecycleLiveIdentityFingerprint,
        policyAuthority: "nemoclaw-managed",
        policyCreationReceipt: {
          schemaVersion: 1,
          origin: "sandbox-create",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          sandboxName: "alpha",
          lifecycleGeneration,
          sandboxIdentityFingerprint: lifecycleLiveIdentityFingerprint,
          policyHash: "policy-alpha",
          policyVersion: 1,
        },
      });
      const sourceEntry = registry.getSandbox("alpha") as SandboxEntry;
      const journaled = fingerprintSandboxRegistryEntry(sourceEntry);
      const hostLocalInferenceReceipt = serializedHostLocalInferenceReceipt("podman");

      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          provider: "compatible-endpoint",
          model: "model-a",
          endpointUrl: "https://api.example.test/v1",
          endpointSource: "onboard",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-responses",
          gatewayName: "nemoclaw",
          reservationSessionId: "session-9",
          hostLocalInferenceReceipt,
        }),
      ).toBe(true);
      const reserved = registry.getSandbox("alpha") as SandboxEntry;
      expect(reserved.hostLocalInferenceReceipt).toBe(hostLocalInferenceReceipt);
      expect(reserved.policyAuthority).toBe("nemoclaw-managed");
      expect(reserved.policyCreationReceipt).toEqual(
        expect.objectContaining({ lifecycleGeneration, policyHash: "policy-alpha" }),
      );
      expect(fingerprintSandboxRegistryEntry(reserved)).toBe(journaled);

      registry.restoreSandboxEntry(sourceEntry);
      expect(registry.getSandbox("alpha")?.policyCreationReceipt).toEqual(
        sourceEntry.policyCreationReceipt,
      );
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("survives exact explicit llama.cpp route reservation during rebuild", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-recreate-journal-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../state/registry");
      const hostLocalInferenceReceipt = serializedLlamaCppHostLocalInferenceReceipt("docker");
      const hostLocalInferenceProvenance = createSandboxHostLocalInferenceProvenance(
        "alpha",
        hostLocalInferenceReceipt,
      );
      const route = {
        provider: "llama-cpp-local",
        model: "llama-cpp-model",
        endpointUrl: "https://inference.local/v1",
        endpointSource: "inference-set" as const,
        credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
        preferredInferenceApi: "openai-completions",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        openshellDriver: "docker",
        hostLocalInferenceReceipt,
        hostLocalInferenceProvenance,
      };
      const {
        hostLocalInferenceReceipt: _reservedReceipt,
        hostLocalInferenceProvenance: _reservedProvenance,
        ...registeredRoute
      } = route;
      registry.registerSandbox({
        name: "alpha",
        agent: "openclaw",
        agentVersion: "2026.3.11",
        createdAt: ISO,
        imageTag: "nemoclaw/openclaw:2026.3.11",
        lifecycleGeneration: "alpha-generation-1",
        ...registeredRoute,
      });
      const journaled = fingerprintSandboxRegistryEntry(
        registry.getSandbox("alpha") as SandboxEntry,
      );

      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          ...route,
          reservationSessionId: "session-llama-rebuild",
        }),
      ).toBe(true);
      const reserved = registry.getSandbox("alpha") as SandboxEntry;

      expect(reserved.hostLocalInferenceReceipt).toBe(hostLocalInferenceReceipt);
      expect(reserved.hostLocalInferenceProvenance).toEqual(hostLocalInferenceProvenance);
      expect(fingerprintSandboxRegistryEntry(reserved)).toBe(journaled);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("survives owned MCP policy preparation while retaining policy authority", () => {
    const sourceEntry: SandboxEntry = {
      ...SOURCE_ENTRY,
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: SOURCE_ID,
      policyAuthority: "nemoclaw-managed",
      policyCreationReceipt: {
        schemaVersion: 1,
        origin: "sandbox-create",
        gatewayName: "nemoclaw-31818",
        gatewayPort: 31818,
        sandboxName: "alpha",
        lifecycleGeneration: TARGET_GENERATION,
        sandboxIdentityFingerprint: SOURCE_ID,
        policyHash: "policy-before",
        policyVersion: 1,
      },
      policies: ["mcp-search"],
      customPolicies: [{ name: "mcp-search", content: "network_policies: {}" }],
      mcp: { bridges: {}, managedServerNames: ["search"] },
    };
    const journaled = fingerprintSandboxRegistryEntry(sourceEntry);
    const preparedEntry: SandboxEntry = {
      ...sourceEntry,
      policyCreationReceipt: {
        ...sourceEntry.policyCreationReceipt!,
        policyHash: "policy-after",
        policyVersion: 2,
      },
      policies: [],
      customPolicies: [],
      mcp: { bridges: {}, managedServerNames: [] },
    };

    expect(fingerprintSandboxRegistryEntry(preparedEntry)).toBe(journaled);
    expect(
      fingerprintSandboxRegistryEntry({
        ...preparedEntry,
        policyAuthority: "externally-managed",
      }),
    ).not.toBe(journaled);
  });

  it("changes when the row records another sandbox", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-recreate-journal-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../state/registry");
      registry.registerSandbox({ name: "alpha", agent: "openclaw", createdAt: ISO });
      const journaled = fingerprintSandboxRegistryEntry(
        registry.getSandbox("alpha") as SandboxEntry,
      );

      registry.updateSandbox("alpha", { createdAt: "2026-07-28T20:00:00.000Z" });

      expect(
        fingerprintSandboxRegistryEntry(registry.getSandbox("alpha") as SandboxEntry),
      ).not.toBe(journaled);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
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

describe("abandoning an unused recreate journal", () => {
  it("clears a journal that recorded no lifecycle effect (#7736)", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "missing", liveIdentityFingerprint: null }),
    );
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "deleted", revision: 0 });

    abandonSandboxRecreateTransaction(session, TX_ID);

    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("refuses to abandon a journal that already advanced a phase (#7736)", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "ready", liveIdentityFingerprint: SOURCE_ID }),
    );
    advanceSandboxRecreateTransaction(session, TX_ID, "deleting");

    expect(() => abandonSandboxRecreateTransaction(session, TX_ID)).toThrow(
      /already recorded a lifecycle effect/,
    );
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "deleting" });
  });

  it("refuses to abandon a journal owned by another transaction (#7736)", () => {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    beginSandboxRecreateTransaction(
      session,
      beginInput({ state: "missing", liveIdentityFingerprint: null }),
    );

    expect(() =>
      abandonSandboxRecreateTransaction(session, "33333333-3333-4333-8333-333333333333"),
    ).toThrow(/ownership changed/);
  });
});

describe("journal-bound source proof", () => {
  function proofFor(observation: SandboxRecreateObservation) {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    return sandboxRecreateSourceProof(
      beginSandboxRecreateTransaction(session, beginInput(observation)),
    );
  }

  it("accepts an observation that matches the recorded source (#7736)", () => {
    const observation: SandboxRecreateObservation = {
      state: "ready",
      liveIdentityFingerprint: SOURCE_ID,
    };
    expect(
      assertSandboxRecreateSourceProof(proofFor(observation), {
        sandboxName: "alpha",
        gatewayName: "nemoclaw-31818",
        gatewayPort: 31818,
        registryEntry: SOURCE_ENTRY,
        observation,
      }),
    ).toMatchObject({ sandboxName: "alpha", targetGeneration: TARGET_GENERATION });
  });

  it("rejects a foreign live identity before any backup or delete (#7736)", () => {
    const proof = proofFor({ state: "ready", liveIdentityFingerprint: SOURCE_ID });

    expect(() =>
      assertSandboxRecreateSourceProof(proof, {
        sandboxName: "alpha",
        gatewayName: "nemoclaw-31818",
        gatewayPort: 31818,
        registryEntry: SOURCE_ENTRY,
        observation: { state: "ready", liveIdentityFingerprint: FOREIGN_ID },
      }),
    ).toThrow(SandboxRecreateSourceMismatchError);
  });

  it.each(["ready", "not_ready"] as const)(
    "rejects a %s same-name sandbox that reports no OpenShell Id, even when the journal recorded none (#7736)",
    (state) => {
      const proof = proofFor({ state: "missing", liveIdentityFingerprint: null });

      expect(proof.sourceLiveIdentityFingerprint).toBeNull();
      expect(() =>
        assertSandboxRecreateSourceProof(proof, {
          sandboxName: "alpha",
          gatewayName: "nemoclaw-31818",
          gatewayPort: 31818,
          registryEntry: SOURCE_ENTRY,
          observation: { state, liveIdentityFingerprint: null },
        }),
      ).toThrow(/reports no OpenShell Id/);
    },
  );
});

describe("created sandbox lifecycle registration", () => {
  it("keeps the active recreate target ahead of an older recovered generation (#10056)", () => {
    const fixture = creatingLifecycleFixture("33333333-3333-4333-8333-333333333333");

    expect(fixture.lifecycle.generation).toBe(TARGET_GENERATION);
  });

  it.each([
    ["not Ready", { state: "not_ready" as const, liveIdentityFingerprint: null }, /Ready/u],
    [
      "malformed",
      { state: "ready" as const, liveIdentityFingerprint: "not-a-fingerprint" },
      /valid live identity/u,
    ],
  ])("does not journal a %s replacement before validation (#8942)", (_label, invalid, expected) => {
    const fixture = creatingLifecycleFixture();
    fixture.setObservation(invalid);

    expect(() => fixture.lifecycle.capture({ lifecycleGeneration: TARGET_GENERATION })).toThrow(
      expected,
    );
    expect(fixture.session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "creating",
      targetLiveIdentityFingerprint: null,
    });

    fixture.setObservation({ state: "ready", liveIdentityFingerprint: TARGET_ID });
    const captured = fixture.lifecycle.capture({ lifecycleGeneration: TARGET_GENERATION });
    expect(captured).toEqual({
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    });
    expect(fixture.session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "created",
      targetLiveIdentityFingerprint: TARGET_ID,
    });
    expect(fixture.lifecycle.revalidate(captured)).toEqual(captured);
    expect(fixture.session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "created",
      targetLiveIdentityFingerprint: TARGET_ID,
    });
  });

  it("retains the captured identity when registry revalidation observes drift (#9833)", () => {
    const fixture = creatingLifecycleFixture();
    fixture.setObservation({ state: "ready", liveIdentityFingerprint: TARGET_ID });
    const registration = fixture.lifecycle.capture({
      lifecycleGeneration: TARGET_GENERATION,
    });

    fixture.setObservation({ state: "ready", liveIdentityFingerprint: FOREIGN_ID });
    expect(() => fixture.lifecycle.revalidate(registration)).toThrow(/identity changed/u);
    expect(fixture.session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "created",
      targetLiveIdentityFingerprint: TARGET_ID,
    });

    fixture.setObservation({ state: "ready", liveIdentityFingerprint: TARGET_ID });
    expect(fixture.lifecycle.revalidate(registration)).toEqual(registration);
    expect(fixture.session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "created",
      targetLiveIdentityFingerprint: TARGET_ID,
    });
  });

  it("captures the Ready identity only from the owning gateway", () => {
    const observe = vi.fn((_sandboxName: string, gatewayName: string) =>
      gatewayName === CREATED_TARGET.gatewayName
        ? { state: "ready" as const, liveIdentityFingerprint: TARGET_ID }
        : { state: "ready" as const, liveIdentityFingerprint: FOREIGN_ID },
    );

    expect(
      captureCreatedSandboxLifecycleRegistration(
        CREATED_TARGET,
        TARGET_GENERATION,
        { lifecycleGeneration: TARGET_GENERATION },
        observe,
      ),
    ).toEqual({
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    });
    expect(observe).toHaveBeenCalledExactlyOnceWith("alpha", "owner-gateway");
  });

  it("rejects lifecycle setup generation drift before observing the sandbox", () => {
    const observe = vi.fn();

    expect(() =>
      captureCreatedSandboxLifecycleRegistration(
        CREATED_TARGET,
        TARGET_GENERATION,
        { lifecycleGeneration: "33333333-3333-4333-8333-333333333333" },
        observe,
      ),
    ).toThrow(/lifecycle setup did not preserve its generation/u);
    expect(observe).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", { state: "missing" as const, liveIdentityFingerprint: null }, /Ready/u],
    ["not Ready", { state: "not_ready" as const, liveIdentityFingerprint: null }, /Ready/u],
    [
      "missing identity",
      { state: "ready" as const, liveIdentityFingerprint: null },
      /valid live identity/u,
    ],
    [
      "malformed identity",
      { state: "ready" as const, liveIdentityFingerprint: "not-a-fingerprint" },
      /valid live identity/u,
    ],
  ])("rejects a %s final observation from the owning gateway", (_label, observation, expected) => {
    expect(() =>
      revalidateCreatedSandboxLifecycleRegistration(
        CREATED_TARGET,
        {
          lifecycleGeneration: TARGET_GENERATION,
          lifecycleLiveIdentityFingerprint: TARGET_ID,
        },
        () => observation,
      ),
    ).toThrow(expected);
  });

  it("rejects an identity change before registry publication", () => {
    expect(() =>
      revalidateCreatedSandboxLifecycleRegistration(
        CREATED_TARGET,
        {
          lifecycleGeneration: TARGET_GENERATION,
          lifecycleLiveIdentityFingerprint: TARGET_ID,
        },
        () => ({ state: "ready", liveIdentityFingerprint: FOREIGN_ID }),
      ),
    ).toThrow(/identity changed/u);
  });

  it("keeps the recreate transaction authoritative", () => {
    const observed = {
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    };

    expect(
      selectCreatedSandboxLifecycleRegistration("alpha", observed, TARGET_GENERATION, observed),
    ).toEqual(observed);
    expect(() =>
      selectCreatedSandboxLifecycleRegistration(
        "alpha",
        observed,
        "33333333-3333-4333-8333-333333333333",
        observed,
      ),
    ).toThrow(/recreate transaction no longer matches/u);
    expect(() =>
      selectCreatedSandboxLifecycleRegistration("alpha", observed, TARGET_GENERATION, {
        ...observed,
        lifecycleLiveIdentityFingerprint: FOREIGN_ID,
      }),
    ).toThrow(/recreate transaction no longer matches/u);
  });
});
