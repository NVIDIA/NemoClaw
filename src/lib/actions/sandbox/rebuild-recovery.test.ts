// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  fingerprintRebuildRegistryEntry,
  fingerprintRebuildReplacement,
  fingerprintRebuildValue,
  parseRebuildSessionCorrelation,
} from "../../rebuild-correlation";
import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import {
  decideRebuildRecovery,
  observeRebuildRegistry,
  observeRebuildSession,
} from "./rebuild-recovery";

function transaction(phase: "old_deleted" | "replacement_created"): RebuildTransactionRecordV1 {
  return { phase } as RebuildTransactionRecordV1;
}

function reverseObjectKeys(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(reverseObjectKeys)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .reverse()
            .map(([key, item]) => [key, reverseObjectKeys(item)]),
        )
      : value;
}

describe("rebuild replacement recovery decision", () => {
  it("exhaustively pins all 120 phase and observation combinations (#6580)", () => {
    const phases = ["old_deleted", "replacement_created"] as const;
    const lives = ["absent", "not_ready", "ready", "unknown_present"] as const;
    const registries = ["mismatch", "missing", "replacement", "source", "target"] as const;
    const sessions = ["matching", "missing", "unrelated"] as const;
    let cases = 0;
    for (const phase of phases)
      for (const live of lives)
        for (const registry of registries)
          for (const session of sessions) {
            cases++;
            const expected =
              phase === "old_deleted"
                ? live === "absent" && ["source", "missing", "target"].includes(registry)
                  ? "create"
                  : live === "ready" && registry === "target" && session === "matching"
                    ? "adopt"
                    : "refuse"
                : registry === "replacement" && session === "matching"
                  ? live === "ready"
                    ? "resume"
                    : live === "absent"
                      ? "recreate"
                      : "refuse"
                  : "refuse";
            expect(
              decideRebuildRecovery({ transaction: transaction(phase), live, registry, session })
                .action,
            ).toBe(expected);
          }
    expect(cases).toBe(120);
  });

  it("rejects malformed persisted rebuild correlation identifiers (#6436)", () => {
    const valid = {
      transactionId: "11111111-1111-4111-8111-111111111111",
      imageFingerprint: `sha256:${"a".repeat(64)}`,
      configurationFingerprint: `sha256:${"b".repeat(64)}`,
      replacementFingerprint: null,
    };

    expect(parseRebuildSessionCorrelation(valid)).toEqual(valid);
    expect(parseRebuildSessionCorrelation({ ...valid, transactionId: "transaction" })).toBeNull();
    expect(parseRebuildSessionCorrelation({ ...valid, imageFingerprint: "sha256:bad" })).toBeNull();
    expect(
      parseRebuildSessionCorrelation({ ...valid, replacementFingerprint: "sha256:bad" }),
    ).toBeNull();
  });

  it.each([
    ["old_deleted", "ready", "target", "unrelated", "REBUILD_RECOVERY_SESSION_MISMATCH"],
    ["old_deleted", "ready", "source", "matching", "REBUILD_RECOVERY_REGISTRY_MISMATCH"],
    ["old_deleted", "absent", "mismatch", "unrelated", "REBUILD_RECOVERY_REGISTRY_CORRUPTED"],
    ["old_deleted", "not_ready", "target", "matching", "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS"],
    [
      "old_deleted",
      "unknown_present",
      "target",
      "matching",
      "REBUILD_RECOVERY_LIVE_STATE_AMBIGUOUS",
    ],
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
    expect(fingerprintRebuildReplacement({ ...target, agent: null })).not.toBe(
      fingerprintRebuildReplacement({ ...target, agent: "openclaw" }),
    );
    expect(fingerprintRebuildReplacement({ ...target, agent: undefined })).toBe(
      fingerprintRebuildReplacement({ ...target, agent: null }),
    );
    expect(
      observeRebuildRegistry(
        {
          ...record,
          intent: { ...record.intent, target: { ...record.intent.target, agent: "openclaw" } },
        },
        target,
      ),
    ).toBe("mismatch");

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
    const missingGateway = { ...target, gatewayName: undefined, gatewayPort: undefined };
    expect(fingerprintRebuildReplacement(missingGateway)).not.toBe(
      fingerprintRebuildReplacement(target),
    );
    expect(observeRebuildRegistry(receipted, missingGateway)).toBe("mismatch");
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
    const replacement = {
      name: "alpha",
      agent: null,
      agentVersion: "0.2.0",
      nemoclawVersion: "0.2.0",
      imageTag: "nemoclaw-alpha:replacement",
    } as SandboxEntry;
    const session = {
      sandboxName: "alpha",
      metadata: {
        gatewayName: "nemoclaw",
        fromDockerfile: null,
        rebuild: {
          transactionId: record.transactionId,
          imageFingerprint: record.intent.target.imageFingerprint,
          configurationFingerprint: record.intent.target.configurationFingerprint,
          replacementFingerprint: fingerprintRebuildReplacement(replacement),
        },
      },
    } as Parameters<typeof observeRebuildSession>[1];

    expect(observeRebuildSession(record, session, replacement)).toBe("matching");
    expect(observeRebuildSession(record, session, { ...replacement, imageTag: "unrelated" })).toBe(
      "unrelated",
    );
    expect(
      observeRebuildSession(
        record,
        {
          ...session!,
          metadata: {
            ...session!.metadata,
            rebuild: {
              ...session!.metadata.rebuild!,
              transactionId: "22222222-2222-4222-8222-222222222222",
            },
          },
        },
        replacement,
      ),
    ).toBe("unrelated");
    expect(observeRebuildSession(record, null, replacement)).toBe("missing");
  });

  it("keeps rebuild fingerprints stable across nested key insertion order (#6436)", () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1 }),
          agent: fc.option(fc.string(), { nil: null }),
          agentVersion: fc.option(fc.string(), { nil: null }),
          nemoclawVersion: fc.option(fc.string(), { nil: null }),
          imageTag: fc.option(fc.string(), { nil: null }),
          provider: fc.option(fc.string(), { nil: null }),
          model: fc.option(fc.string(), { nil: null }),
          nested: fc.jsonValue(),
        }),
        (entry) => {
          const reversed = reverseObjectKeys(entry) as SandboxEntry;
          expect(fingerprintRebuildValue(entry)).toBe(fingerprintRebuildValue(reversed));
          expect(fingerprintRebuildRegistryEntry(entry as SandboxEntry)).toBe(
            fingerprintRebuildRegistryEntry(reversed),
          );
          expect(fingerprintRebuildReplacement(entry as SandboxEntry)).toBe(
            fingerprintRebuildReplacement(reversed),
          );
        },
      ),
    );
  });
});
