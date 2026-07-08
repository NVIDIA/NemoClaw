// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import {
  type RebuildTransactionIntentV1,
  type RebuildTransactionRecordV1,
  type RebuildTransactionStore,
} from "../../state/rebuild-transaction";
import * as sandboxState from "../../state/sandbox";
import type { RebuildBackupManifest } from "./rebuild-backup-phase";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintRebuildValue(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

export function loadRebuildRecovery(
  store: RebuildTransactionStore,
  sandboxName: string,
): {
  transaction: RebuildTransactionRecordV1 | null;
  recoveryManifest: sandboxState.RebuildManifest | null;
} {
  const transaction = store.load(sandboxName);
  if (!transaction || transaction.status === "completed") {
    return { transaction, recoveryManifest: null };
  }
  if (transaction.phase === "replacement_created") {
    throw new Error(
      `Rebuild transaction '${transaction.transactionId}' already created a replacement; automatic recovery is not supported yet.`,
    );
  }
  const recoveryManifest = sandboxState.getLatestBackup(sandboxName);
  if (
    !recoveryManifest ||
    recoveryManifest.timestamp !== transaction.receipts.backup.manifestTimestamp ||
    fingerprintRebuildValue(recoveryManifest) !== transaction.receipts.backup.manifestFingerprint
  ) {
    throw new Error(
      `Rebuild transaction '${transaction.transactionId}' no longer matches the latest validated backup.`,
    );
  }
  return { transaction, recoveryManifest };
}

export async function prepareRebuildTransaction(args: {
  store: RebuildTransactionStore;
  existing: RebuildTransactionRecordV1 | null;
  sandboxName: string;
  sandboxEntry: RebuildSandboxEntry;
  targetConfig: RebuildTargetConfig;
  recreateOptions: RebuildRecreateOnboardOpts;
  backupManifest: RebuildBackupManifest;
  imageIdentity: unknown;
}): Promise<RebuildTransactionRecordV1 | null> {
  if (!args.backupManifest) return null;
  const { resumeConfig, durableConfig } = args.targetConfig;
  const intent: RebuildTransactionIntentV1 = {
    sandboxName: args.sandboxName,
    source: {
      agent: args.sandboxEntry.agent ?? null,
      registryFingerprint: fingerprintRebuildValue(args.sandboxEntry),
    },
    target: {
      agent: resumeConfig.agent,
      provider: resumeConfig.provider,
      model: resumeConfig.model,
      credentialEnv: args.targetConfig.credentialEnv,
      endpointFingerprint: resumeConfig.endpointUrl
        ? fingerprintRebuildValue(resumeConfig.endpointUrl)
        : null,
      imageFingerprint: fingerprintRebuildValue(args.imageIdentity),
      configurationFingerprint: fingerprintRebuildValue({
        fromDockerfile: args.targetConfig.fromDockerfile,
        preferredInferenceApi: resumeConfig.preferredInferenceApi,
        compatibleEndpointReasoning: resumeConfig.compatibleEndpointReasoning,
        policyTier: args.recreateOptions.policyTier,
      }),
      gatewayName: args.recreateOptions.targetGatewayName,
      gatewayPort: args.recreateOptions.targetGatewayPort,
      toolDisclosure: durableConfig.toolDisclosure,
      observabilityEnabled: args.recreateOptions.observabilityEnabled,
    },
  };
  const receipts = {
    backup: {
      manifestTimestamp: args.backupManifest.timestamp,
      manifestFingerprint: fingerprintRebuildValue(args.backupManifest),
    },
  };
  if (!args.existing || args.existing.status === "completed") {
    return args.store.create(intent, receipts);
  }
  if (fingerprintRebuildValue(args.existing.intent) !== fingerprintRebuildValue(intent)) {
    throw new Error(
      `Rebuild transaction '${args.existing.transactionId}' intent changed; refusing another destructive effect.`,
    );
  }
  if (
    fingerprintRebuildValue(args.existing.receipts.backup) !==
    fingerprintRebuildValue(receipts.backup)
  ) {
    throw new Error(
      `Rebuild transaction '${args.existing.transactionId}' recovery inputs changed; refusing another destructive effect.`,
    );
  }
  return args.existing;
}
