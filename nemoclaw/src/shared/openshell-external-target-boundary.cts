// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";

import * as importedSandboxName from "./sandbox-name.cjs";

const sourceOrGeneratedSandboxName = importedSandboxName as typeof importedSandboxName & {
  default?: typeof importedSandboxName;
};
const { isValidName } = sourceOrGeneratedSandboxName.default ?? sourceOrGeneratedSandboxName;

export type ExternalOpenShellAuthentication =
  | {
      kind: "mtls";
      client_certificate_file: string;
      client_key_file: string;
    }
  | {
      kind: "oidc";
      token_file: string;
    };

export interface ExternalOpenShellTarget {
  endpoint: string;
  workspace: string;
  expected_release: string;
  lifecycle: "external";
  trust: {
    ca_file: string;
  };
  authentication: ExternalOpenShellAuthentication;
}

export interface OpenShellCompatibilityRange {
  minVersion: string;
  maxVersion: string;
}

export interface SanitizedExternalOpenShellTargetPlan {
  endpoint: string;
  workspace: string;
  expected_release: string;
  lifecycle: "external";
  authentication_kind: ExternalOpenShellAuthentication["kind"];
  ca_fingerprint: string;
}

export interface ExternalOpenShellTargetPlanDependencies {
  readFile?: (filePath: string, maxBytes: number) => string | Buffer | Uint8Array;
}

type UnknownRecord = Record<string, unknown>;

const TARGET_KEYS = new Set([
  "endpoint",
  "workspace",
  "expected_release",
  "lifecycle",
  "trust",
  "authentication",
]);
const TRUST_KEYS = new Set(["ca_file"]);
const MTLS_KEYS = new Set(["kind", "client_certificate_file", "client_key_file"]);
const OIDC_KEYS = new Set(["kind", "token_file"]);
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;
const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu;
const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const MAX_AUTHENTICATION_FILE_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`external OpenShell target ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredAbsolutePath(value: unknown, field: string): string {
  const filePath = requiredString(value, field);
  if (!isAbsolute(filePath)) {
    throw new Error(`external OpenShell target ${field} must be an absolute file path`);
  }
  return filePath;
}

function parseEndpoint(value: unknown): string {
  const raw = requiredString(value, "endpoint");
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("external OpenShell target endpoint must be a valid HTTPS origin");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error(
      "external OpenShell target endpoint must be a bare HTTPS origin without credentials, path, query, or fragment",
    );
  }
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(hostname);
  const mappedIpv4FirstByte = mappedIpv4 ? Number.parseInt(mappedIpv4[1], 16) >> 8 : undefined;
  if (
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname === "::1" ||
    hostname === "::" ||
    hostname === "0.0.0.0" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname) ||
    mappedIpv4FirstByte === 127 ||
    (mappedIpv4 !== null && mappedIpv4[1] === "0" && mappedIpv4[2] === "0")
  ) {
    throw new Error(
      "external OpenShell target endpoint must not use the same-host loopback gateway contract",
    );
  }
  return endpoint.origin;
}

function parseAuthentication(value: unknown): ExternalOpenShellAuthentication {
  if (!isRecord(value)) {
    throw new Error("external OpenShell target authentication must be a mapping");
  }
  if (value.kind === "mtls") {
    if (!hasOnlyKeys(value, MTLS_KEYS)) {
      throw new Error("external OpenShell target mTLS authentication contains unsupported fields");
    }
    return {
      kind: "mtls",
      client_certificate_file: requiredAbsolutePath(
        value.client_certificate_file,
        "authentication.client_certificate_file",
      ),
      client_key_file: requiredAbsolutePath(
        value.client_key_file,
        "authentication.client_key_file",
      ),
    };
  }
  if (value.kind === "oidc") {
    if (!hasOnlyKeys(value, OIDC_KEYS)) {
      throw new Error("external OpenShell target OIDC authentication contains unsupported fields");
    }
    return {
      kind: "oidc",
      token_file: requiredAbsolutePath(value.token_file, "authentication.token_file"),
    };
  }
  throw new Error("external OpenShell target authentication kind must be mtls or oidc");
}

function parseTarget(value: unknown): ExternalOpenShellTarget {
  if (!isRecord(value)) {
    throw new Error("external OpenShell target must be a mapping");
  }
  if ("local" in value) {
    throw new Error(
      "external OpenShell target must not combine external and local lifecycle configuration",
    );
  }
  if (!hasOnlyKeys(value, TARGET_KEYS)) {
    throw new Error("external OpenShell target contains unsupported fields");
  }
  if (value.lifecycle !== "external") {
    throw new Error("external OpenShell target lifecycle must be external");
  }
  const workspace = requiredString(value.workspace, "workspace");
  if (!isValidName(workspace)) {
    throw new Error("external OpenShell target workspace is not a valid OpenShell workspace name");
  }
  const expectedRelease = requiredString(value.expected_release, "expected_release");
  if (!SEMVER_PATTERN.test(expectedRelease)) {
    throw new Error("external OpenShell target expected_release must be an exact semantic version");
  }
  if (!isRecord(value.trust) || !hasOnlyKeys(value.trust, TRUST_KEYS)) {
    throw new Error("external OpenShell target trust must contain only ca_file");
  }
  return {
    endpoint: parseEndpoint(value.endpoint),
    workspace,
    expected_release: expectedRelease,
    lifecycle: "external",
    trust: {
      ca_file: requiredAbsolutePath(value.trust.ca_file, "trust.ca_file"),
    },
    authentication: parseAuthentication(value.authentication),
  };
}

function semverParts(version: string): readonly [number, number, number] {
  if (!SEMVER_PATTERN.test(version)) {
    throw new Error("OpenShell compatibility range must use exact semantic versions");
  }
  const [major, minor, patch] = version.split(".").map((part) => Number(part));
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    throw new Error("OpenShell compatibility range must use safe exact semantic versions");
  }
  return [major, minor, patch];
}

function compareSemver(left: string, right: string): number {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function assertCompatibleRelease(
  expectedRelease: string,
  compatibility: OpenShellCompatibilityRange,
): void {
  if (compareSemver(compatibility.minVersion, compatibility.maxVersion) > 0) {
    throw new Error("OpenShell compatibility range minimum must not exceed its maximum");
  }
  if (
    compareSemver(expectedRelease, compatibility.minVersion) < 0 ||
    compareSemver(expectedRelease, compatibility.maxVersion) > 0
  ) {
    throw new Error("external OpenShell target expected_release is outside the compatible range");
  }
}

function readBoundedFile(
  filePath: string,
  label: string,
  maxBytes: number,
  readFile: NonNullable<ExternalOpenShellTargetPlanDependencies["readFile"]>,
): Buffer {
  let contents: Buffer;
  try {
    contents = Buffer.from(readFile(filePath, maxBytes));
  } catch {
    throw new Error(`external OpenShell target ${label} could not be read`);
  }
  if (contents.length === 0 || contents.length > maxBytes) {
    throw new Error(`external OpenShell target ${label} is empty or exceeds its size limit`);
  }
  return contents;
}

function readFileAtMost(filePath: string, maxBytes: number): Buffer {
  const descriptor = openSync(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const file = fstatSync(descriptor);
    const pathMetadata = lstatSync(filePath);
    if (
      !file.isFile() ||
      !pathMetadata.isFile() ||
      pathMetadata.isSymbolicLink() ||
      file.dev !== pathMetadata.dev ||
      file.ino !== pathMetadata.ino
    ) {
      throw new Error("not a regular file");
    }
    if (file.size > maxBytes) {
      return Buffer.alloc(maxBytes + 1);
    }

    const contents = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < contents.length) {
      const bytesRead = readSync(descriptor, contents, offset, contents.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return contents.subarray(0, offset);
  } finally {
    closeSync(descriptor);
  }
}

function validateCaBundle(contents: Buffer): readonly Buffer[] {
  const text = contents.toString("utf8");
  const blocks = text.match(PEM_CERTIFICATE_PATTERN) ?? [];
  const remainder = text.replace(PEM_CERTIFICATE_PATTERN, "").trim();
  if (blocks.length === 0 || remainder !== "") {
    throw new Error("external OpenShell target CA file is not a valid PEM CA bundle");
  }
  try {
    return blocks.map((block) => {
      const certificate = new X509Certificate(block);
      if (!certificate.ca) {
        throw new Error("not a CA certificate");
      }
      return certificate.raw;
    });
  } catch {
    throw new Error("external OpenShell target CA file is not a valid PEM CA bundle");
  }
}

function validateOidcToken(contents: Buffer): void {
  const token = contents.toString("utf8").trim();
  if (token === "" || /\s/u.test(token)) {
    throw new Error("external OpenShell target OIDC token file is invalid");
  }
}

function validateMtlsAuthentication(certificateContents: Buffer, keyContents: Buffer): void {
  try {
    const certificate = new X509Certificate(certificateContents);
    const privateKey = createPrivateKey(keyContents);
    const certificatePublicKey = certificate.publicKey.export({ format: "der", type: "spki" });
    const privateKeyPublicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
    if (!Buffer.from(certificatePublicKey).equals(Buffer.from(privateKeyPublicKey))) {
      throw new Error("certificate and key do not match");
    }
  } catch {
    throw new Error("external OpenShell target mTLS authentication files are invalid");
  }
}

export function isExternalOpenShellTarget(value: unknown): value is ExternalOpenShellTarget {
  try {
    parseTarget(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate one explicit external target and return only its non-secret identity.
 * File paths and authentication contents remain inside this boundary.
 */
export function buildSanitizedExternalOpenShellTargetPlan(
  value: unknown,
  compatibility: OpenShellCompatibilityRange,
  dependencies: ExternalOpenShellTargetPlanDependencies = {},
): SanitizedExternalOpenShellTargetPlan {
  const target = parseTarget(value);
  assertCompatibleRelease(target.expected_release, compatibility);

  const readFile = dependencies.readFile ?? readFileAtMost;
  const caContents = readBoundedFile(
    target.trust.ca_file,
    "CA file",
    MAX_TRUST_FILE_BYTES,
    readFile,
  );
  const caCertificates = validateCaBundle(caContents);

  if (target.authentication.kind === "oidc") {
    validateOidcToken(
      readBoundedFile(
        target.authentication.token_file,
        "OIDC token file",
        MAX_AUTHENTICATION_FILE_BYTES,
        readFile,
      ),
    );
  } else {
    const certificateContents = readBoundedFile(
      target.authentication.client_certificate_file,
      "mTLS client certificate file",
      MAX_AUTHENTICATION_FILE_BYTES,
      readFile,
    );
    const keyContents = readBoundedFile(
      target.authentication.client_key_file,
      "mTLS client key file",
      MAX_AUTHENTICATION_FILE_BYTES,
      readFile,
    );
    validateMtlsAuthentication(certificateContents, keyContents);
  }

  const caFingerprint = createHash("sha256");
  for (const certificate of caCertificates) {
    caFingerprint.update(certificate);
  }
  return {
    endpoint: target.endpoint,
    workspace: target.workspace,
    expected_release: target.expected_release,
    lifecycle: "external",
    authentication_kind: target.authentication.kind,
    ca_fingerprint: `sha256:${caFingerprint.digest("hex")}`,
  };
}
