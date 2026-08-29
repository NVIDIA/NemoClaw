// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  decodeManagedStartupProfile,
  MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
} from "../managed-startup/profile";

export { MANAGED_STARTUP_PROFILE_SCHEMA_VERSION };

export const NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION = 1 as const;
export const NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION = 1 as const;
export const NATIVE_ARTIFACT_WORKLOAD_PLATFORM = "windows/x64" as const;
export const NATIVE_ARTIFACT_WORKLOAD_AGENT = "openclaw" as const;
export const NATIVE_ARTIFACT_SOURCE_REPOSITORY = "NVIDIA/NemoClaw" as const;

export type NativeArtifactDigest = `sha256:${string}`;

/**
 * Inactive OpenClaw-on-Windows workload receipt.
 *
 * This schema records immutable identity and launch intent. The bootstrap provider
 * must verify each digest and create without releasing stable artifact authority.
 */
export interface NativeArtifactWorkloadReceiptV1 {
  readonly schemaVersion: typeof NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION;
  readonly kind: "native-artifact";
  readonly contractVersion: typeof NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION;
  readonly agent: typeof NATIVE_ARTIFACT_WORKLOAD_AGENT;
  readonly platform: typeof NATIVE_ARTIFACT_WORKLOAD_PLATFORM;
  readonly artifact: {
    readonly digest: NativeArtifactDigest;
    readonly version: string;
    readonly source: {
      readonly repository: typeof NATIVE_ARTIFACT_SOURCE_REPOSITORY;
      readonly revision: string;
    };
  };
  readonly launch: {
    readonly executable: {
      /** Canonical path beneath the verified artifact root. */
      readonly relativePath: string;
      readonly digest: NativeArtifactDigest;
    };
    readonly arguments: readonly string[];
    readonly workingDirectory: string;
    /** Environment-variable names only; literal assignments are not accepted. */
    readonly environmentNames: readonly string[];
  };
  readonly startupProfileContractVersion: typeof MANAGED_STARTUP_PROFILE_SCHEMA_VERSION;
  readonly encodedProfile: string;
  readonly startupProfileSha256: string;
  readonly credentialProxyReplayRequired: true;
  readonly shared: true;
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){2,3}(?:[-.][0-9A-Za-z][0-9A-Za-z.-]*)?$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
const WINDOWS_RESERVED_PATH_SEGMENT_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_PATH_BYTES = 4096;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_PATTERN_BYTES = 256;
const MAX_ARGUMENTS = 128;
const MAX_ENVIRONMENT_NAMES = 128;

export class NativeArtifactWorkloadContractError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Invalid native artifact workload contract: ${message}`, options);
    this.name = "NativeArtifactWorkloadContractError";
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NativeArtifactWorkloadContractError(`${field} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new NativeArtifactWorkloadContractError(`${field} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  field: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new NativeArtifactWorkloadContractError(
      `${field} must contain exactly: ${expected.join(", ")}`,
    );
  }
}

function requireLiteral<T extends string | number | boolean>(
  value: unknown,
  expected: T,
  field: string,
): T {
  if (value !== expected) {
    throw new NativeArtifactWorkloadContractError(`${field} must be ${JSON.stringify(expected)}`);
  }
  return expected;
}

function requirePattern(value: unknown, pattern: RegExp, field: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATTERN_BYTES ||
    !pattern.test(value)
  ) {
    throw new NativeArtifactWorkloadContractError(`${field} has an unsupported format`);
  }
  return value;
}

function requireRelativePath(value: unknown, field: string, allowDot = false): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    value.includes("\\") ||
    value.includes(":") ||
    value.startsWith("/")
  ) {
    throw new NativeArtifactWorkloadContractError(`${field} must be a canonical relative path`);
  }
  if (allowDot && value === ".") return value;
  const segments = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        WINDOWS_RESERVED_PATH_SEGMENT_PATTERN.test(segment),
    )
  ) {
    throw new NativeArtifactWorkloadContractError(`${field} must be a canonical relative path`);
  }
  return value;
}

function requireArguments(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ARGUMENTS) {
    throw new NativeArtifactWorkloadContractError(
      `contract.launch.arguments must contain at most ${MAX_ARGUMENTS} strings`,
    );
  }
  return value.map((argument, index) => {
    if (
      typeof argument !== "string" ||
      Buffer.byteLength(argument, "utf8") > MAX_ARGUMENT_BYTES ||
      CONTROL_CHARACTER_PATTERN.test(argument)
    ) {
      throw new NativeArtifactWorkloadContractError(
        `contract.launch.arguments[${index}] has an unsupported format`,
      );
    }
    return argument;
  });
}

function requireEnvironmentNames(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_ENVIRONMENT_NAMES) {
    throw new NativeArtifactWorkloadContractError(
      `contract.launch.environmentNames must contain at most ${MAX_ENVIRONMENT_NAMES} names`,
    );
  }
  const names = value.map((name, index) =>
    requirePattern(name, ENVIRONMENT_NAME_PATTERN, `contract.launch.environmentNames[${index}]`),
  );
  if (new Set(names).size !== names.length) {
    throw new NativeArtifactWorkloadContractError(
      "contract.launch.environmentNames must not contain duplicates",
    );
  }
  return names;
}

export function parseNativeArtifactWorkloadReceiptV1(
  value: unknown,
): NativeArtifactWorkloadReceiptV1 {
  const contract = requireRecord(value, "contract");
  requireExactKeys(
    contract,
    [
      "agent",
      "artifact",
      "contractVersion",
      "credentialProxyReplayRequired",
      "encodedProfile",
      "kind",
      "launch",
      "platform",
      "schemaVersion",
      "shared",
      "startupProfileContractVersion",
      "startupProfileSha256",
    ],
    "contract",
  );
  requireLiteral(
    contract.schemaVersion,
    NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION,
    "contract.schemaVersion",
  );
  requireLiteral(contract.kind, "native-artifact", "contract.kind");
  requireLiteral(
    contract.contractVersion,
    NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
    "contract.contractVersion",
  );
  const agent = requireLiteral(contract.agent, NATIVE_ARTIFACT_WORKLOAD_AGENT, "contract.agent");
  const platform = requireLiteral(
    contract.platform,
    NATIVE_ARTIFACT_WORKLOAD_PLATFORM,
    "contract.platform",
  );

  const artifact = requireRecord(contract.artifact, "contract.artifact");
  requireExactKeys(artifact, ["digest", "source", "version"], "contract.artifact");
  const artifactDigest = requirePattern(
    artifact.digest,
    DIGEST_PATTERN,
    "contract.artifact.digest",
  );
  const artifactVersion = requirePattern(
    artifact.version,
    VERSION_PATTERN,
    "contract.artifact.version",
  );
  const source = requireRecord(artifact.source, "contract.artifact.source");
  requireExactKeys(source, ["repository", "revision"], "contract.artifact.source");
  const sourceRepository = requireLiteral(
    source.repository,
    NATIVE_ARTIFACT_SOURCE_REPOSITORY,
    "contract.artifact.source.repository",
  );
  const sourceRevision = requirePattern(
    source.revision,
    REVISION_PATTERN,
    "contract.artifact.source.revision",
  );

  const launch = requireRecord(contract.launch, "contract.launch");
  requireExactKeys(
    launch,
    ["arguments", "environmentNames", "executable", "workingDirectory"],
    "contract.launch",
  );
  const executable = requireRecord(launch.executable, "contract.launch.executable");
  requireExactKeys(executable, ["digest", "relativePath"], "contract.launch.executable");
  const executablePath = requireRelativePath(
    executable.relativePath,
    "contract.launch.executable.relativePath",
  );
  const executableDigest = requirePattern(
    executable.digest,
    DIGEST_PATTERN,
    "contract.launch.executable.digest",
  );
  const argumentsList = requireArguments(launch.arguments);
  const workingDirectory = requireRelativePath(
    launch.workingDirectory,
    "contract.launch.workingDirectory",
    true,
  );
  const environmentNames = requireEnvironmentNames(launch.environmentNames);

  const startupProfileContractVersion = requireLiteral(
    contract.startupProfileContractVersion,
    MANAGED_STARTUP_PROFILE_SCHEMA_VERSION,
    "contract.startupProfileContractVersion",
  );
  const startupProfileSha256 = requirePattern(
    contract.startupProfileSha256,
    SHA256_PATTERN,
    "contract.startupProfileSha256",
  );
  if (typeof contract.encodedProfile !== "string") {
    throw new NativeArtifactWorkloadContractError("contract.encodedProfile must be a string");
  }
  let profile: ReturnType<typeof decodeManagedStartupProfile>;
  try {
    profile = decodeManagedStartupProfile(contract.encodedProfile);
  } catch (error) {
    throw new NativeArtifactWorkloadContractError("contract.encodedProfile failed validation", {
      cause: error,
    });
  }
  if (
    createHash("sha256").update(contract.encodedProfile, "utf8").digest("hex") !==
    startupProfileSha256
  ) {
    throw new NativeArtifactWorkloadContractError(
      "contract.startupProfileSha256 does not match contract.encodedProfile",
    );
  }
  if (profile.agent !== agent) {
    throw new NativeArtifactWorkloadContractError(
      `contract.encodedProfile belongs to '${profile.agent}', not '${agent}'`,
    );
  }

  const credentialProxyReplayRequired = requireLiteral(
    contract.credentialProxyReplayRequired,
    true,
    "contract.credentialProxyReplayRequired",
  );
  const shared = requireLiteral(contract.shared, true, "contract.shared");

  return {
    schemaVersion: NATIVE_ARTIFACT_WORKLOAD_RECEIPT_SCHEMA_VERSION,
    kind: "native-artifact",
    contractVersion: NATIVE_ARTIFACT_WORKLOAD_CONTRACT_VERSION,
    agent,
    platform,
    artifact: {
      digest: artifactDigest as NativeArtifactDigest,
      version: artifactVersion,
      source: { repository: sourceRepository, revision: sourceRevision },
    },
    launch: {
      executable: {
        relativePath: executablePath,
        digest: executableDigest as NativeArtifactDigest,
      },
      arguments: argumentsList,
      workingDirectory,
      environmentNames,
    },
    startupProfileContractVersion,
    encodedProfile: contract.encodedProfile,
    startupProfileSha256,
    credentialProxyReplayRequired,
    shared,
  };
}
