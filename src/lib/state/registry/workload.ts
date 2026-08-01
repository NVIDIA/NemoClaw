// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { MANAGED_IMAGE_REPOSITORIES } from "../../onboard/managed-image/contract";
import {
  decodeManagedStartupProfile,
  MANAGED_STARTUP_PROFILE_MAX_BYTES,
  MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES,
} from "../../onboard/managed-startup/profile";
import type { SandboxWorkloadReceipt } from "./types";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const COHORT_PATTERN = /^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;
const MANAGED_REFERENCE_PATTERN = new RegExp(
  `^(?:${Object.values(MANAGED_IMAGE_REPOSITORIES)
    .map((repository) => repository.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|")})@sha256:[0-9a-f]{64}$`,
  "u",
);
const MANAGED_PLATFORMS = new Set(["linux/amd64", "linux/arm64"]);
const RELEASE_PATTERN = /^v[0-9]+(?:[.][0-9]+){1,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const MAX_COHORT_BYTES = 128;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const STANDARD_BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_CORPORATE_CA_BYTES = 128 * 1024;
const MAX_CORPORATE_CA_ENCODED_BYTES = Math.ceil(MAX_CORPORATE_CA_BYTES / 3) * 4;

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function decodeCanonicalBase64Url(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MANAGED_STARTUP_PROFILE_MAX_ENCODED_BYTES ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64url");
  return decoded.length > 0 &&
    decoded.length <= MANAGED_STARTUP_PROFILE_MAX_BYTES &&
    decoded.toString("base64url") === value
    ? decoded
    : null;
}

function decodeCanonicalStandardBase64(value: unknown): Buffer | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_CORPORATE_CA_ENCODED_BYTES ||
    !STANDARD_BASE64_PATTERN.test(value)
  ) {
    return null;
  }
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 &&
    decoded.length <= MAX_CORPORATE_CA_BYTES &&
    decoded.toString("base64") === value
    ? decoded
    : null;
}

export function cloneSandboxWorkloadReceipt(
  value: SandboxWorkloadReceipt | undefined,
): SandboxWorkloadReceipt | undefined {
  if (!value || value.schemaVersion !== 1) return undefined;
  if (value.kind === "legacy-dockerfile") {
    if (value.shared !== false || (value.reference !== null && !nonEmptyString(value.reference))) {
      return undefined;
    }
    return {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: value.reference,
      shared: false,
    };
  }
  const encodedProfileBytes = decodeCanonicalBase64Url(value.encodedProfile);
  if (
    value.kind !== "managed-image" ||
    value.shared !== true ||
    !MANAGED_REFERENCE_PATTERN.test(value.reference) ||
    (value.platform !== undefined && !MANAGED_PLATFORMS.has(value.platform)) ||
    !RELEASE_PATTERN.test(value.release) ||
    !REVISION_PATTERN.test(value.sourceRevision) ||
    typeof value.sourceCohort !== "string" ||
    Buffer.byteLength(value.sourceCohort, "utf8") > MAX_COHORT_BYTES ||
    !COHORT_PATTERN.test(value.sourceCohort) ||
    value.capabilityContractVersion !== 1 ||
    value.startupProfileContractVersion !== 1 ||
    !SHA256_PATTERN.test(value.startupProfileSha256) ||
    typeof value.credentialProxyReplayRequired !== "boolean" ||
    encodedProfileBytes === null ||
    createHash("sha256").update(value.encodedProfile, "utf8").digest("hex") !==
      value.startupProfileSha256
  ) {
    return undefined;
  }
  let profile: ReturnType<typeof decodeManagedStartupProfile>;
  try {
    profile = decodeManagedStartupProfile(value.encodedProfile);
  } catch {
    return undefined;
  }
  if (!value.reference.startsWith(`${MANAGED_IMAGE_REPOSITORIES[profile.agent]}@sha256:`)) {
    return undefined;
  }
  const corporateCaBytes =
    value.corporateCaB64 === undefined ? null : decodeCanonicalStandardBase64(value.corporateCaB64);
  if (value.corporateCaB64 !== undefined && corporateCaBytes === null) {
    return undefined;
  }
  const expectedCorporateCaSha256 = profile.corporateCa.bundleSha256;
  if (
    (expectedCorporateCaSha256 === null) !== (corporateCaBytes === null) ||
    (corporateCaBytes !== null &&
      createHash("sha256").update(corporateCaBytes).digest("hex") !== expectedCorporateCaSha256)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: value.reference,
    ...(value.platform === undefined ? {} : { platform: value.platform }),
    release: value.release,
    sourceRevision: value.sourceRevision,
    sourceCohort: value.sourceCohort,
    capabilityContractVersion: value.capabilityContractVersion,
    startupProfileContractVersion: value.startupProfileContractVersion,
    encodedProfile: value.encodedProfile,
    startupProfileSha256: value.startupProfileSha256,
    credentialProxyReplayRequired: value.credentialProxyReplayRequired,
    ...(value.corporateCaB64 === undefined ? {} : { corporateCaB64: value.corporateCaB64 }),
    shared: true,
  };
}
