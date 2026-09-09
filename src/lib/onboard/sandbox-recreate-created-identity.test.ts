// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createSession } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import {
  beginSandboxRecreateTransaction,
  createCreatedSandboxLifecycle,
  createSandboxRecreateRuntime,
  fingerprintSandboxRecreateValue,
  type SandboxRecreateObservation,
} from "./sandbox-recreate-transaction";

const TRANSACTION_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_GENERATION = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT_TRANSACTION_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = fingerprintSandboxRecreateValue("source-id");
const TARGET_ID = fingerprintSandboxRecreateValue("target-id");
const FOREIGN_ID = fingerprintSandboxRecreateValue("foreign-id");
const TARGET_INTENT = fingerprintSandboxRecreateValue({ agent: "openclaw", provider: "nvidia" });
const CREATED_TARGET = { sandboxName: "alpha", gatewayName: "nemoclaw-31818" };
const SOURCE_ENTRY: SandboxEntry = {
  name: "alpha",
  agent: "openclaw",
  provider: "nvidia",
  model: "model-a",
  gatewayName: "nemoclaw-31818",
  gatewayPort: 31818,
  openshellDriver: "docker",
  imageTag: "openshell/sandbox-from:old",
};

type TestSession = ReturnType<typeof createSession>;

function requireSession(session: TestSession | null): TestSession {
  expect(session).not.toBeNull();
  return session as TestSession;
}

function createdIdentityFixture() {
  const session = createSession({ sandboxName: "alpha" });
  let storedSession: TestSession | null = session;
  beginSandboxRecreateTransaction(session, {
    sandboxName: "alpha",
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    sourceEntry: SOURCE_ENTRY,
    observation: { state: "ready", liveIdentityFingerprint: SOURCE_ID },
    targetIntentFingerprint: TARGET_INTENT,
    id: TRANSACTION_ID,
    targetGeneration: TARGET_GENERATION,
  });
  let observation: SandboxRecreateObservation = {
    state: "ready",
    liveIdentityFingerprint: SOURCE_ID,
  };
  const sessionStore = {
    loadSession: vi.fn(() => storedSession),
    updateSession: vi.fn((mutator: (current: TestSession) => TestSession | void) => {
      const current = requireSession(storedSession);
      storedSession = mutator(current) || current;
      return storedSession;
    }),
    compareAndSwapSession: vi.fn(
      (
        matches: (current: TestSession) => boolean,
        mutator: (current: TestSession) => TestSession | void,
      ): "updated" | "busy" | "mismatch" => {
        const current = storedSession;
        return current && matches(current)
          ? (() => {
              storedSession = mutator(current) || current;
              return "updated" as const;
            })()
          : "mismatch";
      },
    ),
  };
  const runtime = createSandboxRecreateRuntime(
    sessionStore,
    {
      id: TRANSACTION_ID,
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
    lifecycle: createCreatedSandboxLifecycle(runtime, CREATED_TARGET, () => observation),
    session,
    sessionStore,
    replaceStoredSession: (replacement: TestSession | null) => {
      storedSession = replacement;
    },
    setObservation: (next: SandboxRecreateObservation) => {
      observation = next;
    },
  };
}

function replaceTransaction(session: TestSession): TestSession {
  const replacement = structuredClone(session);
  const checkpoint = replacement.checkpoint!;
  const transaction = checkpoint.sandboxRecreate!;
  expect(checkpoint).toBeDefined();
  expect(transaction).toBeDefined();
  return {
    ...replacement,
    checkpoint: {
      ...checkpoint,
      sandboxRecreate: { ...transaction, id: REPLACEMENT_TRANSACTION_ID },
    },
  };
}

describe("created sandbox exact identity journal", () => {
  it("records the exact identity before later lifecycle checks (#9833)", () => {
    const fixture = createdIdentityFixture();

    const recorded = fixture.lifecycle.recordExactIdentity(TARGET_ID);
    expect(recorded).toEqual({
      lifecycleGeneration: TARGET_GENERATION,
      lifecycleLiveIdentityFingerprint: TARGET_ID,
    });
    expect(fixture.session.checkpoint?.sandboxRecreate).toMatchObject({
      phase: "created",
      revision: 4,
      targetGeneration: TARGET_GENERATION,
      targetLiveIdentityFingerprint: TARGET_ID,
    });
    expect(fixture.sessionStore.loadSession).toHaveBeenCalledTimes(3);

    const revision = fixture.session.checkpoint?.sandboxRecreate?.revision;
    expect(fixture.lifecycle.recordExactIdentity(TARGET_ID)).toEqual(recorded);
    expect(fixture.session.checkpoint?.sandboxRecreate?.revision).toBe(revision);

    fixture.setObservation({ state: "ready", liveIdentityFingerprint: TARGET_ID });
    expect(fixture.lifecycle.capture({ lifecycleGeneration: TARGET_GENERATION })).toEqual(recorded);
    expect(fixture.lifecycle.revalidate(recorded)).toEqual(recorded);
  });

  it("rejects invalid, conflicting, and wrongly phased identities without changing the journal (#9833)", () => {
    const fixture = createdIdentityFixture();
    const creating = structuredClone(fixture.session.checkpoint?.sandboxRecreate);

    expect(() => fixture.lifecycle.recordExactIdentity("not-a-fingerprint")).toThrow(
      /invalid live identity fingerprint/u,
    );
    expect(fixture.session.checkpoint?.sandboxRecreate).toEqual(creating);

    fixture.lifecycle.recordExactIdentity(TARGET_ID);
    const created = structuredClone(fixture.session.checkpoint?.sandboxRecreate);
    expect(() => fixture.lifecycle.recordExactIdentity(FOREIGN_ID)).toThrow(
      /different replacement/u,
    );
    expect(fixture.session.checkpoint?.sandboxRecreate).toEqual(created);

    const currentCheckpoint = fixture.session.checkpoint!;
    const currentTransaction = currentCheckpoint.sandboxRecreate!;
    expect(currentCheckpoint).toBeDefined();
    expect(currentTransaction).toBeDefined();
    const wrongPhase = { ...currentTransaction, phase: "registry_committing" as const };
    const wrongPhaseSession = {
      ...fixture.session,
      checkpoint: { ...currentCheckpoint, sandboxRecreate: wrongPhase },
    };
    fixture.replaceStoredSession(wrongPhaseSession);
    expect(() => fixture.lifecycle.recordExactIdentity(TARGET_ID)).toThrow(
      /from phase 'registry_committing'/u,
    );
    expect(wrongPhaseSession.checkpoint.sandboxRecreate).toEqual(wrongPhase);
  });

  it.each([
    [
      "session",
      (session: TestSession) => ({
        ...structuredClone(session),
        sessionId: "replacement-session",
      }),
    ],
    ["transaction", replaceTransaction],
  ])(
    "does not write when the owning %s is replaced before the identity CAS (#9833)",
    (_case, replace) => {
      const fixture = createdIdentityFixture();
      const original = structuredClone(fixture.session);
      const replacement = replace(fixture.session);
      fixture.sessionStore.compareAndSwapSession.mockImplementationOnce((matches) => {
        fixture.replaceStoredSession(replacement);
        expect(matches(replacement)).toBe(false);
        return "mismatch";
      });

      expect(() => fixture.lifecycle.recordExactIdentity(TARGET_ID)).toThrow(/changed/u);
      expect(fixture.session).toEqual(original);
      expect(replacement.checkpoint?.sandboxRecreate?.targetLiveIdentityFingerprint).toBeNull();
    },
  );

  it("fails closed when the identity writer cannot own the session lock (#9833)", () => {
    const fixture = createdIdentityFixture();
    const original = structuredClone(fixture.session);
    fixture.sessionStore.compareAndSwapSession.mockReturnValueOnce("busy");

    expect(() => fixture.lifecycle.recordExactIdentity(TARGET_ID)).toThrow(/session lock/u);
    expect(fixture.session).toEqual(original);
  });

  it("fails closed without a writer-safe recreate journal (#9833)", () => {
    const session = createSession({ sandboxName: "alpha" });
    const runtime = createSandboxRecreateRuntime(
      {
        loadSession: () => session,
        updateSession: (mutator) => {
          mutator(session);
          return session;
        },
      },
      undefined,
      "alpha",
      CREATED_TARGET.gatewayName,
      null,
      () => ({ state: "ready", liveIdentityFingerprint: TARGET_ID }),
      () => undefined,
    );
    const lifecycle = createCreatedSandboxLifecycle(
      runtime,
      CREATED_TARGET,
      () => ({ state: "ready", liveIdentityFingerprint: TARGET_ID }),
      TARGET_GENERATION,
    );

    expect(() => lifecycle.recordExactIdentity(TARGET_ID)).toThrow(/active recreate transaction/u);
    expect(session.checkpoint?.sandboxRecreate ?? null).toBeNull();
  });
});
