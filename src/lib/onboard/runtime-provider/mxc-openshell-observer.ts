// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { cloneAndDeepFreeze } from "../../core/immutable";
import {
  MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION,
  MxcOpenShellAttachmentError,
  type MxcOpenShellAttachmentObservation,
} from "./mxc-openshell-attachment";

const MAX_PATH_BYTES = 4096;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LOCAL_DRIVE_PATH_PATTERN = /^[A-Za-z]:\\/u;

interface StableFileStat {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

interface StableFileHandle {
  stat(): Promise<StableFileStat>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  close(): Promise<void>;
}

export interface MxcOpenShellStableFileOperations {
  lstat(filePath: string): Promise<StableFileStat>;
  open(filePath: string): Promise<StableFileHandle>;
}

export interface MxcOpenShellInstallationLayout {
  readonly distributionArtifactPath: string;
  readonly distributionRoot: string;
  readonly mxcRoot: string;
  readonly cliPath: string;
  readonly gatewayPath: string;
  readonly wxcExecPath: string;
  readonly gatewayConfigPath: string;
}

export interface MxcOpenShellAttachmentObservationRequest {
  readonly contractVersion: typeof MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION;
  readonly providerId: "mxc";
  readonly mode: "attach-existing";
  readonly observedDistribution: {
    readonly version: string;
    readonly revision: string;
  };
  readonly observedGateway: {
    readonly driver: "mxc";
    readonly backend: "process_container";
  };
  readonly installation: MxcOpenShellInstallationLayout;
}

/**
 * Trusted native observation boundary for one installation file.
 *
 * The implementation must reject reparse points and non-regular files, hash one stable handle,
 * and fail when the path or handle identity changes during observation.
 */
export type MxcOpenShellFileDigestObserver = (filePath: string) => Promise<string>;

export type MxcOpenShellObservationFailure =
  | "unsupported-platform"
  | "invalid-path"
  | "observer-unavailable"
  | "observation-rejected"
  | "invalid-output";

/** Redacted failure from a trusted installation-file observation boundary. */
export class MxcOpenShellObservationError extends MxcOpenShellAttachmentError {
  constructor(readonly failure: MxcOpenShellObservationFailure) {
    super(`native Windows stable-file boundary failed (${failure})`);
    this.name = "MxcOpenShellObservationError";
  }
}

function stableOpenFlags(): number {
  if (typeof fsConstants.O_NOFOLLOW !== "number" || typeof fsConstants.O_NONBLOCK !== "number") {
    throw new Error("stable no-follow file observation is unavailable");
  }
  return fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
}

/** Create a no-follow stable-file reader, or fail closed when the OS lacks required flags. */
export function createMxcOpenShellStableFileOperations(): MxcOpenShellStableFileOperations {
  return {
    lstat: async (filePath) => lstat(filePath, { bigint: true }),
    open: async (filePath) => {
      const handle = await open(filePath, stableOpenFlags());
      return {
        stat: async () => handle.stat({ bigint: true }),
        read: async (buffer, offset, length, position) =>
          handle.read(buffer, offset, length, position),
        close: async () => handle.close(),
      };
    },
  };
}

const DEFAULT_FILE_OPERATIONS = createMxcOpenShellStableFileOperations();

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

function canonicalWindowsPath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
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

function exactText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new MxcOpenShellAttachmentError(`${label} is invalid`);
  }
  return value;
}

function sameFileState(left: StableFileStat, right: StableFileStat): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function regularFile(stat: StableFileStat): boolean {
  return stat.isFile() && !stat.isSymbolicLink();
}

/** Hash one regular file through a stable handle and reject replacement during observation. */
export async function readStableMxcOpenShellFileSha256(
  filePath: string,
  operations: MxcOpenShellStableFileOperations = DEFAULT_FILE_OPERATIONS,
): Promise<string> {
  let handle: StableFileHandle | undefined;
  try {
    const pathBefore = await operations.lstat(filePath);
    if (!regularFile(pathBefore)) throw new Error("not a regular file");
    handle = await operations.open(filePath);
    const handleBefore = await handle.stat();
    if (!regularFile(handleBefore) || !sameFileState(pathBefore, handleBefore)) {
      throw new Error("file changed before observation");
    }

    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const handleAfter = await handle.stat();
    const pathAfter = await operations.lstat(filePath);
    if (
      !regularFile(handleAfter) ||
      !regularFile(pathAfter) ||
      !sameFileState(handleBefore, handleAfter) ||
      !sameFileState(handleAfter, pathAfter)
    ) {
      throw new Error("file changed during observation");
    }
    return digest.digest("hex");
  } catch {
    throw new MxcOpenShellAttachmentError(
      "an installation file could not be read through one stable regular-file handle",
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function parseInstallation(value: unknown): MxcOpenShellInstallationLayout {
  const installation = record(value, "installation layout");
  exactKeys(
    installation,
    [
      "cliPath",
      "distributionArtifactPath",
      "distributionRoot",
      "gatewayConfigPath",
      "gatewayPath",
      "mxcRoot",
      "wxcExecPath",
    ],
    "installation layout",
  );
  const parsed = {
    distributionArtifactPath: canonicalWindowsPath(
      installation.distributionArtifactPath,
      "OpenShell distribution artifact path",
    ),
    distributionRoot: canonicalWindowsPath(
      installation.distributionRoot,
      "OpenShell distribution root",
    ),
    mxcRoot: canonicalWindowsPath(installation.mxcRoot, "MXC root"),
    cliPath: canonicalWindowsPath(installation.cliPath, "OpenShell CLI path"),
    gatewayPath: canonicalWindowsPath(installation.gatewayPath, "OpenShell gateway path"),
    wxcExecPath: canonicalWindowsPath(installation.wxcExecPath, "wxc-exec path"),
    gatewayConfigPath: canonicalWindowsPath(
      installation.gatewayConfigPath,
      "OpenShell gateway config path",
    ),
  };
  for (const [label, candidate] of [
    ["OpenShell CLI", parsed.cliPath],
    ["OpenShell gateway", parsed.gatewayPath],
  ] as const) {
    const relative = path.win32.relative(parsed.distributionRoot, candidate);
    if (
      relative.length === 0 ||
      path.win32.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${path.win32.sep}`)
    ) {
      throw new MxcOpenShellAttachmentError(
        `${label} path must remain inside the observed distribution root`,
      );
    }
  }
  const relativeWxcExecPath = path.win32.relative(parsed.mxcRoot, parsed.wxcExecPath);
  if (
    relativeWxcExecPath.length === 0 ||
    path.win32.isAbsolute(relativeWxcExecPath) ||
    relativeWxcExecPath === ".." ||
    relativeWxcExecPath.startsWith(`..${path.win32.sep}`)
  ) {
    throw new MxcOpenShellAttachmentError("wxc-exec path must remain inside the observed MXC root");
  }
  return parsed;
}

function parseRequest(value: unknown): {
  readonly observedDistribution: { readonly version: string; readonly revision: string };
  readonly observedGateway: { readonly driver: "mxc"; readonly backend: "process_container" };
  readonly installation: MxcOpenShellInstallationLayout;
} {
  const request = record(value, "attachment observation request");
  exactKeys(
    request,
    [
      "contractVersion",
      "installation",
      "mode",
      "observedDistribution",
      "observedGateway",
      "providerId",
    ],
    "attachment observation request",
  );
  if (
    request.contractVersion !== MXC_OPENSHELL_ATTACHMENT_CONTRACT_VERSION ||
    request.providerId !== "mxc" ||
    request.mode !== "attach-existing"
  ) {
    throw new MxcOpenShellAttachmentError("observation request identity is invalid");
  }
  const observedDistribution = record(
    request.observedDistribution,
    "observed distribution metadata",
  );
  exactKeys(observedDistribution, ["revision", "version"], "observed distribution metadata");
  const observedGateway = record(request.observedGateway, "observed gateway metadata");
  exactKeys(observedGateway, ["backend", "driver"], "observed gateway metadata");
  if (observedGateway.driver !== "mxc" || observedGateway.backend !== "process_container") {
    throw new MxcOpenShellAttachmentError("observed gateway metadata is unsupported");
  }
  const installation = parseInstallation(request.installation);
  return {
    observedDistribution: {
      version: exactText(observedDistribution.version, "observed distribution version"),
      revision: exactText(observedDistribution.revision, "observed distribution revision"),
    },
    observedGateway: {
      driver: "mxc",
      backend: "process_container",
    },
    installation,
  };
}

/** Observe an existing OpenShell installation without executing or changing it. */
export async function observeMxcOpenShellAttachment(
  request: unknown,
  observeDigest: MxcOpenShellFileDigestObserver,
): Promise<MxcOpenShellAttachmentObservation> {
  const { observedDistribution, observedGateway, installation } = parseRequest(request);
  const observations = [
    ["distribution package", installation.distributionArtifactPath],
    ["OpenShell CLI", installation.cliPath],
    ["OpenShell gateway", installation.gatewayPath],
    ["wxc-exec", installation.wxcExecPath],
    ["gateway configuration", installation.gatewayConfigPath],
  ] as const;
  const observedDigests: string[] = [];
  for (const [label, filePath] of observations) {
    let observedDigest: string;
    try {
      observedDigest = await observeDigest(filePath);
    } catch (error) {
      const category = error instanceof MxcOpenShellObservationError ? ` (${error.failure})` : "";
      throw new MxcOpenShellAttachmentError(`${label} could not be observed${category}`);
    }
    if (!SHA256_PATTERN.test(observedDigest)) {
      throw new MxcOpenShellAttachmentError(`${label} returned an invalid digest`);
    }
    observedDigests.push(observedDigest);
  }

  return cloneAndDeepFreeze({
    distribution: { ...observedDistribution, sha256: observedDigests[0]! },
    components: {
      cliSha256: observedDigests[1]!,
      gatewaySha256: observedDigests[2]!,
      wxcExecSha256: observedDigests[3]!,
    },
    gateway: { ...observedGateway, configSha256: observedDigests[4]! },
    distributionRoot: installation.distributionRoot,
    mxcRoot: installation.mxcRoot,
    cliPath: installation.cliPath,
    gatewayPath: installation.gatewayPath,
    wxcExecPath: installation.wxcExecPath,
    gatewayConfigPath: installation.gatewayConfigPath,
  });
}
