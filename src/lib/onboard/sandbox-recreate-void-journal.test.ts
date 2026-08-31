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
  advanceSandboxRecreateTransaction,
  beginSandboxRecreateTransaction,
  createSandboxRecreateRuntime,
  discardVoidSandboxRecreateTransaction,
  fingerprintSandboxRecreateValue,
  fingerprintSandboxRegistryEntry,
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
const EVERY_PHASE = [
  "planned",
  "deleting",
  "deleted",
  "creating",
  "created",
  "registry_committing",
  "completed",
] as const;

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
  it.each(EVERY_PHASE)(
    "restarts from %s when the registered source outlived a journal it can no longer resume (#10473)",
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
      ).toEqual({ action: "restart_from_source" });
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

describe("discarding a void recreate journal", () => {
  function strandedSession() {
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    beginSandboxRecreateTransaction(session, {
      sandboxName: "alpha",
      gatewayName: "nemoclaw-31818",
      gatewayPort: 31818,
      sourceEntry: REGISTERED_SOURCE_ENTRY,
      observation: ABSENT_SOURCE,
      targetIntentFingerprint: TARGET_INTENT,
      now: ISO,
      id: TX_ID,
      targetGeneration: TARGET_GENERATION,
    });
    advanceSandboxRecreateTransaction(session, TX_ID, "creating");
    return session;
  }

  it("clears a journal whose registered source is still live (#10473)", () => {
    const session = strandedSession();

    discardVoidSandboxRecreateTransaction(
      session,
      TX_ID,
      LIVE_SOURCE,
      REGISTERED_SOURCE_ENTRY,
      JOURNAL_GATEWAY,
    );

    expect(session.checkpoint?.sandboxRecreate).toBeNull();
  });

  it("refuses to discard a journal whose replacement is not disproven (#10473)", () => {
    const session = strandedSession();

    expect(() =>
      discardVoidSandboxRecreateTransaction(
        session,
        TX_ID,
        ABSENT_SOURCE,
        REGISTERED_SOURCE_ENTRY,
        JOURNAL_GATEWAY,
      ),
    ).toThrow(/still owns a replacement/);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "creating" });
  });

  it("refuses to resume a handed-off runtime whose journal is void (#10473)", () => {
    const session = strandedSession();

    expect(() =>
      createSandboxRecreateRuntime(
        { loadSession: () => session, updateSession: () => session },
        {
          id: TX_ID,
          targetGeneration: TARGET_GENERATION,
          targetIntentFingerprint: TARGET_INTENT,
        },
        "alpha",
        "nemoclaw-31818",
        REGISTERED_SOURCE_ENTRY,
        () => LIVE_SOURCE,
        () => undefined,
      ),
    ).toThrow(/no longer owns a replacement/);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "creating" });
  });

  it("refuses to discard a journal against another sandbox's row (#10473)", () => {
    const session = strandedSession();

    expect(() =>
      discardVoidSandboxRecreateTransaction(
        session,
        TX_ID,
        LIVE_SOURCE,
        {
          ...REGISTERED_SOURCE_ENTRY,
          name: "beta",
        },
        JOURNAL_GATEWAY,
      ),
    ).toThrow(/still owns a replacement/);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "creating" });
  });

  it("refuses to discard a journal against another gateway's row (#10473)", () => {
    const session = strandedSession();

    expect(() =>
      discardVoidSandboxRecreateTransaction(
        session,
        TX_ID,
        LIVE_SOURCE,
        { ...REGISTERED_SOURCE_ENTRY, ...FOREIGN_GATEWAY },
        FOREIGN_GATEWAY,
      ),
    ).toThrow(/still owns a replacement/);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "creating" });
  });

  it("refuses to discard a journal from another gateway's probe (#10473)", () => {
    const session = strandedSession();

    expect(() =>
      discardVoidSandboxRecreateTransaction(
        session,
        TX_ID,
        LIVE_SOURCE,
        REGISTERED_SOURCE_ENTRY,
        FOREIGN_GATEWAY,
      ),
    ).toThrow(/still owns a replacement/);
    expect(session.checkpoint?.sandboxRecreate).toMatchObject({ phase: "creating" });
  });

  it("refuses to discard a journal owned by another transaction (#10473)", () => {
    const session = strandedSession();

    expect(() =>
      discardVoidSandboxRecreateTransaction(
        session,
        "33333333-3333-4333-8333-333333333333",
        LIVE_SOURCE,
        REGISTERED_SOURCE_ENTRY,
        JOURNAL_GATEWAY,
      ),
    ).toThrow(/ownership changed/);
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
      const journaled = fingerprintSandboxRegistryEntry(
        registry.getSandbox("alpha") as SandboxEntry,
      );

      expect(await persistManifestChannelDisabledPlan("alpha", "teams", true)).not.toBeNull();
      expect(registry.getDisabledChannels("alpha")).toEqual(["teams"]);
      expect(await persistManifestChannelDisabledPlan("alpha", "teams", false)).not.toBeNull();
      expect(registry.getDisabledChannels("alpha")).toEqual([]);

      const restarted = registry.getSandbox("alpha") as SandboxEntry;
      expect(restarted.messaging?.plan.workflow).toBe("start-channel");
      expect(fingerprintSandboxRegistryEntry(restarted)).toBe(journaled);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
