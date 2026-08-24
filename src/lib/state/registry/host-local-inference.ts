// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  type HostLocalInferenceReceipt,
  parseHostLocalInferenceReceipt,
  serializeHostLocalInferenceReceipt,
} from "../../onboard/runtime-provider/host-local-inference";
import type { SandboxHostLocalInferenceProvenance } from "./types";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SANDBOX_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function receiptTransactionId(receipt: HostLocalInferenceReceipt): string | null {
  if (receipt.schemaVersion === 2) return receipt.publication?.transactionId ?? null;
  return receipt.runtime.kind === "container" ? (receipt.runtime.model?.generation ?? null) : null;
}

/**
 * Clone a canonical, secret-free provider-neutral receipt. The state boundary
 * validates the complete schema before accepting durable authority.
 */
export function cloneSandboxHostLocalInferenceReceipt(
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  try {
    return serializeHostLocalInferenceReceipt(parseHostLocalInferenceReceipt(value));
  } catch {
    return undefined;
  }
}

/** Clone and strictly validate the private durable lifecycle discriminator. */
export function cloneSandboxHostLocalInferenceProvenance(
  value: unknown,
): SandboxHostLocalInferenceProvenance | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      ["origin", "receiptSha256", "runtimeOwnerSandboxName", "schemaVersion", "transactionId"].join(
        ",",
      ) ||
    record.schemaVersion !== 1 ||
    record.origin !== "startup-selection" ||
    typeof record.runtimeOwnerSandboxName !== "string" ||
    !SAFE_SANDBOX_NAME.test(record.runtimeOwnerSandboxName) ||
    typeof record.transactionId !== "string" ||
    !SHA256.test(record.transactionId) ||
    typeof record.receiptSha256 !== "string" ||
    !SHA256.test(record.receiptSha256)
  ) {
    return undefined;
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    origin: "startup-selection" as const,
    runtimeOwnerSandboxName: record.runtimeOwnerSandboxName,
    transactionId: record.transactionId,
    receiptSha256: record.receiptSha256,
  });
}

/** Build provenance only at the operation-scoped startup-selection boundary. */
export function createSandboxHostLocalInferenceProvenance(
  runtimeOwnerSandboxName: string,
  serializedReceipt: string,
): SandboxHostLocalInferenceProvenance {
  const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
  const transactionId = receiptTransactionId(receipt);
  if (!transactionId || !SHA256.test(transactionId)) {
    throw new Error("Host-local inference receipt has no durable create transaction");
  }
  const provenance = cloneSandboxHostLocalInferenceProvenance({
    schemaVersion: 1,
    origin: "startup-selection",
    runtimeOwnerSandboxName,
    transactionId,
    receiptSha256: createHash("sha256").update(serializedReceipt).digest("hex"),
  });
  if (!provenance) throw new Error("Host-local inference lifecycle provenance is malformed");
  return provenance;
}

/** Require a provenance record to remain paired with the exact receipt bytes and transaction. */
export function requireSandboxHostLocalInferenceProvenance(
  value: unknown,
  serializedReceipt: string,
): SandboxHostLocalInferenceProvenance {
  const provenance = cloneSandboxHostLocalInferenceProvenance(value);
  const receipt = parseHostLocalInferenceReceipt(serializedReceipt);
  if (
    !provenance ||
    provenance.receiptSha256 !== createHash("sha256").update(serializedReceipt).digest("hex") ||
    provenance.transactionId !== receiptTransactionId(receipt)
  ) {
    throw new Error("Host-local inference lifecycle provenance does not match its receipt");
  }
  return provenance;
}
