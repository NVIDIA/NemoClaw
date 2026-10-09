// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import type {
  ContainerEngine,
  ContainerEngineCommandResult,
} from "../../adapters/container-engine";
import type { RuntimeProviderDoctorCheck } from "./contract";
import { normalizePodmanCdiInventory } from "./podman-gpu";

export const MINIMUM_PODMAN_VERSION = "5.0.0";
export const MINIMUM_PODMAN_INFERENCE_VERSION = "6.0.0";
export const PODMAN_INFERENCE_AUTHORITY_SCHEMA_VERSION = 1 as const;

const MAX_DISCOVERED_DEVICES = 512;
const AUTHORITY_ID = /^[a-z][a-z0-9-]{0,62}:[A-Za-z0-9._:-]{1,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CDI_QUALIFIED_DEVICE =
  /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?\/[A-Za-z0-9][A-Za-z0-9._-]{0,62}=[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u;
const PRODUCT_QUALIFIED_INFERENCE_AUTHORITY = Symbol("product-qualified-inference-authority");

export interface PodmanHostPreflightReceipt {
  readonly providerId: "podman";
  readonly clientVersion: string;
  readonly serverVersion: string;
  readonly rootless: true;
  readonly cgroupVersion: "v2";
  readonly os: "linux";
  readonly architecture: "amd64" | "arm64";
  readonly networkBackend: string;
}

/** Secret-free authority for one Podman host-local-inference operation. */
export interface PodmanInferenceAuthorityReceipt {
  readonly schemaVersion: typeof PODMAN_INFERENCE_AUTHORITY_SCHEMA_VERSION;
  readonly providerId: "podman";
  readonly operation: "host-local-inference";
  readonly engineId: "podman";
  readonly authorityId: string;
  readonly serverVersion: string;
  readonly rootless: true;
  readonly cgroupVersion: "v2";
  readonly os: "linux";
  readonly architecture: "amd64" | "arm64";
  readonly cdiDevices: readonly string[];
  /** Digest over every preceding field in this receipt. */
  readonly receiptSha256: string;
}

export interface PodmanHostPreflightOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}

export interface PodmanEndpointHostQualificationOptions extends PodmanHostPreflightOptions {
  readonly expectedVersion: string;
  readonly expectedNetworkBackend: string;
}

export interface PodmanInferenceQualificationOptions {
  /** Exact server version accepted by a product-specific runtime matrix. */
  readonly expectedVersion?: string;
  /**
   * Fresh authoritative CDI capture for a product-specific runtime matrix
   * whose Podman release cannot report its inventory through `podman info`.
   */
  readonly captureCurrentCdiDevices?: (engine: ContainerEngine) => readonly string[];
  /** Product-owned authority matrix that must stay current around every qualification. */
  readonly assertCurrentAuthority?: () => void;
}

export class PodmanHostPreflightError extends Error {
  constructor(message: string) {
    super(`Podman preflight failed: ${message}`);
    this.name = "PodmanHostPreflightError";
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function field(value: unknown, ...names: string[]): unknown {
  const source = record(value);
  if (!source) return undefined;
  for (const name of names) {
    if (Object.hasOwn(source, name)) return source[name];
  }
  return undefined;
}

function textField(value: unknown, ...names: string[]): string {
  const candidate = field(value, ...names);
  return typeof candidate === "string" ? candidate.trim() : "";
}

function booleanField(value: unknown, ...names: string[]): boolean | null {
  const candidate = field(value, ...names);
  return typeof candidate === "boolean" ? candidate : null;
}

function dottedVersion(value: string): readonly number[] | null {
  const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\D|$)/u);
  return match ? match.slice(1, 4).map(Number) : null;
}

export function isPodmanVersionSupported(
  actual: string,
  minimum = MINIMUM_PODMAN_VERSION,
): boolean {
  const actualParts = dottedVersion(actual);
  const minimumParts = dottedVersion(minimum);
  if (!actualParts || !minimumParts) return false;
  for (let index = 0; index < minimumParts.length; index += 1) {
    const delta = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return true;
}

function requireSupportedVersion(
  value: string,
  subject: "client" | "server",
  minimum = MINIMUM_PODMAN_VERSION,
): string {
  const version = dottedVersion(value)?.join(".") ?? "";
  if (!isPodmanVersionSupported(version, minimum)) {
    throw new PodmanHostPreflightError(
      `Podman ${minimum} or newer is required on the ${subject}; detected '${version || "unavailable"}'`,
    );
  }
  return version;
}

function commandDetail(result: ContainerEngineCommandResult): string {
  return (result.stderr || result.stdout || result.error?.message || "unavailable")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-500);
}

function requireSuccessful(
  operation: string,
  result: ContainerEngineCommandResult,
): ContainerEngineCommandResult {
  if (result.status !== 0 || result.error) {
    throw new PodmanHostPreflightError(`${operation}: ${commandDetail(result)}`);
  }
  return result;
}

function parseJsonResult(result: ContainerEngineCommandResult, label: string): unknown {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new PodmanHostPreflightError(`the Podman API returned unreadable ${label}`);
  }
}

interface InspectedServerVersion {
  readonly canonicalVersion: string;
  readonly reportedVersion: unknown;
}

interface QualifiedPodmanHostIdentity {
  readonly rootless: true;
  readonly cgroupVersion: "v2";
  readonly os: "linux";
  readonly architecture: "amd64" | "arm64";
  readonly networkBackend: string;
}

function requireSupportedHostPlatform(options: PodmanHostPreflightOptions): {
  readonly platform: "linux";
  readonly architecture: "x64" | "arm64";
} {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  if (platform !== "linux" || (architecture !== "x64" && architecture !== "arm64")) {
    throw new PodmanHostPreflightError(
      `basic native lifecycle requires Linux amd64 or arm64; detected ${platform} ${architecture}`,
    );
  }
  return { platform, architecture };
}

function inspectServerVersion(engine: ContainerEngine, minimum: string): InspectedServerVersion {
  const result = requireSuccessful(
    "server version inspection",
    engine.capture(["version", "--format", "json"], 10_000),
  );
  const versionInfo = parseJsonResult(result, "version information");
  const reportedVersion = field(field(versionInfo, "Server", "server"), "Version", "version");
  const canonicalSource = typeof reportedVersion === "string" ? reportedVersion.trim() : "";
  return Object.freeze({
    canonicalVersion: requireSupportedVersion(canonicalSource, "server", minimum),
    reportedVersion,
  });
}

function inspectInfo(engine: ContainerEngine, label: string): JsonRecord {
  const result = requireSuccessful(label, engine.capture(["info", "--format", "json"], 15_000));
  const parsed = record(parseJsonResult(result, "system information"));
  if (!parsed) throw new PodmanHostPreflightError("Podman system information must be an object");
  return parsed;
}

function requireExactVersion(
  value: unknown,
  subject: "client" | "server",
  expected: string,
): string {
  const actual = typeof value === "string" ? value.trim() : "";
  if (actual !== expected) {
    throw new PodmanHostPreflightError(
      `Podman ${subject} version must be exactly ${expected}; detected '${actual || "unavailable"}'`,
    );
  }
  return actual;
}

function normalizeArchitecture(value: string): "amd64" | "arm64" | null {
  if (value === "amd64" || value === "x86_64") return "amd64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  return null;
}

function requireSubordinateIdMappings(host: unknown): void {
  // Bind this check to the same rootless API service as the rest of the
  // preflight. A local `podman unshare` can resolve different storage and user
  // authority than an explicitly bound service endpoint.
  const mappings = field(host, "idMappings", "IDMappings");
  for (const mapping of ["uidmap", "gidmap"] as const) {
    const entries = field(mappings, mapping, mapping === "uidmap" ? "UIDMap" : "GIDMap");
    if (!Array.isArray(entries) || entries.length === 0 || entries.length > 1_024) {
      throw new PodmanHostPreflightError(`the Podman API returned malformed ${mapping}`);
    }
    let hasSubordinateRange = false;
    for (const value of entries) {
      const entry = record(value);
      const containerId = field(entry, "container_id", "containerID", "ContainerID");
      const hostId = field(entry, "host_id", "hostID", "HostID");
      const size = field(entry, "size", "Size");
      if (
        !entry ||
        !Number.isSafeInteger(containerId) ||
        !Number.isSafeInteger(hostId) ||
        !Number.isSafeInteger(size) ||
        (containerId as number) < 0 ||
        (hostId as number) < 0 ||
        (size as number) <= 0
      ) {
        throw new PodmanHostPreflightError(`the Podman API returned malformed ${mapping}`);
      }
      if ((size as number) > 1) hasSubordinateRange = true;
    }
    if (!hasSubordinateRange) {
      throw new PodmanHostPreflightError(
        `rootless Podman requires a subordinate ${mapping === "uidmap" ? "UID" : "GID"} range for the API service user`,
      );
    }
  }
}

function qualifyPodmanHostIdentity(
  info: JsonRecord,
  options: PodmanHostPreflightOptions,
): QualifiedPodmanHostIdentity {
  const { architecture } = requireSupportedHostPlatform(options);
  const host = field(info, "host", "Host");
  const security = field(host, "security", "Security");
  if (booleanField(security, "rootless", "Rootless") !== true) {
    throw new PodmanHostPreflightError("a rootless Podman API service is required");
  }
  const cgroupVersion = textField(
    host,
    "cgroupVersion",
    "cgroupsVersion",
    "CgroupVersion",
    "CgroupsVersion",
  ).toLowerCase();
  if (cgroupVersion !== "v2") {
    throw new PodmanHostPreflightError(
      `cgroups v2 is required; detected '${cgroupVersion || "unknown"}'`,
    );
  }
  const hostOs = textField(host, "os", "OS").toLowerCase();
  if (hostOs !== "linux") {
    throw new PodmanHostPreflightError(
      `the Podman service must run Linux; detected '${hostOs || "unknown"}'`,
    );
  }
  const reportedArchitecture = textField(host, "arch", "Arch").toLowerCase();
  const normalizedArchitecture = normalizeArchitecture(reportedArchitecture);
  if (!normalizedArchitecture) {
    throw new PodmanHostPreflightError(
      `the Podman service must report amd64 or arm64; detected '${reportedArchitecture || "unknown"}'`,
    );
  }
  const expectedArchitecture = architecture === "x64" ? "amd64" : "arm64";
  if (normalizedArchitecture !== expectedArchitecture) {
    throw new PodmanHostPreflightError(
      `the Podman service architecture '${normalizedArchitecture}' does not match host '${expectedArchitecture}'`,
    );
  }
  requireSubordinateIdMappings(host);
  return Object.freeze({
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture: normalizedArchitecture,
    networkBackend: textField(host, "networkBackend", "NetworkBackend") || "unknown",
  });
}

function safeSchemaText(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value === "" ||
    value !== value.trim() ||
    Buffer.byteLength(value, "utf8") > 512 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    throw new PodmanHostPreflightError(`${label} is malformed`);
  }
  return value;
}

function exactNvidiaCdiInventory(info: JsonRecord): readonly string[] {
  const host = record(info.host);
  if (!host) throw new PodmanHostPreflightError("Podman host authority is unavailable");
  // Podman v6 marks discoveredDevices omitempty, so an absent property is the
  // canonical representation of an empty provider inventory.
  if (!Object.hasOwn(host, "discoveredDevices")) return Object.freeze([]);
  const discovered = host.discoveredDevices;
  if (!Array.isArray(discovered) || discovered.length > MAX_DISCOVERED_DEVICES) {
    throw new PodmanHostPreflightError("host.discoveredDevices has an unsupported schema");
  }
  const nvidiaDevices: string[] = [];
  for (const value of discovered) {
    const device = record(value);
    if (!device || Object.keys(device).sort().join(",") !== "id,source") {
      throw new PodmanHostPreflightError(
        "each host.discoveredDevices entry must contain only source and id",
      );
    }
    const source = safeSchemaText(device.source, "host.discoveredDevices source");
    const id = safeSchemaText(device.id, "host.discoveredDevices id");
    if (source !== "cdi") {
      if (id.startsWith("nvidia.com/gpu=")) {
        throw new PodmanHostPreflightError(
          "an NVIDIA CDI identity has an ambiguous non-CDI device source",
        );
      }
      continue;
    }
    if (!CDI_QUALIFIED_DEVICE.test(id)) {
      throw new PodmanHostPreflightError(
        "host.discoveredDevices contains a malformed CDI identity",
      );
    }
    if (id.startsWith("nvidia.com/gpu=")) nvidiaDevices.push(id);
  }
  return normalizePodmanCdiInventory(nvidiaDevices);
}

function requireInferenceEngine(engine: ContainerEngine): void {
  if (engine.operation !== "host-local-inference" || engine.engineId !== "podman") {
    throw new PodmanHostPreflightError(
      "GPU qualification requires a Podman host-local-inference engine",
    );
  }
}

function inferenceAuthorityPayload(
  authorityId: string,
  serverVersion: string,
  architecture: "amd64" | "arm64",
  cdiDevices: readonly string[],
): Omit<PodmanInferenceAuthorityReceipt, "receiptSha256"> {
  return {
    schemaVersion: PODMAN_INFERENCE_AUTHORITY_SCHEMA_VERSION,
    providerId: "podman",
    operation: "host-local-inference",
    engineId: "podman",
    authorityId,
    serverVersion,
    rootless: true,
    cgroupVersion: "v2",
    os: "linux",
    architecture,
    cdiDevices,
  };
}

function inferenceAuthorityDigest(
  payload: Omit<PodmanInferenceAuthorityReceipt, "receiptSha256">,
): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function normalizeInferenceAuthorityReceipt(
  value: unknown,
  minimumVersion: string,
): PodmanInferenceAuthorityReceipt {
  const receipt = record(value);
  if (
    !receipt ||
    Object.keys(receipt).sort().join(",") !==
      "architecture,authorityId,cdiDevices,cgroupVersion,engineId,operation,os,providerId,receiptSha256,rootless,schemaVersion,serverVersion" ||
    receipt.schemaVersion !== PODMAN_INFERENCE_AUTHORITY_SCHEMA_VERSION ||
    receipt.providerId !== "podman" ||
    receipt.operation !== "host-local-inference" ||
    receipt.engineId !== "podman" ||
    typeof receipt.authorityId !== "string" ||
    !AUTHORITY_ID.test(receipt.authorityId) ||
    typeof receipt.serverVersion !== "string" ||
    receipt.serverVersion !== receipt.serverVersion.trim() ||
    !isPodmanVersionSupported(receipt.serverVersion, minimumVersion) ||
    receipt.rootless !== true ||
    receipt.cgroupVersion !== "v2" ||
    receipt.os !== "linux" ||
    (receipt.architecture !== "amd64" && receipt.architecture !== "arm64") ||
    typeof receipt.receiptSha256 !== "string" ||
    !SHA256.test(receipt.receiptSha256) ||
    !Array.isArray(receipt.cdiDevices)
  ) {
    throw new PodmanHostPreflightError("inference authority receipt is malformed");
  }
  const cdiDevices = normalizePodmanCdiInventory(receipt.cdiDevices);
  const payload = inferenceAuthorityPayload(
    receipt.authorityId,
    receipt.serverVersion,
    receipt.architecture,
    cdiDevices,
  );
  const receiptSha256 = inferenceAuthorityDigest(payload);
  if (receiptSha256 !== receipt.receiptSha256) {
    throw new PodmanHostPreflightError("inference authority receipt digest does not match");
  }
  return Object.freeze({ ...payload, receiptSha256 });
}

export function normalizePodmanInferenceAuthorityReceipt(
  value: unknown,
): PodmanInferenceAuthorityReceipt {
  return normalizeInferenceAuthorityReceipt(value, MINIMUM_PODMAN_INFERENCE_VERSION);
}

export function normalizeQualifiedPodmanInferenceAuthorityReceipt(
  value: unknown,
): PodmanInferenceAuthorityReceipt {
  if (
    typeof value === "object" &&
    value !== null &&
    (value as { [PRODUCT_QUALIFIED_INFERENCE_AUTHORITY]?: unknown })[
      PRODUCT_QUALIFIED_INFERENCE_AUTHORITY
    ] === true
  ) {
    return normalizeInferenceAuthorityReceipt(value, MINIMUM_PODMAN_VERSION);
  }
  return normalizePodmanInferenceAuthorityReceipt(value);
}

/** Qualify the exact endpoint's authoritative NVIDIA CDI inventory, including empty. */
export function qualifyPodmanInferenceAuthority(
  engine: ContainerEngine,
  options: PodmanInferenceQualificationOptions = {},
): PodmanInferenceAuthorityReceipt {
  options.assertCurrentAuthority?.();
  requireInferenceEngine(engine);
  if (
    (options.expectedVersion === undefined) !==
    (options.captureCurrentCdiDevices === undefined)
  ) {
    throw new PodmanHostPreflightError(
      "an exact inference version and CDI inventory must be supplied together",
    );
  }
  const minimumVersion = options.expectedVersion ?? MINIMUM_PODMAN_INFERENCE_VERSION;
  if (!isPodmanVersionSupported(minimumVersion, MINIMUM_PODMAN_VERSION)) {
    throw new PodmanHostPreflightError("the exact inference version is unsupported");
  }
  const { reportedVersion } = inspectServerVersion(engine, minimumVersion);
  const serverVersion = safeSchemaText(reportedVersion, "Podman server version");
  if (options.expectedVersion !== undefined && serverVersion !== options.expectedVersion) {
    throw new PodmanHostPreflightError("the Podman server version changed after qualification");
  }
  const info = inspectInfo(engine, "CDI inventory inspection");
  const host = record(info.host);
  const architecture = normalizeArchitecture(textField(host, "arch").toLowerCase());
  if (
    !host ||
    !architecture ||
    textField(host, "os").toLowerCase() !== "linux" ||
    textField(host, "cgroupVersion").toLowerCase() !== "v2" ||
    booleanField(field(host, "security"), "rootless") !== true
  ) {
    throw new PodmanHostPreflightError(
      "host-local inference requires a rootless Linux Podman service with cgroups v2",
    );
  }
  const payload = inferenceAuthorityPayload(
    engine.authorityId,
    serverVersion,
    architecture,
    options.captureCurrentCdiDevices === undefined
      ? exactNvidiaCdiInventory(info)
      : normalizePodmanCdiInventory(options.captureCurrentCdiDevices(engine)),
  );
  const receipt = { ...payload, receiptSha256: inferenceAuthorityDigest(payload) };
  if (options.expectedVersion !== undefined) {
    Object.defineProperty(receipt, PRODUCT_QUALIFIED_INFERENCE_AUTHORITY, { value: true });
  }
  options.assertCurrentAuthority?.();
  return Object.freeze(receipt);
}

/** Refresh endpoint-native CDI state and reject drift before one mutation. */
export function revalidatePodmanInferenceAuthority(
  engine: ContainerEngine,
  expected: PodmanInferenceAuthorityReceipt,
  options: PodmanInferenceQualificationOptions = {},
): PodmanInferenceAuthorityReceipt {
  requireInferenceEngine(engine);
  const normalized = normalizeQualifiedPodmanInferenceAuthorityReceipt(expected);
  if (engine.authorityId !== normalized.authorityId) {
    throw new PodmanHostPreflightError(
      "the Podman endpoint authority changed before local-inference mutation",
    );
  }
  const refreshed =
    options.captureCurrentCdiDevices === undefined &&
    isPodmanVersionSupported(normalized.serverVersion, MINIMUM_PODMAN_INFERENCE_VERSION)
      ? qualifyPodmanInferenceAuthority(engine, {
          assertCurrentAuthority: options.assertCurrentAuthority,
        })
      : qualifyPodmanInferenceAuthority(engine, {
          expectedVersion: normalized.serverVersion,
          assertCurrentAuthority: options.assertCurrentAuthority,
          captureCurrentCdiDevices:
            options.captureCurrentCdiDevices ??
            (() => {
              throw new PodmanHostPreflightError(
                "fresh CDI authority is required to revalidate this Podman release",
              );
            }),
        });
  if (refreshed.receiptSha256 !== normalized.receiptSha256) {
    throw new PodmanHostPreflightError(
      "the Podman server or NVIDIA CDI authority changed before local-inference mutation",
    );
  }
  return refreshed;
}

export function qualifyPodmanHost(
  engine: ContainerEngine,
  options: PodmanHostPreflightOptions = {},
): PodmanHostPreflightReceipt {
  if (engine.operation !== "host-doctor" || engine.engineId !== "podman") {
    throw new PodmanHostPreflightError("host qualification requires a Podman host-doctor engine");
  }
  requireSupportedHostPlatform(options);
  const clientVersionResult = requireSuccessful(
    "client version inspection",
    engine.captureHost(["--version"], 10_000),
  );
  const clientVersion = requireSupportedVersion(clientVersionResult.stdout, "client");
  const { canonicalVersion: serverVersion } = inspectServerVersion(engine, MINIMUM_PODMAN_VERSION);
  const info = inspectInfo(engine, "rootless API inspection");
  const identity = qualifyPodmanHostIdentity(info, options);

  return Object.freeze({
    providerId: "podman",
    clientVersion,
    serverVersion,
    ...identity,
  });
}

/** Qualify the exact socket-bound Podman client and service used for sandbox lifecycle. */
export function qualifyPodmanEndpointHost(
  engine: ContainerEngine,
  options: PodmanEndpointHostQualificationOptions,
): PodmanHostPreflightReceipt {
  if (engine.operation !== "sandbox-lifecycle" || engine.engineId !== "podman") {
    throw new PodmanHostPreflightError(
      "endpoint qualification requires a Podman sandbox-lifecycle engine",
    );
  }
  requireSupportedHostPlatform(options);
  const versionResult = requireSuccessful(
    "client and server version inspection",
    engine.capture(["version", "--format", "json"], 10_000),
  );
  const versionInfo = parseJsonResult(versionResult, "version information");
  const clientVersion = requireExactVersion(
    field(field(versionInfo, "Client", "client"), "Version", "version"),
    "client",
    options.expectedVersion,
  );
  const serverVersion = requireExactVersion(
    field(field(versionInfo, "Server", "server"), "Version", "version"),
    "server",
    options.expectedVersion,
  );
  const identity = qualifyPodmanHostIdentity(
    inspectInfo(engine, "rootless API inspection"),
    options,
  );
  if (identity.networkBackend !== options.expectedNetworkBackend) {
    throw new PodmanHostPreflightError(
      `network backend must be '${options.expectedNetworkBackend}'; detected '${identity.networkBackend}'`,
    );
  }
  return Object.freeze({
    providerId: "podman",
    clientVersion,
    serverVersion,
    ...identity,
  });
}

export function inspectPodmanHost(
  engine: ContainerEngine,
  options: PodmanHostPreflightOptions = {},
): RuntimeProviderDoctorCheck {
  try {
    const receipt = qualifyPodmanHost(engine, options);
    return {
      group: "Host",
      label: "Podman runtime",
      status: "ok",
      detail: `rootless server ${receipt.serverVersion} (client ${receipt.clientVersion}), cgroups v2, ${receipt.os}/${receipt.architecture}`,
    };
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/gu, " ")
      .trim()
      .slice(-500);
    return {
      group: "Host",
      label: "Podman runtime",
      status: "fail",
      detail,
      hint: "start a rootless Podman 5 API service on Linux and retry",
    };
  }
}
