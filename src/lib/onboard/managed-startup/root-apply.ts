// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import {
  decodeManagedStartupProfile,
  fingerprintManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  MANAGED_STARTUP_PROFILE_DEFERRED_RUNTIME_INPUTS,
  MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES,
  type ManagedStartupAgent,
} from "./profile";

export const MANAGED_STARTUP_ROOT_APPLY_SCHEMA_VERSION = 1 as const;

// One canonical profile (64 KiB decoded), one bounded corporate CA bundle
// (128 KiB decoded), and a small fixed JSON envelope.
export const MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES = 320 * 1024;

const MAX_CORPORATE_CA_ENCODED_BYTES = 4 * Math.ceil((128 * 1024) / 3);
const SHA256_RE = /^[a-f0-9]{64}$/u;
const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MCP_SHADOW_DIAGNOSTICS_ENV = "NEMOCLAW_MCP_SHADOW_DIAGNOSTICS";

export const MANAGED_STARTUP_APPLICATION_RUNTIME_ENV_KEYS = Object.freeze(
  MANAGED_STARTUP_PROFILE_DEFERRED_RUNTIME_INPUTS.openclaw
    .filter(
      ({ admission, owner }) =>
        admission === "managed-launch-forwarded" && owner === "application-environment",
    )
    .map(({ input }) => input),
);

export function selectManagedStartupApplicationRuntimeEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const selected: Record<string, string> = {};
  for (const name of MANAGED_STARTUP_APPLICATION_RUNTIME_ENV_KEYS) {
    const value = environment[name];
    if (name === MCP_SHADOW_DIAGNOSTICS_ENV) {
      if (value?.trim() === "1") selected[name] = "1";
      continue;
    }
    if (value !== undefined) selected[name] = value;
  }
  return Object.freeze(selected);
}

export interface ManagedStartupRootApplyRequest {
  readonly schemaVersion: typeof MANAGED_STARTUP_ROOT_APPLY_SCHEMA_VERSION;
  readonly agent: ManagedStartupAgent;
  readonly encodedProfile: string;
  readonly profileFingerprint: string;
  readonly corporateCaB64: string | null;
}

function fail(message: string): never {
  throw new Error(`Managed startup root application request is invalid: ${message}`);
}

export function isManagedStartupRootApplyAgent(value: unknown): value is ManagedStartupAgent {
  return typeof value === "string" && (MANAGED_STARTUP_AGENTS as readonly string[]).includes(value);
}

function exactAgent(value: unknown): ManagedStartupAgent {
  if (isManagedStartupRootApplyAgent(value)) return value;
  return fail("agent is unsupported");
}

export function createManagedStartupRootApplyRequest(input: {
  readonly agent: ManagedStartupAgent;
  readonly encodedProfile: string;
  readonly corporateCaB64?: string;
}): ManagedStartupRootApplyRequest {
  const agent = exactAgent(input.agent);
  if (
    input.encodedProfile.length === 0 ||
    input.encodedProfile.length > MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES
  ) {
    fail("encoded profile exceeds its bounded transport");
  }
  const profile = decodeManagedStartupProfile(input.encodedProfile);
  if (profile.agent !== agent) {
    fail(`profile targets ${profile.agent}, expected ${agent}`);
  }
  const corporateCaB64 = input.corporateCaB64 ?? null;
  if (
    corporateCaB64 !== null &&
    (corporateCaB64.length === 0 ||
      corporateCaB64.length > MAX_CORPORATE_CA_ENCODED_BYTES ||
      !STANDARD_BASE64_RE.test(corporateCaB64) ||
      Buffer.from(corporateCaB64, "base64").toString("base64") !== corporateCaB64)
  ) {
    fail("corporate CA is not canonical bounded base64");
  }
  if ((profile.corporateCa.bundleSha256 !== null) !== (corporateCaB64 !== null)) {
    fail("corporate CA transport does not match the profile");
  }
  if (
    corporateCaB64 !== null &&
    createHash("sha256").update(Buffer.from(corporateCaB64, "base64")).digest("hex") !==
      profile.corporateCa.bundleSha256
  ) {
    fail("corporate CA does not match the profile digest");
  }
  return Object.freeze({
    schemaVersion: MANAGED_STARTUP_ROOT_APPLY_SCHEMA_VERSION,
    agent,
    encodedProfile: input.encodedProfile,
    profileFingerprint: fingerprintManagedStartupProfile(profile),
    corporateCaB64,
  });
}

export function serializeManagedStartupRootApplyRequest(
  request: ManagedStartupRootApplyRequest,
): string {
  const normalized = createManagedStartupRootApplyRequest({
    agent: request.agent,
    encodedProfile: request.encodedProfile,
    ...(request.corporateCaB64 === null ? {} : { corporateCaB64: request.corporateCaB64 }),
  });
  if (
    request.schemaVersion !== MANAGED_STARTUP_ROOT_APPLY_SCHEMA_VERSION ||
    request.profileFingerprint !== normalized.profileFingerprint ||
    !SHA256_RE.test(request.profileFingerprint)
  ) {
    fail("schema version or profile fingerprint is invalid");
  }
  const serialized = `${JSON.stringify({
    agent: normalized.agent,
    corporateCaB64: normalized.corporateCaB64,
    encodedProfile: normalized.encodedProfile,
    profileFingerprint: normalized.profileFingerprint,
    schemaVersion: normalized.schemaVersion,
  })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES) {
    fail("serialized request exceeds its bounded transport");
  }
  return serialized;
}

export function parseManagedStartupRootApplyRequest(text: string): ManagedStartupRootApplyRequest {
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES) {
    fail("serialized request is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("serialized request is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("serialized request must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "agent",
    "corporateCaB64",
    "encodedProfile",
    "profileFingerprint",
    "schemaVersion",
  ];
  if (
    Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",") ||
    record.schemaVersion !== MANAGED_STARTUP_ROOT_APPLY_SCHEMA_VERSION ||
    typeof record.encodedProfile !== "string" ||
    typeof record.profileFingerprint !== "string" ||
    (record.corporateCaB64 !== null && typeof record.corporateCaB64 !== "string")
  ) {
    fail("serialized request has an invalid schema");
  }
  const request = createManagedStartupRootApplyRequest({
    agent: exactAgent(record.agent),
    encodedProfile: record.encodedProfile,
    ...(record.corporateCaB64 === null ? {} : { corporateCaB64: record.corporateCaB64 as string }),
  });
  if (
    record.profileFingerprint !== request.profileFingerprint ||
    !SHA256_RE.test(record.profileFingerprint)
  ) {
    fail("profile fingerprint does not match the encoded profile");
  }
  if (serializeManagedStartupRootApplyRequest(request) !== text) {
    fail("serialized request is not canonical");
  }
  return request;
}
