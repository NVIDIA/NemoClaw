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
    startOrResume: vi.fn(),
    markReplacementCreated: vi.fn(),
    markReplacementRecreated: vi.fn(),
  } as unknown as RebuildTransactionCoordinator;
  const orchestrator = new RebuildRecoveryOrchestrator({
    plan: "recreate",
    transaction,
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
  it("publishes an adopted replacement receipt only after start-or-resume routing", async () => {
    const calls: string[] = [];
    const transaction = {
      record: { ...record, phase: "old_deleted" },
      startOrResume: vi.fn(async () => calls.push("start-or-resume")),
      markReplacementCreated: vi.fn(async () => calls.push("replacement-receipt")),
    } as unknown as RebuildTransactionCoordinator;
    const orchestrator = new RebuildRecoveryOrchestrator({
      plan: "adopt",
      transaction,
      sandboxName: "alpha",
      readRegistryEntry: () => replacement,
      readSession: () => session,
      bail: (message) => {
        throw new Error(message);
      },
      log: vi.fn(),
    });

    await orchestrator.prepare({} as Parameters<RebuildRecoveryOrchestrator["prepare"]>[0]);

    expect(calls).toEqual(["start-or-resume", "replacement-receipt"]);
  });

  it("publishes a compensation receipt only after re-verifying registry and session evidence", async () => {
    const { orchestrator, transaction } = makeOrchestrator(replacement);

    await orchestrator.publishCreatedReplacement();

    expect(transaction.markReplacementRecreated).toHaveBeenCalledWith(replacement);
  });

  it.each([
    ["model", { model: "other" }],
    ["credentialEnv", { credentialEnv: "OTHER_API_KEY" }],
    ["provider", { provider: "nvidia" }],
    ["gatewayName", { gatewayName: "nemoclaw-18080" }],
    ["gatewayPort", { gatewayPort: 18080 }],
    ["missing gateway", { gatewayName: undefined, gatewayPort: undefined }],
    ["toolDisclosure", { toolDisclosure: "direct" as const }],
    ["observabilityEnabled", { observabilityEnabled: true }],
  ])("refuses receipt publication after %s identity drift", async (_field, drift) => {
    const { orchestrator, transaction } = makeOrchestrator({ ...replacement, ...drift });

    await expect(orchestrator.publishCreatedReplacement()).rejects.toThrow(
      "identity changed before its durable receipt",
    );
    expect(transaction.markReplacementRecreated).not.toHaveBeenCalled();
  });
});
