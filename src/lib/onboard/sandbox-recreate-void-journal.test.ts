// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CheckpointSandboxRecreatePhase,
  CheckpointSandboxRecreateTransaction,
} from "../state/onboard-checkpoint-types";
import { createSession } from "../state/onboard-session";
import type { SandboxEntry } from "../state/registry";
import {
  beginSandboxRecreateDelete,
  beginSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  fingerprintSandboxRegistryEntry,
  ownSandboxRecreateTransaction,
  planSandboxRecreateRecovery,
  type SandboxRecreateObservation,
} from "./sandbox-recreate-transaction";

const ISO = "2026-07-27T20:00:00.000Z";
const TX_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_GENERATION = "22222222-2222-4222-8222-222222222222";
const SOURCE_GENERATION = "44444444-4444-4444-8444-444444444444";
const SOURCE_ID = fingerprintSandboxRecreateValue("openshell-source-id");
const TARGET_ID = fingerprintSandboxRecreateValue("target-id");
const FOREIGN_ID = fingerprintSandboxRecreateValue("foreign-openshell-id");
const TARGET_INTENT = fingerprintSandboxRecreateValue({ agent: "openclaw", provider: "nvidia" });
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
};

/** The same row once its own lifecycle registration committed. */
const REGISTERED_SOURCE_ENTRY: SandboxEntry = {
  ...SOURCE_ENTRY,
  lifecycleGeneration: SOURCE_GENERATION,
  lifecycleLiveIdentityFingerprint: SOURCE_ID,
};

const LIVE_SOURCE: SandboxRecreateObservation = {
  state: "ready",
  liveIdentityFingerprint: SOURCE_ID,
};
const ABSENT_SOURCE: SandboxRecreateObservation = {
  state: "missing",
  liveIdentityFingerprint: null,
};

/** The gateway every journal, row, and probe in this suite belongs to. */
const JOURNAL_GATEWAY = { gatewayName: "nemoclaw-31818", gatewayPort: 31818 } as const;
/** A second gateway that never owns the journal under test. */
const FOREIGN_GATEWAY = { gatewayName: "nemoclaw-9090", gatewayPort: 9090 } as const;

function transactionAt(
  phase: CheckpointSandboxRecreatePhase,
  sourceEntry: SandboxEntry = REGISTERED_SOURCE_ENTRY,
): CheckpointSandboxRecreateTransaction {
  return {
    version: 1,
    id: TX_ID,
    revision: 3,
    sandboxName: "alpha",
    gatewayName: "nemoclaw-31818",
    gatewayPort: 31818,
    sourceRegistryFingerprint: fingerprintSandboxRegistryEntry(sourceEntry),
    sourceLiveIdentityFingerprint: SOURCE_ID,
    sourceWorkload: null,
    targetIntentFingerprint: TARGET_INTENT,
    targetGeneration: TARGET_GENERATION,
    targetLiveIdentityFingerprint: TARGET_ID,
    phase,
    startedAt: ISO,
    updatedAt: ISO,
  };
}

describe("sandbox recreate recovery from a void journal", () => {
  it.each(["deleted", "creating"] as const)(
    "keeps refusing durable source-row drift from %s (#10473)",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          transactionAt(phase),
          LIVE_SOURCE,
          {
            ...REGISTERED_SOURCE_ENTRY,
            imageTag: "changed-out-of-band",
          },
          JOURNAL_GATEWAY,
        ),
      ).toMatchObject({
        action: "reject",
        reason: expect.stringMatching(/preserved source registry row changed/),
      });
    },
  );

  it.each(["deleted", "creating"] as const)(
    "restarts from %s when the preserved row still describes the live source (#10473)",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          transactionAt(phase),
          { state: "not_ready", liveIdentityFingerprint: SOURCE_ID },
          REGISTERED_SOURCE_ENTRY,
          JOURNAL_GATEWAY,
        ),
      ).toEqual({ action: "restart_from_source" });
    },
  );

  it.each(["planned", "deleting"] as const)(
    "still continues source deletion from %s once the source row carries its live identity (#10473)",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          transactionAt(phase),
          LIVE_SOURCE,
          REGISTERED_SOURCE_ENTRY,
          JOURNAL_GATEWAY,
        ),
      ).toEqual({ action: "continue_delete" });
    },
  );

  it.each(["planned", "deleting", "deleted", "creating"] as const)(
    "still continues target creation from %s once the source row carries its live identity (#10473)",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          transactionAt(phase),
          ABSENT_SOURCE,
          REGISTERED_SOURCE_ENTRY,
          JOURNAL_GATEWAY,
        ),
      ).toEqual({ action: "continue_create" });
    },
  );

  it("keeps refusing a changed source row while the source stays absent (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("deleted"),
        ABSENT_SOURCE,
        {
          ...REGISTERED_SOURCE_ENTRY,
          imageTag: "changed-out-of-band",
        },
        JOURNAL_GATEWAY,
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/preserved source registry row changed/),
    });
  });

  it("keeps refusing an unregistered replacement that holds the source name (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("creating"),
        { state: "ready", liveIdentityFingerprint: fingerprintSandboxRecreateValue("new-id") },
        REGISTERED_SOURCE_ENTRY,
        JOURNAL_GATEWAY,
      ),
    ).toMatchObject({ action: "reject", reason: expect.stringMatching(/appeared/) });
  });

  it("keeps refusing a live sandbox the preserved row does not identify (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("deleted"),
        LIVE_SOURCE,
        {
          ...REGISTERED_SOURCE_ENTRY,
          lifecycleLiveIdentityFingerprint: FOREIGN_ID,
          imageTag: "changed-out-of-band",
        },
        JOURNAL_GATEWAY,
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/preserved source registry row changed/),
    });
  });

  it("keeps refusing a source row that never recorded a live identity (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("deleted", SOURCE_ENTRY),
        LIVE_SOURCE,
        {
          ...SOURCE_ENTRY,
          imageTag: "changed-out-of-band",
        },
        JOURNAL_GATEWAY,
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/preserved source registry row changed/),
    });
  });

  it("keeps refusing when the live sandbox is the journaled replacement (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("created"),
        { state: "ready", liveIdentityFingerprint: TARGET_ID },
        { ...REGISTERED_SOURCE_ENTRY, lifecycleLiveIdentityFingerprint: TARGET_ID },
        JOURNAL_GATEWAY,
      ),
    ).toMatchObject({
      action: "reject",
      reason: expect.stringMatching(/did not commit the journaled generation/),
    });
  });

  it.each(["deleted", "creating"] as const)(
    "restarts from %s before the journal records any replacement identity (#10473)",
    (phase) => {
      expect(
        planSandboxRecreateRecovery(
          { ...transactionAt(phase), targetLiveIdentityFingerprint: null },
          LIVE_SOURCE,
          REGISTERED_SOURCE_ENTRY,
          JOURNAL_GATEWAY,
        ),
      ).toEqual({ action: "restart_from_source" });
    },
  );

  it("keeps refusing when the journal names another sandbox (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        { ...transactionAt("creating"), sandboxName: "beta" },
        LIVE_SOURCE,
        REGISTERED_SOURCE_ENTRY,
        JOURNAL_GATEWAY,
      ),
    ).toMatchObject({ action: "reject", reason: expect.stringMatching(/appeared/) });
  });

  // The journal may still own an unregistered replacement on its own gateway.
  // `gatewayName`/`gatewayPort` are excluded from the source fingerprint, so
  // nothing else in the planner notices a row that moved gateways, and the
  // openers run this before `assertSameTransaction` could refuse (#10473).
  it("keeps refusing when the registry row names another gateway (#10473)", () => {
    const movedRow = { ...REGISTERED_SOURCE_ENTRY, ...FOREIGN_GATEWAY };
    // The row still satisfies the source-row proof, so only the gateway differs.
    expect(fingerprintSandboxRegistryEntry(movedRow)).toBe(
      fingerprintSandboxRegistryEntry(REGISTERED_SOURCE_ENTRY),
    );

    expect(
      planSandboxRecreateRecovery(
        transactionAt("creating"),
        LIVE_SOURCE,
        movedRow,
        FOREIGN_GATEWAY,
      ),
    ).toMatchObject({ action: "reject" });
  });

  it("keeps refusing when only the observed gateway differs (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("creating"),
        LIVE_SOURCE,
        REGISTERED_SOURCE_ENTRY,
        FOREIGN_GATEWAY,
      ),
    ).toMatchObject({ action: "reject" });
  });

  it("keeps refusing when the caller cannot name the observed gateway (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(transactionAt("creating"), LIVE_SOURCE, REGISTERED_SOURCE_ENTRY),
    ).toMatchObject({ action: "reject" });
  });

  it("resumes a journal recorded before messaging left the fingerprint (#10473)", () => {
    const messaging = {
      schemaVersion: 1,
      plan: {
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: "openclaw",
        workflow: "add-channel",
        disabledChannels: [],
        channels: [{ channelId: "teams", configured: true, disabled: false, active: true }],
      },
    };
    const rowWithChannel = { ...REGISTERED_SOURCE_ENTRY, messaging } as unknown as SandboxEntry;
    // The pre-#10473 digest covered the same fields plus `messaging`. This
    // fixture carries no receipt-bound field, so the projection is explicit.
    const legacyFingerprint = fingerprintSandboxRecreateValue({
      name: "alpha",
      agent: "openclaw",
      openshellDriver: "docker",
      imageTag: "openshell/sandbox-from:old",
      lifecycleGeneration: SOURCE_GENERATION,
      lifecycleLiveIdentityFingerprint: SOURCE_ID,
      messaging,
    });
    expect(fingerprintSandboxRegistryEntry(rowWithChannel)).not.toBe(legacyFingerprint);

    expect(
      planSandboxRecreateRecovery(
        { ...transactionAt("deleted"), sourceRegistryFingerprint: legacyFingerprint },
        ABSENT_SOURCE,
        rowWithChannel,
        JOURNAL_GATEWAY,
      ),
    ).toEqual({ action: "continue_create" });
  });

  it("keeps accepting the registered replacement over a restart (#10473)", () => {
    expect(
      planSandboxRecreateRecovery(
        transactionAt("creating"),
        { state: "ready", liveIdentityFingerprint: TARGET_ID },
        {
          ...REGISTERED_SOURCE_ENTRY,
          lifecycleGeneration: TARGET_GENERATION,
          lifecycleLiveIdentityFingerprint: TARGET_ID,
        },
        JOURNAL_GATEWAY,
      ),
    ).toEqual({ action: "accept_target" });
  });
});

describe("atomic recreate journal ownership", () => {
  function sessionWithTransaction() {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    beginSandboxRecreateTransaction(session, {
      sandboxName: "alpha",
      gatewayName: JOURNAL_GATEWAY.gatewayName,
      gatewayPort: JOURNAL_GATEWAY.gatewayPort,
      sourceEntry: REGISTERED_SOURCE_ENTRY,
      observation: LIVE_SOURCE,
      targetIntentFingerprint: TARGET_INTENT,
      id: TX_ID,
      targetGeneration: TARGET_GENERATION,
      now: ISO,
    });
    return session;
  }

  function storeFor(session: ReturnType<typeof sessionWithTransaction>) {
    return {
      loadSession: () => session,
      updateSession: (mutator: (current: typeof session) => typeof session | void) => {
        mutator(session);
        return session;
      },
      compareAndSwapSession: (
        matches: (current: typeof session) => boolean,
        mutator: (current: typeof session) => typeof session | void,
      ) => {
        return matches(session) ? (mutator(session), "updated" as const) : ("mismatch" as const);
      },
    };
  }

  it("replaces a void journal without exposing an empty journal (#10473)", () => {
    const session = sessionWithTransaction();
    session.checkpoint = {
      ...session.checkpoint!,
      sandboxRecreate: { ...session.checkpoint!.sandboxRecreate!, phase: "deleted" },
    };
    const seen: Array<string | null> = [];
    const baseStore = storeFor(session);
    const owned = ownSandboxRecreateTransaction({
      sessionStore: {
        ...baseStore,
        compareAndSwapSession: (matches, mutator) => {
          return matches(session)
            ? (seen.push(session.checkpoint?.sandboxRecreate?.id ?? null),
              mutator(session),
              seen.push(session.checkpoint?.sandboxRecreate?.id ?? null),
              "updated")
            : "mismatch";
        },
      },
      sandboxName: "alpha",
      ...JOURNAL_GATEWAY,
      targetIntentFingerprint: TARGET_INTENT,
      readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
      observe: () => LIVE_SOURCE,
      decorateCheckpoint: (_current, checkpoint) => checkpoint,
    });

    expect(owned.transaction.id).not.toBe(TX_ID);
    expect(seen).toEqual([TX_ID, owned.transaction.id]);
    expect(seen).not.toContain(null);
  });

  it("fails closed when the opening session changes before journal ownership (#10473)", () => {
    const session = sessionWithTransaction();
    const openingId = session.sessionId;
    const baseStore = storeFor(session);
    expect(() =>
      ownSandboxRecreateTransaction({
        sessionStore: {
          ...baseStore,
          compareAndSwapSession: (matches, mutator) => {
            session.sessionId = "replacement-session";
            return matches(session) ? (mutator(session), "updated") : "mismatch";
          },
        },
        sandboxName: "alpha",
        ...JOURNAL_GATEWAY,
        targetIntentFingerprint: TARGET_INTENT,
        readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
        observe: () => LIVE_SOURCE,
        decorateCheckpoint: (_current, checkpoint) => checkpoint,
      }),
    ).toThrow(/session or recreate transaction changed/);
    expect(openingId).not.toBe(session.sessionId);
    expect(session.checkpoint?.sandboxRecreate?.id).toBe(TX_ID);
  });

  it("fails closed when journal readback differs from the transaction written (#10473)", () => {
    const session = sessionWithTransaction();
    const baseStore = storeFor(session);
    let loads = 0;
    expect(() =>
      ownSandboxRecreateTransaction({
        sessionStore: {
          ...baseStore,
          loadSession: () => {
            loads += 1;
            const transaction = session.checkpoint!.sandboxRecreate!;
            return loads < 2
              ? session
              : {
                  ...session,
                  checkpoint: {
                    ...session.checkpoint!,
                    sandboxRecreate: { ...transaction, revision: transaction.revision + 1 },
                  },
                };
          },
        },
        sandboxName: "alpha",
        ...JOURNAL_GATEWAY,
        targetIntentFingerprint: TARGET_INTENT,
        readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
        observe: () => LIVE_SOURCE,
        decorateCheckpoint: (_current, checkpoint) => checkpoint,
      }),
    ).toThrow(/Cannot verify sandbox 'alpha' recreate transaction after the write/);
  });

  it.each(["busy", "mismatch"] as const)(
    "fails closed when the journal owner CAS returns %s (#10473)",
    (result) => {
      const session = sessionWithTransaction();
      expect(() =>
        ownSandboxRecreateTransaction({
          sessionStore: { ...storeFor(session), compareAndSwapSession: () => result },
          sandboxName: "alpha",
          ...JOURNAL_GATEWAY,
          targetIntentFingerprint: TARGET_INTENT,
          readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
          observe: () => LIVE_SOURCE,
          decorateCheckpoint: (_current, checkpoint) => checkpoint,
        }),
      ).toThrow(
        result === "busy" ? /owns the session lock/ : /session or recreate transaction changed/,
      );
      expect(session.checkpoint?.sandboxRecreate?.id).toBe(TX_ID);
    },
  );

  it("rejects journal replacement when the requested target intent changed (#10473)", () => {
    const session = sessionWithTransaction();
    session.checkpoint = {
      ...session.checkpoint!,
      sandboxRecreate: { ...session.checkpoint!.sandboxRecreate!, phase: "deleted" },
    };
    expect(() =>
      ownSandboxRecreateTransaction({
        sessionStore: storeFor(session),
        sandboxName: "alpha",
        ...JOURNAL_GATEWAY,
        targetIntentFingerprint: fingerprintSandboxRecreateValue("changed-intent"),
        readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
        observe: () => LIVE_SOURCE,
        decorateCheckpoint: (_current, checkpoint) => checkpoint,
      }),
    ).toThrow(/different recreate transaction in progress/);
    expect(session.checkpoint?.sandboxRecreate?.id).toBe(TX_ID);
  });

  it("rejects delete when the full transaction changes before CAS (#10473)", () => {
    const session = sessionWithTransaction();
    const expected = structuredClone(session.checkpoint!.sandboxRecreate!);
    session.checkpoint = {
      ...session.checkpoint!,
      sandboxRecreate: {
        ...session.checkpoint!.sandboxRecreate!,
        revision: session.checkpoint!.sandboxRecreate!.revision + 1,
      },
    };

    expect(() =>
      beginSandboxRecreateDelete({
        sessionStore: storeFor(session),
        openingSessionId: session.sessionId,
        expectedTransaction: expected,
        targetIntentFingerprint: TARGET_INTENT,
        readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
        observe: () => LIVE_SOURCE,
      }),
    ).toThrow(/session or recreate transaction changed/);
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });

  it("rejects delete when the target intent differs from the current journal (#10473)", () => {
    const session = sessionWithTransaction();
    const expected = structuredClone(session.checkpoint!.sandboxRecreate!);
    expect(() =>
      beginSandboxRecreateDelete({
        sessionStore: storeFor(session),
        openingSessionId: session.sessionId,
        expectedTransaction: expected,
        targetIntentFingerprint: fingerprintSandboxRecreateValue("changed-intent"),
        readRegistryEntry: () => REGISTERED_SOURCE_ENTRY,
        observe: () => LIVE_SOURCE,
      }),
    ).toThrow(/session or recreate transaction changed/);
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });

  it.each([
    ["registry row", { ...REGISTERED_SOURCE_ENTRY, imageTag: "foreign" }, LIVE_SOURCE],
    [
      "registry gateway",
      { ...REGISTERED_SOURCE_ENTRY, gatewayName: "foreign", gatewayPort: 9090 },
      LIVE_SOURCE,
    ],
    [
      "live identity",
      REGISTERED_SOURCE_ENTRY,
      { state: "ready", liveIdentityFingerprint: FOREIGN_ID },
    ],
  ] as const)("rejects delete after fresh %s drift (#10473)", (_label, row, observation) => {
    const session = sessionWithTransaction();
    const expected = structuredClone(session.checkpoint!.sandboxRecreate!);
    expect(() =>
      beginSandboxRecreateDelete({
        sessionStore: storeFor(session),
        openingSessionId: session.sessionId,
        expectedTransaction: expected,
        targetIntentFingerprint: TARGET_INTENT,
        readRegistryEntry: () => row as SandboxEntry,
        observe: () => observation,
      }),
    ).toThrow(/registry row changed|gateway authority changed|not the journaled source/);
    expect(session.checkpoint?.sandboxRecreate?.phase).toBe("planned");
  });
});

describe("source registry fingerprint across channel mutations", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("survives a channel the operator stops and starts between rebuilds (#10473)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-void-journal-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../state/registry");
      // The writer `channels stop` and `channels start` actually use.
      const { persistManifestChannelDisabledPlan } =
        await import("../actions/sandbox/policy-channel");
      registry.registerSandbox({
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        imageTag: "nemoclaw/openclaw:2026.3.11",
        messaging: {
          schemaVersion: 1,
          plan: {
            schemaVersion: 1,
            sandboxName: "alpha",
            agent: "openclaw",
            workflow: "add-channel",
            disabledChannels: [],
            channels: [{ channelId: "teams", configured: true, disabled: false, active: true }],
          },
        },
      } as unknown as SandboxEntry);
      const initialRow = registry.getSandbox("alpha") as SandboxEntry;
      const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
      beginSandboxRecreateTransaction(session, {
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        sourceEntry: initialRow,
        observation: LIVE_SOURCE,
        targetIntentFingerprint: TARGET_INTENT,
        id: TX_ID,
        targetGeneration: TARGET_GENERATION,
        now: ISO,
      });
      const transaction = structuredClone(session.checkpoint!.sandboxRecreate!);

      expect(await persistManifestChannelDisabledPlan("alpha", "teams", true)).not.toBeNull();
      expect(registry.getDisabledChannels("alpha")).toEqual(["teams"]);
      expect(await persistManifestChannelDisabledPlan("alpha", "teams", false)).not.toBeNull();
      expect(registry.getDisabledChannels("alpha")).toEqual([]);

      const restarted = registry.getSandbox("alpha") as SandboxEntry;
      expect(restarted.messaging?.plan.workflow).toBe("start-channel");
      expect(
        planSandboxRecreateRecovery(transaction, LIVE_SOURCE, restarted, {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
        }),
      ).toEqual({ action: "continue_delete" });
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
