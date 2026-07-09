// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Deterministic local-state correlation only. Digests in this module are not a
// security MAC and must never authorize or authenticate a caller.

import crypto from "node:crypto";

import type { RebuildTransactionRecordV1 } from "./state/rebuild-transaction";
import type { SandboxEntry } from "./state/registry";

export interface RebuildSessionCorrelation {
  transactionId: string;
  imageFingerprint: string;
  configurationFingerprint: string;
  replacementFingerprint: string | null;
}

function correlationString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseRebuildSessionCorrelation(value: unknown): RebuildSessionCorrelation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const transactionId = correlationString(record.transactionId);
  const imageFingerprint = correlationString(record.imageFingerprint);
  const configurationFingerprint = correlationString(record.configurationFingerprint);
  return transactionId && imageFingerprint && configurationFingerprint
    ? {
        transactionId,
        imageFingerprint,
        configurationFingerprint,
        replacementFingerprint: correlationString(record.replacementFingerprint),
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

function normalizedAgent(agent: string | null | undefined): string {
  return agent || "openclaw";
}

/** Receipt identity excludes mutable restore/finalization fields such as policies and MCP state. */
export function fingerprintRebuildReplacement(entry: SandboxEntry): string {
  return fingerprintRebuildValue({
    name: entry.name,
    agent: normalizedAgent(entry.agent),
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
  });
}
