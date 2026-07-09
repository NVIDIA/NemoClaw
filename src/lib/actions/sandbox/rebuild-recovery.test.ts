// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import {
  decideRebuildRecovery,
  observeRebuildRegistry,
  observeRebuildSession,
} from "./rebuild-recovery";
import {
  fingerprintRebuildRegistryEntry,
  fingerprintRebuildReplacement,
  fingerprintRebuildValue,
} from "./rebuild-transaction-fingerprint";

function transaction(phase: "old_deleted" | "replacement_created"): RebuildTransactionRecordV1 {
  return { phase } as RebuildTransactionRecordV1;
}

describe("rebuild replacement recovery decision", () => {
  it.each([
    ["old_deleted", "absent", "source", "missing", "create"],
    ["old_deleted", "absent", "missing", "unrelated", "create"],
    ["old_deleted", "ready", "target", "matching", "adopt"],
    ["replacement_created", "ready", "replacement", "matching", "resume"],
    ["replacement_created", "absent", "replacement", "matching", "recreate"],
  ] as const)("%s plus %s live state, %s registry, and %s session selects %s (#6436)", (phase, live, registry, session, action) => {
    expect(
      decideRebuildRecovery({ transaction: transaction(phase), live, registry, session }),
    ).toEqual({ action });
  });

  it.each([
    ["old_deleted", "ready", "target", "unrelated", "REBUILD_RECOVERY_SESSION_MISMATCH"],
    ["old_deleted", "ready", "source", "matching", "REBUILD_RECOVERY_REGISTRY_MISMATCH"],
    ["old_deleted", "not_ready", "target", "matching", "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS"],
    ["replacement_created", "ready", "target", "matching", "REBUILD_RECOVERY_REGISTRY_MISMATCH"],
    [
      "replacement_created",
      "ready",
      "replacement",
      "unrelated",
      "REBUILD_RECOVERY_SESSION_MISMATCH",
    ],
    [
      "replacement_created",
      "unknown_present",
      "replacement",
      "matching",
      "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS",
    ],
  ] as const)("%s refuses %s live state, %s registry, and %s session with %s (#6436)", (phase, live, registry, session, code) => {
    expect(
      decideRebuildRecovery({ transaction: transaction(phase), live, registry, session }),
    ).toEqual({ action: "refuse", code });
  });

  it("classifies source, correlated target, receipted replacement, and mismatch evidence (#6436)", () => {
    const source: SandboxEntry = {
      name: "alpha",
      agent: null,
      provider: "ollama-local",
      model: "nvidia/nemotron",
      policies: ["old"],
      toolDisclosure: "progressive",
      observabilityEnabled: false,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
    };
    const target: SandboxEntry = { ...source, policies: ["new"] };
    const record = {
      transactionId: "11111111-1111-4111-8111-111111111111",
      intent: {
        sandboxName: "alpha",
        source: { registryFingerprint: fingerprintRebuildRegistryEntry(source) },
        target: {
          agent: null,
          provider: "ollama-local",
          model: "nvidia/nemotron",
          credentialEnv: null,
          endpointFingerprint: null,
          configurationFingerprint: fingerprintRebuildValue({
            fromDockerfile: null,
            preferredInferenceApi: null,
            compatibleEndpointReasoning: null,
            policyTier: null,
          }),
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          toolDisclosure: "progressive",
          observabilityEnabled: false,
        },
      },
      receipts: {},
    } as RebuildTransactionRecordV1;

    expect(observeRebuildRegistry(record, source)).toBe("source");
    expect(observeRebuildRegistry(record, target)).toBe("target");
    expect(observeRebuildRegistry(record, { ...target, model: "other" })).toBe("mismatch");

    const receipted = {
      ...record,
      receipts: {
        replacement: {
          identityFingerprint: fingerprintRebuildReplacement(target),
          observedAt: "2026-07-08T00:00:00.000Z",
        },
      },
    } as RebuildTransactionRecordV1;
    expect(observeRebuildRegistry(receipted, target)).toBe("replacement");
  });

  it("requires the same sandbox and transaction ID for session adoption (#6436)", () => {
    const record = {
      transactionId: "11111111-1111-4111-8111-111111111111",
      intent: {
        sandboxName: "alpha",
        target: {
          imageFingerprint:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          configurationFingerprint:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      },
    } as RebuildTransactionRecordV1;
    const session = {
      sandboxName: "alpha",
      metadata: {
        gatewayName: "nemoclaw",
        fromDockerfile: null,
        rebuildTransactionId: record.transactionId,
        rebuildImageFingerprint: record.intent.target.imageFingerprint,
        rebuildConfigurationFingerprint: record.intent.target.configurationFingerprint,
      },
    } as Parameters<typeof observeRebuildSession>[1];

    expect(observeRebuildSession(record, session)).toBe("matching");
    expect(
      observeRebuildSession(record, {
        ...session!,
        metadata: {
          gatewayName: "nemoclaw",
          fromDockerfile: null,
          rebuildTransactionId: "22222222-2222-4222-8222-222222222222",
          rebuildImageFingerprint: record.intent.target.imageFingerprint,
          rebuildConfigurationFingerprint: record.intent.target.configurationFingerprint,
        },
      }),
    ).toBe("unrelated");
    expect(observeRebuildSession(record, null)).toBe("missing");
  });
});
