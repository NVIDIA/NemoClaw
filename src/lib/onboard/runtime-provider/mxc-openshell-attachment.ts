// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";

import { cloneAndDeepFreeze } from "../../core/immutable";

export const MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION = 3 as const;
export const MXC_OPENSHELL_DISTRIBUTION_AUTHORITY_CONTRACT_VERSION = 1 as const;

const PROVIDER_ID = "mxc";
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REVISION_PATTERN = /^[a-f0-9]{7,64}$/u;
const VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+(?:[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const LOCAL_DRIVE_PATH_PATTERN = /^[A-Za-z]:\\/u;
const MAX_TEXT_BYTES = 4096;

type ExactDistributionIdentity = {
  readonly version: string;
  readonly revision: string;
  readonly sha256: string;
};

type ExactComponentIdentity = {
  readonly cliSha256: string;
  readonly gatewaySha256: string;
  readonly wxcExecSha256: string;
};

type ExactGatewayIdentity = {
  readonly configSha256: string;
  readonly driver: "mxc";
  readonly backend: "process_container";
};

interface MxcOpenShellAttachmentExpectation {
  readonly distribution: ExactDistributionIdentity;
  readonly components: ExactComponentIdentity;
  readonly gateway: ExactGatewayIdentity;
}

export type MxcOpenShellDistributionAcceptance = "qualification" | "accepted";

export type MxcOpenShellDistributionProfileId = string;

export interface MxcOpenShellAttachmentObservation extends MxcOpenShellAttachmentExpectation {
  readonly distributionRoot: string;
  readonly mxcRoot: string;
  readonly cliPath: string;
  readonly gatewayPath: string;
  readonly wxcExecPath: string;
  readonly gatewayConfigPath: string;
}

export interface MxcOpenShellAttachmentAuthority {
  readonly contractVersion: typeof MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly mode: "attach-existing";
  readonly acceptance: MxcOpenShellDistributionAcceptance;
  readonly distributionProfileId: MxcOpenShellDistributionProfileId | "test-fixture";
  readonly acceptedIdentitySha256: string;
}

export interface MxcOpenShellDistributionAuthority {
  readonly contractVersion: typeof MXC_OPENSHELL_DISTRIBUTION_AUTHORITY_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly profileId: MxcOpenShellDistributionProfileId;
  readonly acceptance: MxcOpenShellDistributionAcceptance;
  readonly acceptedIdentitySha256: string;
}

export interface MxcOpenShellAttachmentReceipt {
  readonly contractVersion: typeof MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly mode: "attach-existing";
  readonly acceptance: MxcOpenShellDistributionAcceptance;
  readonly distributionProfileId: MxcOpenShellDistributionProfileId | "test-fixture";
  readonly authoritySha256: string;
  readonly distribution: ExactDistributionIdentity & { readonly root: string };
  readonly components: {
    readonly cli: { readonly path: string; readonly sha256: string };
    readonly gateway: { readonly path: string; readonly sha256: string };
    readonly wxcExec: { readonly root: string; readonly path: string; readonly sha256: string };
  };
  readonly gateway: ExactGatewayIdentity & { readonly configPath: string };
}

export class MxcOpenShellAttachmentError extends Error {
  constructor(message: string) {
    super(`Invalid OpenShell MXC attachment: ${message}`);
    this.name = "MxcOpenShellAttachmentError";
  }
}

const ACCEPTED_IDENTITIES = new WeakMap<
  MxcOpenShellAttachmentAuthority,
  Readonly<{
    acceptance: MxcOpenShellDistributionAcceptance;
    distributionProfileId: MxcOpenShellAttachmentAuthority["distributionProfileId"];
    expectation: MxcOpenShellAttachmentExpectation;
  }>
>();

const DISTRIBUTION_AUTHORITIES = new WeakMap<
  MxcOpenShellDistributionAuthority,
  MxcOpenShellAttachmentAuthority
>();

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new MxcOpenShellAttachmentError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new MxcOpenShellAttachmentError(`${label} has unknown or missing fields`);
  }
}

function exactText(value: unknown, label: string, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !pattern.test(value)
  ) {
    throw new MxcOpenShellAttachmentError(`${label} is invalid`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  return exactText(value, label, SHA256_PATTERN);
}

function canonicalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    !LOCAL_DRIVE_PATH_PATTERN.test(value) ||
    !path.win32.isAbsolute(value) ||
    path.win32.normalize(value) !== value
  ) {
    throw new MxcOpenShellAttachmentError(
      `${label} must be a canonical absolute local-drive Windows path`,
    );
  }
  return value;
}

function parseDistribution(value: unknown, label: string): ExactDistributionIdentity {
  const input = record(value, label);
  exactKeys(input, ["revision", "sha256", "version"], label);
  return {
    version: exactText(input.version, `${label} version`, VERSION_PATTERN),
    revision: exactText(input.revision, `${label} revision`, REVISION_PATTERN),
    sha256: sha256(input.sha256, `${label} digest`),
  };
}

function parseComponents(value: unknown, label: string): ExactComponentIdentity {
  const input = record(value, label);
  exactKeys(input, ["cliSha256", "gatewaySha256", "wxcExecSha256"], label);
  return {
    cliSha256: sha256(input.cliSha256, `${label} CLI digest`),
    gatewaySha256: sha256(input.gatewaySha256, `${label} gateway digest`),
    wxcExecSha256: sha256(input.wxcExecSha256, `${label} wxc-exec digest`),
  };
}

function parseGateway(value: unknown, label: string): ExactGatewayIdentity {
  const input = record(value, label);
  exactKeys(input, ["backend", "configSha256", "driver"], label);
  if (input.driver !== "mxc") {
    throw new MxcOpenShellAttachmentError(`${label} driver must be 'mxc'`);
  }
  if (input.backend !== "process_container") {
    throw new MxcOpenShellAttachmentError(`${label} backend must be 'process_container'`);
  }
  return {
    configSha256: sha256(input.configSha256, `${label} config digest`),
    driver: "mxc",
    backend: "process_container",
  };
}

function parseExpectation(value: unknown, label: string): MxcOpenShellAttachmentExpectation {
  const input = record(value, label);
  exactKeys(input, ["components", "distribution", "gateway"], label);
  return {
    distribution: parseDistribution(input.distribution, `${label} distribution`),
    components: parseComponents(input.components, `${label} components`),
    gateway: parseGateway(input.gateway, `${label} gateway`),
  };
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.win32.relative(root, candidate);
  return (
    relative.length > 0 &&
    !path.win32.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.win32.sep}`)
  );
}

function parseObservation(value: unknown): MxcOpenShellAttachmentObservation {
  const input = record(value, "observed attachment");
  exactKeys(
    input,
    [
      "cliPath",
      "components",
      "distribution",
      "distributionRoot",
      "gateway",
      "gatewayConfigPath",
      "gatewayPath",
      "mxcRoot",
      "wxcExecPath",
    ],
    "observed attachment",
  );
  const identity = {
    distribution: parseDistribution(input.distribution, "observed attachment distribution"),
    components: parseComponents(input.components, "observed attachment components"),
    gateway: parseGateway(input.gateway, "observed attachment gateway"),
  };
  const distributionRoot = canonicalWindowsPath(input.distributionRoot, "distribution root");
  const mxcRoot = canonicalWindowsPath(input.mxcRoot, "MXC root");
  const cliPath = canonicalWindowsPath(input.cliPath, "OpenShell CLI path");
  const gatewayPath = canonicalWindowsPath(input.gatewayPath, "OpenShell gateway path");
  const wxcExecPath = canonicalWindowsPath(input.wxcExecPath, "wxc-exec path");
  const gatewayConfigPath = canonicalWindowsPath(
    input.gatewayConfigPath,
    "OpenShell gateway config path",
  );
  for (const [label, candidate] of [
    ["OpenShell CLI", cliPath],
    ["OpenShell gateway", gatewayPath],
  ] as const) {
    if (!pathWithin(distributionRoot, candidate)) {
      throw new MxcOpenShellAttachmentError(
        `${label} path must remain inside the observed distribution root`,
      );
    }
  }
  if (!pathWithin(mxcRoot, wxcExecPath)) {
    throw new MxcOpenShellAttachmentError("wxc-exec path must remain inside the observed MXC root");
  }
  return {
    ...identity,
    distributionRoot,
    mxcRoot,
    cliPath,
    gatewayPath,
    wxcExecPath,
    gatewayConfigPath,
  };
}

function sameIdentity(
  expected: MxcOpenShellAttachmentExpectation,
  observed: MxcOpenShellAttachmentExpectation,
): boolean {
  return (
    JSON.stringify(expected.distribution) === JSON.stringify(observed.distribution) &&
    JSON.stringify(expected.components) === JSON.stringify(observed.components) &&
    JSON.stringify(expected.gateway) === JSON.stringify(observed.gateway)
  );
}

/**
 * Bind a provider-owned accepted identity to an opaque attachment authority.
 *
 * The caller must obtain the expectation from a trusted provider source, not
 * from the host observation that will be qualified against it.
 */
function createMxcOpenShellAttachmentAuthority(
  expectation: unknown,
  acceptance: MxcOpenShellDistributionAcceptance,
  distributionProfileId: MxcOpenShellAttachmentAuthority["distributionProfileId"],
): MxcOpenShellAttachmentAuthority {
  const accepted = cloneAndDeepFreeze(parseExpectation(expectation, "accepted attachment"));
  const acceptedIdentitySha256 = createHash("sha256")
    .update(
      JSON.stringify({
        contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
        providerId: PROVIDER_ID,
        mode: "attach-existing",
        acceptance,
        distributionProfileId,
        accepted,
      }),
      "utf8",
    )
    .digest("hex");
  const authority = Object.freeze({
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    mode: "attach-existing" as const,
    acceptance,
    distributionProfileId,
    acceptedIdentitySha256,
  });
  ACCEPTED_IDENTITIES.set(
    authority,
    cloneAndDeepFreeze({ acceptance, distributionProfileId, expectation: accepted }),
  );
  return authority;
}

function createDistributionAuthority(
  profileId: MxcOpenShellDistributionAuthority["profileId"],
  acceptance: MxcOpenShellDistributionAcceptance,
  expectation: unknown,
): MxcOpenShellDistributionAuthority {
  const attachmentAuthority = createMxcOpenShellAttachmentAuthority(
    expectation,
    acceptance,
    profileId,
  );
  const authority = Object.freeze({
    contractVersion: MXC_OPENSHELL_DISTRIBUTION_AUTHORITY_CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    profileId,
    acceptance,
    acceptedIdentitySha256: attachmentAuthority.acceptedIdentitySha256,
  });
  DISTRIBUTION_AUTHORITIES.set(authority, attachmentAuthority);
  return authority;
}

/**
 * Create authority only after OpenShell publishes an accepted immutable distribution record.
 *
 * No accepted Windows distribution is currently registered. Prototype measurements and host
 * observations therefore fail closed instead of becoming provider authority.
 */
export function createMxcOpenShellDistributionAuthority(): MxcOpenShellDistributionAuthority {
  throw new MxcOpenShellAttachmentError("accepted distribution authority is unavailable");
}

/** Resolve the opaque attachment capability carried by a provider-owned distribution authority. */
export function resolveMxcOpenShellDistributionAuthority(
  authority: MxcOpenShellDistributionAuthority,
): MxcOpenShellAttachmentAuthority {
  if (typeof authority !== "object" || authority === null) {
    throw new MxcOpenShellAttachmentError("distribution authority is not provider-owned");
  }
  const attachmentAuthority = DISTRIBUTION_AUTHORITIES.get(authority);
  if (!attachmentAuthority) {
    throw new MxcOpenShellAttachmentError("distribution authority is not provider-owned");
  }
  return attachmentAuthority;
}

/**
 * Create the fixed, non-production authority used by attachment contract tests.
 *
 * The caller may vary only the SemVer value under test. Component identities stay fixed so this
 * helper cannot turn caller-observed digests into accepted provider authority.
 */
export function createMxcOpenShellAttachmentTestAuthority(
  version: string,
): MxcOpenShellAttachmentAuthority {
  return createMxcOpenShellAttachmentAuthority(
    testExpectation(version),
    "qualification",
    "test-fixture",
  );
}

/** Create a fixed synthetic distribution authority for deterministic tests only. */
export function createMxcOpenShellDistributionTestAuthority(
  version: string,
): MxcOpenShellDistributionAuthority {
  return createDistributionAuthority("test-fixture", "qualification", testExpectation(version));
}

function testExpectation(version: string): MxcOpenShellAttachmentExpectation {
  return {
    distribution: {
      version,
      revision: "a".repeat(40),
      sha256: "1".repeat(64),
    },
    components: {
      cliSha256: "2".repeat(64),
      gatewaySha256: "3".repeat(64),
      wxcExecSha256: "4".repeat(64),
    },
    gateway: {
      configSha256: "5".repeat(64),
      driver: "mxc",
      backend: "process_container",
    },
  };
}

function acceptedIdentity(authority: unknown): Readonly<{
  acceptance: MxcOpenShellDistributionAcceptance;
  distributionProfileId: MxcOpenShellAttachmentAuthority["distributionProfileId"];
  expectation: MxcOpenShellAttachmentExpectation;
}> {
  if (typeof authority !== "object" || authority === null) {
    throw new MxcOpenShellAttachmentError("accepted identity authority is not provider-owned");
  }
  const accepted = ACCEPTED_IDENTITIES.get(authority as MxcOpenShellAttachmentAuthority);
  if (!accepted) {
    throw new MxcOpenShellAttachmentError("accepted identity authority is not provider-owned");
  }
  return accepted;
}

/**
 * Bind a provider-owned accepted OpenShell identity to one observed Windows installation.
 *
 * The trusted host adapter must collect the observation without executing the
 * untrusted agent artifact. This function does not install, start, or replace a
 * gateway and does not authorize MXC activation.
 */
export function qualifyMxcOpenShellAttachment(
  authority: MxcOpenShellAttachmentAuthority,
  observation: unknown,
): MxcOpenShellAttachmentReceipt {
  const accepted = acceptedIdentity(authority);
  const observed = parseObservation(observation);
  if (!sameIdentity(accepted.expectation, observed)) {
    throw new MxcOpenShellAttachmentError(
      "observed distribution identity does not match the accepted identity",
    );
  }
  const receiptIdentity = {
    contractVersion: MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
    providerId: PROVIDER_ID,
    mode: "attach-existing" as const,
    acceptance: accepted.acceptance,
    distributionProfileId: accepted.distributionProfileId,
    distribution: { ...observed.distribution, root: observed.distributionRoot },
    components: {
      cli: { path: observed.cliPath, sha256: observed.components.cliSha256 },
      gateway: { path: observed.gatewayPath, sha256: observed.components.gatewaySha256 },
      wxcExec: {
        root: observed.mxcRoot,
        path: observed.wxcExecPath,
        sha256: observed.components.wxcExecSha256,
      },
    },
    gateway: {
      ...observed.gateway,
      configPath: observed.gatewayConfigPath,
    },
  } as const;
  const authoritySha256 = createHash("sha256")
    .update(JSON.stringify(receiptIdentity), "utf8")
    .digest("hex");
  return cloneAndDeepFreeze({ ...receiptIdentity, authoritySha256 });
}
