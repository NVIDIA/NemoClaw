// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import {
  MANAGED_STARTUP_PROFILE_MAX_BYTES,
  MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES,
  readStoredManagedStartupProfileMetadata,
} from "./profile";

type StoredManagedStartupProfileMetadata = ReturnType<
  typeof readStoredManagedStartupProfileMetadata
>;

// The stock Teams webhook path. The profile validator still checks the full
// render identity, so this only recognises the one field that moved.
const TEAMS_WEBHOOK_PATH = "/api/messages";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTcpPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeysDeep(value[key])]),
  );
}

/**
 * Move the listener port of a Teams render written before OpenClaw 2026.10.5
 * (`webhook: { path, port }`) to where the current render keeps it
 * (`webhook: { path }` plus `legacyWebhook: { port }`).
 */
function upgradeTeamsWebhookRender(entry: unknown): boolean {
  if (!isRecord(entry) || !isRecord(entry.value)) return false;
  const value = entry.value;
  const webhook = value.webhook;
  if (
    Object.hasOwn(value, "legacyWebhook") ||
    !isRecord(webhook) ||
    Object.keys(webhook).sort().join() !== "path,port" ||
    webhook.path !== TEAMS_WEBHOOK_PATH ||
    !isTcpPort(webhook.port)
  ) {
    return false;
  }
  value.webhook = { path: webhook.path };
  value.legacyWebhook = { port: webhook.port };
  return true;
}

function upgradeStoredTeamsProfile(encoded: string): string | null {
  if (
    encoded.length === 0 ||
    Buffer.byteLength(encoded, "ascii") > MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES
  ) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length === 0 || bytes.length > MANAGED_STARTUP_PROFILE_MAX_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.messaging) || !isRecord(parsed.messaging.plan)) {
    return null;
  }
  const agentRender = parsed.messaging.plan.agentRender;
  if (!Array.isArray(agentRender)) return null;
  let upgraded = false;
  for (const entry of agentRender) {
    if (upgradeTeamsWebhookRender(entry)) upgraded = true;
  }
  if (!upgraded) return null;
  return Buffer.from(JSON.stringify(sortKeysDeep(parsed)), "utf8").toString("base64url");
}

/**
 * Read the identity of a stored workload receipt's startup profile, including
 * Teams profiles recorded before OpenClaw 2026.10.5.
 *
 * The stored profile is read for its agent and corporate CA digest only and is
 * never executed, and the registry keeps a digest of the exact stored text, so
 * the old shape is upgraded in memory for validation and never written back.
 * The profile validator that managed startup runs stays strict, and it still
 * rejects anything beyond the old port field.
 */
export function readStoredWorkloadProfileMetadata(
  encoded: string,
): StoredManagedStartupProfileMetadata {
  try {
    return readStoredManagedStartupProfileMetadata(encoded);
  } catch (error) {
    const upgraded = upgradeStoredTeamsProfile(encoded);
    if (upgraded === null) throw error;
    try {
      return readStoredManagedStartupProfileMetadata(upgraded);
    } catch {
      throw error;
    }
  }
}
