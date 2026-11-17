// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

import { upgradeLegacyTeamsOpenClawWebhookRender } from "../../messaging/channels/teams/contract";
import {
  MANAGED_STARTUP_PROFILE_MAX_BYTES,
  MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES,
  readStoredManagedStartupProfileMetadata,
} from "./profile";

export interface StoredManagedStartupProfile {
  /** The profile as stored, or its current-form equivalent when the stored form was old. */
  readonly encodedProfile: string;
  readonly agent: ReturnType<typeof readStoredManagedStartupProfileMetadata>["agent"];
  readonly corporateCaBundleSha256: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Re-encode a stored profile with its pre-2026.10.5 Teams render converted, or return null.
 *
 * The stored input must be exactly as canonical as the profile reader requires:
 * a canonical unpadded base64url string, strict UTF-8, and sorted compact JSON.
 * Only the one known render difference is converted, so no other malformed
 * transport form can become a valid receipt through this path.
 */
function upgradeStoredTeamsRender(encoded: string): string | null {
  if (
    typeof encoded !== "string" ||
    encoded.length === 0 ||
    Buffer.byteLength(encoded, "ascii") > MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES ||
    !BASE64URL_RE.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    return null;
  }
  const bytes = Buffer.from(encoded, "base64url");
  if (
    bytes.length === 0 ||
    bytes.length > MANAGED_STARTUP_PROFILE_MAX_BYTES ||
    bytes.toString("base64url") !== encoded
  ) {
    return null;
  }
  let raw: string;
  let parsed: unknown;
  try {
    raw = UTF8_DECODER.decode(bytes);
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (JSON.stringify(sortKeysDeep(parsed)) !== raw) return null;
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
  if (!upgraded) return null;
  return Buffer.from(JSON.stringify(sortKeysDeep(parsed)), "utf8").toString("base64url");
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
