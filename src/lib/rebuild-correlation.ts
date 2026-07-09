// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Deterministic correlation and tamper evidence for local rebuild recovery.
// These digests are NOT a security MAC: no secret key is used. Never use them
// for authentication or authorization decisions.

import crypto from "node:crypto";

import type { RebuildTransactionRecordV1 } from "./state/rebuild-transaction";
import type { SandboxEntry } from "./state/registry";

export interface RebuildSessionCorrelation {
  transactionId: string;
  imageFingerprint: string;
  configurationFingerprint: string;
  replacementFingerprint: string | null;
}

const REBUILD_TRANSACTION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REBUILD_FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

function correlationString(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function optionalCorrelationFingerprint(value: unknown): string | null | undefined {
  return value == null
    ? null
    : (correlationString(value, REBUILD_FINGERPRINT_PATTERN) ?? undefined);
}

export function parseRebuildSessionCorrelation(value: unknown): RebuildSessionCorrelation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const transactionId = correlationString(record.transactionId, REBUILD_TRANSACTION_ID_PATTERN);
  const imageFingerprint = correlationString(record.imageFingerprint, REBUILD_FINGERPRINT_PATTERN);
  const configurationFingerprint = correlationString(
    record.configurationFingerprint,
    REBUILD_FINGERPRINT_PATTERN,
  );
  const replacementFingerprint = optionalCorrelationFingerprint(record.replacementFingerprint);
  return transactionId &&
    imageFingerprint &&
    configurationFingerprint &&
    replacementFingerprint !== undefined
    ? {
        transactionId,
        imageFingerprint,
        configurationFingerprint,
        replacementFingerprint,
      }
    : null;
}

export function rebuildSessionCorrelation(
  transaction: RebuildTransactionRecordV1,
): RebuildSessionCorrelation {
  return {
    transactionId: transaction.transactionId,
    imageFingerprint: transaction.intent.target.imageFingerprint,
    configurationFingerprint: transaction.intent.target.configurationFingerprint,
    replacementFingerprint: null,
  };
}

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

export function fingerprintRebuildRegistryEntry(value: SandboxEntry): string {
  return fingerprintRebuildValue(JSON.parse(JSON.stringify(value)));
}

/** Receipt identity excludes mutable restore/finalization fields such as policies and MCP state. */
export function fingerprintRebuildReplacement(entry: SandboxEntry): string {
  return fingerprintRebuildValue({
    name: entry.name,
    agent: entry.agent ?? null,
    agentVersion: entry.agentVersion ?? null,
    nemoclawVersion: entry.nemoclawVersion ?? null,
    imageTag: entry.imageTag ?? null,
    fromDockerfile: entry.fromDockerfile ?? null,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    endpointFingerprint:
      typeof entry.endpointUrl === "string" ? fingerprintRebuildValue(entry.endpointUrl) : null,
    credentialEnv: entry.credentialEnv ?? null,
    preferredInferenceApi: entry.preferredInferenceApi ?? null,
    compatibleEndpointReasoning: entry.compatibleEndpointReasoning ?? null,
    gatewayName: entry.gatewayName ?? "nemoclaw",
    gatewayPort: entry.gatewayPort ?? 8080,
    toolDisclosure: entry.toolDisclosure ?? null,
    observabilityEnabled: entry.observabilityEnabled === true,
    policyTier: entry.policyTier ?? null,
  });
}
