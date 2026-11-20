// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { upgradeLegacyTeamsOpenClawWebhookRender } from "../../messaging/channels/teams/contract";
import { canonicalizeJson, readStoredManagedStartupProfileMetadata } from "./profile";

export interface StoredManagedStartupProfile {
  /** The profile as stored, or its current-form equivalent when the stored form was old. */
  readonly encodedProfile: string;
  readonly agent: ReturnType<typeof readStoredManagedStartupProfileMetadata>["agent"];
  readonly corporateCaBundleSha256: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function encodeCanonical(value: unknown): string {
  return Buffer.from(JSON.stringify(canonicalizeJson(value)), "utf8").toString("base64url");
}

/**
 * Re-encode a stored profile with its pre-2026.10.5 Teams render converted, or return null.
 *
 * The stored input must already be in canonical form: re-encoding the parsed
 * value with the profile reader's own canonicalization has to reproduce it
 * exactly, which rules out padding, the standard alphabet, spare bits,
 * whitespace, unsorted or duplicate keys and invalid UTF-8. Only the one known
 * render difference is converted, and the profile reader then validates the
 * result in full, size limits included.
 */
function upgradeStoredTeamsRender(encoded: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (encodeCanonical(parsed) !== encoded) return null;
  if (!isRecord(parsed) || !isRecord(parsed.messaging) || !isRecord(parsed.messaging.plan)) {
    return null;
  }
  const agentRender = parsed.messaging.plan.agentRender;
  if (!Array.isArray(agentRender)) return null;
  let upgraded = false;
  parsed.messaging.plan.agentRender = agentRender.map((entry: unknown) => {
    const converted = upgradeLegacyTeamsOpenClawWebhookRender(entry);
    if (converted === null) return entry;
    upgraded = true;
    return converted;
  });
  return upgraded ? encodeCanonical(parsed) : null;
}

/**
 * Read a stored workload receipt's startup profile, including a Teams profile
 * recorded before OpenClaw 2026.10.5.
 *
 * That profile is converted to the current form before it is validated, and
 * the converted encoding is returned so the receipt can carry it. The profile
 * validator that managed startup runs stays strict and still rejects the old
 * shape. Every other failure keeps its original error.
 */
export function readStoredWorkloadProfile(encoded: string): StoredManagedStartupProfile {
  try {
    return { encodedProfile: encoded, ...readStoredManagedStartupProfileMetadata(encoded) };
  } catch (error) {
    const upgraded = upgradeStoredTeamsRender(encoded);
    if (upgraded === null) throw error;
    try {
      return { encodedProfile: upgraded, ...readStoredManagedStartupProfileMetadata(upgraded) };
    } catch {
      throw error;
    }
  }
}
