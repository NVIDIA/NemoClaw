// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";

import type { SandboxEntry } from "../../state/registry";

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
