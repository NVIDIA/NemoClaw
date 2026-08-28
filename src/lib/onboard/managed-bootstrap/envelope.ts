// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES,
  type ManagedStartupRootApplyRequest,
  isManagedStartupRootApplyAgent,
  parseManagedStartupRootApplyRequest,
  serializeManagedStartupRootApplyRequest,
} from "../managed-startup/root-apply";

export const MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const MANAGED_BOOTSTRAP_REQUEST_FILE = "/var/lib/nemoclaw-managed-bootstrap-request.json";
export const MANAGED_BOOTSTRAP_REQUEST_TAR_PATH = MANAGED_BOOTSTRAP_REQUEST_FILE.replace(
  /^\/+/,
  "",
);
export const MANAGED_BOOTSTRAP_COMPLETION_FILE = "/run/nemoclaw/managed-bootstrap-completion.json";
export const MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES =
  Math.ceil(MANAGED_STARTUP_ROOT_APPLY_MAX_BYTES / 3) * 4 + 1024;
export const MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES = 1024;

const BOOTSTRAP_IDENTITY_RE = /^[a-f0-9]{64}$/u;
const STANDARD_BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

export interface ManagedBootstrapEnvelope {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION;
  readonly bootstrapIdentity: string;
  readonly rootApplyRequest: ManagedStartupRootApplyRequest;
}

export interface ManagedBootstrapImageCompletion {
  readonly schemaVersion: typeof MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION;
  readonly bootstrapIdentity: string;
  readonly agent: ManagedStartupRootApplyRequest["agent"];
  readonly profileFingerprint: string;
  readonly transactionPending: boolean;
}

function writeTarText(header: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) fail("protected request tar field exceeds its bound");
  bytes.copy(header, offset);
}

function writeTarOctal(header: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) fail("protected request tar integer exceeds its bound");
  writeTarText(header, offset, length, `${encoded}\0`);
}

function fail(message: string): never {
  throw new Error(`Managed bootstrap envelope is invalid: ${message}`);
}

export function serializeManagedBootstrapEnvelope(input: {
  readonly bootstrapIdentity: string;
  readonly rootApplyRequest: ManagedStartupRootApplyRequest;
}): string {
  if (!BOOTSTRAP_IDENTITY_RE.test(input.bootstrapIdentity)) {
    fail("bootstrap identity must be 32 random bytes encoded as lowercase hex");
  }
  const request = Buffer.from(
    serializeManagedStartupRootApplyRequest(input.rootApplyRequest),
    "utf8",
  ).toString("base64");
  const serialized = `${JSON.stringify({
    bootstrapIdentity: input.bootstrapIdentity,
    rootApplyRequestB64: request,
    schemaVersion: MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION,
  })}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES) {
    fail("serialized envelope exceeds its bounded transport");
  }
  return serialized;
}

/**
 * Serialize one root-owned request as a minimal POSIX ustar stream for a
 * provider's archive-copy operation. Path-based container copies can preserve
 * the host caller's numeric ownership; the tar header makes the in-container
 * root:root 0400 boundary explicit without starting the stopped replacement
 * before its authenticated bootstrap entrypoint.
 */
export function serializeManagedBootstrapEnvelopeTar(input: {
  readonly bootstrapIdentity: string;
  readonly rootApplyRequest: ManagedStartupRootApplyRequest;
}): Buffer {
  const payload = Buffer.from(serializeManagedBootstrapEnvelope(input), "utf8");
  const header = Buffer.alloc(512);
  writeTarText(header, 0, 100, MANAGED_BOOTSTRAP_REQUEST_TAR_PATH);
  writeTarOctal(header, 100, 8, 0o400);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, payload.length);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeTarText(header, 257, 6, "ustar\0");
  writeTarText(header, 263, 2, "00");
  writeTarText(header, 265, 32, "root");
  writeTarText(header, 297, 32, "root");
  writeTarOctal(header, 329, 8, 0);
  writeTarOctal(header, 337, 8, 0);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0");
  if (checksumText.length !== 6) fail("protected request tar checksum exceeds its bound");
  writeTarText(header, 148, 8, `${checksumText}\0 `);

  const paddedPayloadBytes = Math.ceil(payload.length / 512) * 512;
  const archive = Buffer.alloc(512 + paddedPayloadBytes + 1024);
  header.copy(archive, 0);
  payload.copy(archive, 512);
  return archive;
}

export function parseManagedBootstrapEnvelope(text: string): ManagedBootstrapEnvelope {
  if (text.includes("\0")) fail("serialized envelope contains NUL");
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > MANAGED_BOOTSTRAP_ENVELOPE_MAX_BYTES) {
    fail("serialized envelope is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("serialized envelope is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("serialized envelope must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      ["bootstrapIdentity", "rootApplyRequestB64", "schemaVersion"].sort().join(",") ||
    record.schemaVersion !== MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION ||
    typeof record.bootstrapIdentity !== "string" ||
    !BOOTSTRAP_IDENTITY_RE.test(record.bootstrapIdentity) ||
    typeof record.rootApplyRequestB64 !== "string" ||
    !STANDARD_BASE64_RE.test(record.rootApplyRequestB64)
  ) {
    fail("serialized envelope has an invalid schema");
  }
  const requestBytes = Buffer.from(record.rootApplyRequestB64, "base64");
  if (requestBytes.toString("base64") !== record.rootApplyRequestB64) {
    fail("root application request transport is non-canonical");
  }
  const rootApplyRequest = parseManagedStartupRootApplyRequest(requestBytes.toString("utf8"));
  const envelope = Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION,
    bootstrapIdentity: record.bootstrapIdentity,
    rootApplyRequest,
  });
  if (serializeManagedBootstrapEnvelope(envelope) !== text) {
    fail("serialized envelope is not canonical");
  }
  return envelope;
}

export function serializeManagedBootstrapImageCompletion(
  completion: Omit<ManagedBootstrapImageCompletion, "schemaVersion">,
): string {
  if (
    !BOOTSTRAP_IDENTITY_RE.test(completion.bootstrapIdentity) ||
    !BOOTSTRAP_IDENTITY_RE.test(completion.profileFingerprint)
  ) {
    fail("image completion identity is invalid");
  }
  if (!isManagedStartupRootApplyAgent(completion.agent)) {
    fail("image completion agent is invalid");
  }
  if (typeof completion.transactionPending !== "boolean") {
    fail("image completion transaction state is invalid");
  }
  return `${JSON.stringify({
    agent: completion.agent,
    bootstrapIdentity: completion.bootstrapIdentity,
    profileFingerprint: completion.profileFingerprint,
    schemaVersion: MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION,
    transactionPending: completion.transactionPending,
  })}\n`;
}

export function parseManagedBootstrapImageCompletion(
  text: string,
): ManagedBootstrapImageCompletion {
  if (text.includes("\0")) fail("image completion contains NUL");
  if (
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > MANAGED_BOOTSTRAP_COMPLETION_MAX_BYTES
  ) {
    fail("image completion is empty or too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("image completion is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail("image completion must be an object");
  }
  const completion = parsed as Record<string, unknown>;
  if (
    Object.keys(completion).sort().join(",") !==
      ["agent", "bootstrapIdentity", "profileFingerprint", "schemaVersion", "transactionPending"]
        .sort()
        .join(",") ||
    completion.schemaVersion !== MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION ||
    !isManagedStartupRootApplyAgent(completion.agent) ||
    typeof completion.bootstrapIdentity !== "string" ||
    !BOOTSTRAP_IDENTITY_RE.test(completion.bootstrapIdentity) ||
    typeof completion.profileFingerprint !== "string" ||
    !BOOTSTRAP_IDENTITY_RE.test(completion.profileFingerprint) ||
    typeof completion.transactionPending !== "boolean"
  ) {
    fail("image completion schema is invalid");
  }
  const normalized = Object.freeze({
    schemaVersion: MANAGED_BOOTSTRAP_ENVELOPE_SCHEMA_VERSION,
    bootstrapIdentity: completion.bootstrapIdentity,
    agent: completion.agent as ManagedStartupRootApplyRequest["agent"],
    profileFingerprint: completion.profileFingerprint,
    transactionPending: completion.transactionPending,
  });
  if (serializeManagedBootstrapImageCompletion(normalized) !== text) {
    fail("image completion is not canonical");
  }
  return normalized;
}
