// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { fingerprintRebuildReplacement, fingerprintRebuildValue } from "../../rebuild-correlation";
import type { Session } from "../../state/onboard-session";
import type { RebuildTransactionRecordV1 } from "../../state/rebuild-transaction";
import type { SandboxEntry } from "../../state/registry";
import { RebuildRecoveryOrchestrator } from "./rebuild-recovery-orchestrator";
import type { RebuildTransactionCoordinator } from "./rebuild-transaction-coordinator";

const replacement = {
  name: "alpha",
  agent: "openclaw",
  provider: "ollama-local",
  model: "nvidia/nemotron",
  credentialEnv: null,
  gatewayName: "nemoclaw",
  gatewayPort: 8080,
  toolDisclosure: "progressive",
  observabilityEnabled: false,
} as SandboxEntry;

const record = {
  status: "active",
  phase: "replacement_created",
  transactionId: "11111111-1111-4111-8111-111111111111",
  intent: {
    sandboxName: "alpha",
    target: {
      agent: "openclaw",
      provider: "ollama-local",
      model: "nvidia/nemotron",
      credentialEnv: null,
      endpointFingerprint: null,
      imageFingerprint: fingerprintRebuildValue("image"),
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
} as RebuildTransactionRecordV1;

const session = {
  sandboxName: "alpha",
  metadata: {
    rebuild: {
      transactionId: record.transactionId,
      imageFingerprint: record.intent.target.imageFingerprint,
      configurationFingerprint: record.intent.target.configurationFingerprint,
      replacementFingerprint: fingerprintRebuildReplacement(replacement),
    },
  },
} as Session;

function makeOrchestrator(entry: SandboxEntry) {
  const transaction = {
    record,
    markReplacementCreated: vi.fn(),
    markReplacementRecreated: vi.fn(),
  } as unknown as RebuildTransactionCoordinator;
  const orchestrator = new RebuildRecoveryOrchestrator({
    plan: { action: "recreate", replacementAlreadyPresent: false, registryRestored: false },
    transaction,
    recoveredTransaction: record,
    sandboxName: "alpha",
    readRegistryEntry: () => entry,
    readSession: () => session,
    bail: (message) => {
      throw new Error(message);
    },
    log: vi.fn(),
  });
  return { orchestrator, transaction };
}

describe("rebuild recovery receipt publication", () => {
  it("publishes a compensation receipt only after re-verifying registry and session evidence", async () => {
    const { orchestrator, transaction } = makeOrchestrator(replacement);

    await orchestrator.publishCreatedReplacement();

    expect(transaction.markReplacementRecreated).toHaveBeenCalledWith(replacement);
  });

  it("refuses receipt publication after replacement identity drift", async () => {
    const { orchestrator, transaction } = makeOrchestrator({ ...replacement, model: "other" });

    await expect(orchestrator.publishCreatedReplacement()).rejects.toThrow(
      "identity changed before its durable receipt",
    );
    expect(transaction.markReplacementRecreated).not.toHaveBeenCalled();
  });
});
