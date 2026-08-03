// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import path from "node:path";

import type { BuildIdentity } from "../../core/version.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import {
  type DualStationSshBinding,
  type QualifiedStationSshIdentity,
} from "../vllm-station-ssh-binding.js";
import {
  DUAL_SPARK_VLLM_MASTER_PORT,
  DUAL_SPARK_VLLM_MATERIALIZER_REF,
} from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog.js";
import { immutableManagedInferenceCopy } from "./catalog-integrity.js";
import { createProductionDualSparkDiscoveryDeps } from "./dual-spark-discovery-production.js";
import {
  type DualSparkNodeSnapshot,
  type DualSparkObservedContainer,
  isRelatedManagedVllmContainer,
} from "./dual-spark-lifecycle.js";
import {
  type DualSparkNodeObservation,
  type DualSparkPeerObservation,
  type DualSparkRailObservation,
  type DualSparkTopologyArtifact,
  type DualSparkTopologyOutput,
  dualSparkTopologyOutputDigest,
  getDualSparkTopologyArtifactError,
  qualifyDualSparkTopology,
} from "./dual-spark-topology.js";

export const NEMOCLAW_DGX_SPARK_PEER_ENV = "NEMOCLAW_DGX_SPARK_PEER" as const;
export const NEMOCLAW_SERVING_PRESET_ENV = "NEMOCLAW_SERVING_PRESET" as const;

const HOST_PROBE_SCHEMA_VERSION = 1;
const DIRECT_RAIL_PREFIX_LENGTH = 30;
const EXPECTED_CX7_SPEED_MBPS = 200_000;
const MINIMUM_CX7_MTU = 9_000;
const MINIMUM_AVAILABLE_INODES = 1_024;
const SAFE_TARGET_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SAFE_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const GPU_UUID_PATTERN = /^GPU-[A-Za-z0-9-]+$/;
const MACHINE_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAC_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const PCI_ADDRESS_PATTERN = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface DualSparkCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface DualSparkReadOnlyHostTransport {
  execute(argv: readonly string[]): DualSparkCommandResult;
  readFile(filePath: string): string;
  readdir(directory: string): string[];
}

export interface DualSparkGpuObservation {
  readonly index: number;
  readonly name: string;
  readonly uuid: string;
}

export interface DualSparkIpv4Observation {
  readonly address: string;
  readonly prefixLength: number;
}

export interface DualSparkRoceGidHostObservation {
  readonly index: number;
  readonly value: string;
  readonly ipv4Address: string;
}

export interface DualSparkCx7RailHostObservation {
  readonly physicalPortId: string;
  readonly netdev: string;
  readonly hcaDevice: string;
  readonly hcaPort: number;
  readonly macAddress: string;
  readonly pciAddress: string;
  readonly pciName: string;
  readonly state: string;
  readonly operState: string;
  readonly carrier: boolean;
  readonly linkLayer: string;
  readonly speedMbps: number;
  readonly mtu: number;
  readonly ipv4Addresses: readonly DualSparkIpv4Observation[];
  readonly roceV2Ipv4Gids: readonly DualSparkRoceGidHostObservation[];
}

export interface DualSparkEarlyoomObservation {
  readonly installed: boolean;
  readonly active: "active" | "inactive" | "unknown";
  readonly enabled: "enabled" | "disabled" | "unknown";
}

export interface DualSparkStorageCapacityObservation {
  readonly requestedPath: string;
  readonly probePath: string | null;
  readonly filesystemId: string | null;
  readonly availableBytes: number | null;
  readonly availableInodes: number | null;
  readonly ownerUid: number | null;
  readonly ownerGid: number | null;
  readonly isDirectory: boolean;
  readonly writableByUser: boolean;
}

export interface DualSparkStorageObservation {
  readonly huggingFace: DualSparkStorageCapacityObservation & {
    readonly cacheRoot: string;
  };
  readonly docker: DualSparkStorageCapacityObservation & {
    readonly dockerRootDir: string | null;
  };
}

export interface DualSparkHostObservation {
  readonly schemaVersion: 1;
  readonly hostname: string;
  readonly nodeId: string;
  readonly productName: string;
  readonly architecture: string;
  readonly home: string;
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly gpus: readonly DualSparkGpuObservation[];
  readonly rails: readonly DualSparkCx7RailHostObservation[];
  readonly earlyoom: DualSparkEarlyoomObservation;
  readonly runtimeInspectionComplete: boolean;
  readonly runtimeSnapshot: DualSparkNodeSnapshot;
  readonly storage: DualSparkStorageObservation;
}

export interface DualSparkPinnedPeerTransport {
  readonly transport: DualSparkReadOnlyHostTransport;
  close(): void;
}

export interface DualSparkConnectivityRequest {
  readonly netdev: string;
  readonly sourceAddress: string;
  readonly peerAddress: string;
  readonly expectedPeerMac: string;
}

export interface DualSparkDiscoveryDeps {
  now(): Date;
  currentUid(): number | null;
  getBuildIdentity(): BuildIdentity;
  localTransport(): DualSparkReadOnlyHostTransport;
  probeHost(transport: DualSparkReadOnlyHostTransport): DualSparkHostObservation;
  inspectPretrustedTarget(target: string): QualifiedStationSshIdentity | null;
  openPinnedPeerTransport(identity: QualifiedStationSshIdentity): DualSparkPinnedPeerTransport;
  createReadiness(
    host: DualSparkHostObservation,
    transport: DualSparkReadOnlyHostTransport,
    buildIdentity: BuildIdentity,
    now: Date,
  ): SystemReadinessReport;
  probeConnectivity(
    transport: DualSparkReadOnlyHostTransport,
    requests: readonly DualSparkConnectivityRequest[],
  ): boolean;
  /** Atomically claim a new binding root. False means an existing owner won. */
  claimBinding(statePath: string): boolean;
  writeBinding(statePath: string, identity: QualifiedStationSshIdentity): DualStationSshBinding;
  clearBinding(statePath: string): void;
  encodeBinding(binding: DualStationSshBinding): string;
  resolveBindingStatePath(): string;
}

export type DualSparkManagedServingFailureCode =
  | "no-match"
  | "incompatible-selection"
  | "invalid-peer"
  | "local-host-unavailable"
  | "peer-trust-unavailable"
  | "peer-identity-ambiguous"
  | "peer-host-unavailable"
  | "host-unqualified"
  | "earlyoom-active"
  | "earlyoom-unknown"
  | "storage-unavailable"
  | "storage-insufficient"
  | "runtime-conflict"
  | "runtime-unknown"
  | "fabric-unavailable"
  | "connectivity-unavailable"
  | "readiness-unavailable"
  | "binding-conflict"
  | "binding-persistence-failed"
  | "topology-unavailable";

export type DualSparkDetectedManagedServingCapability = {
  readonly kind: "ready";
  readonly selectionIntent: "automatic" | "explicit";
  readonly topology: DualSparkTopologyArtifact;
  readonly local: DualSparkHostObservation;
  readonly peer: DualSparkHostObservation;
  readonly readiness: readonly [
    { readonly nodeId: string; readonly report: SystemReadinessReport },
    { readonly nodeId: string; readonly report: SystemReadinessReport },
  ];
  /** Exact transaction state path that may be claimed only after confirmation. */
  readonly peerSshBindingStatePath: string;
  readonly peerSshIdentity: QualifiedStationSshIdentity;
};

export type DualSparkManagedServingCapability =
  | {
      readonly kind: "not-selected";
      readonly code: DualSparkManagedServingFailureCode;
      readonly reason: string;
    }
  | {
      readonly kind: "unavailable";
      readonly code: DualSparkManagedServingFailureCode;
      readonly reason: string;
    }
  | DualSparkDetectedManagedServingCapability;

export type DualSparkConfirmedManagedServingCapability =
  DualSparkDetectedManagedServingCapability & {
    readonly peerSshBinding: DualStationSshBinding;
    readonly peerSshBindingHandle: string;
  };

export type DualSparkManagedServingConfirmation =
  | Exclude<DualSparkManagedServingCapability, { kind: "ready" }>
  | DualSparkConfirmedManagedServingCapability;

export interface ProbeDualSparkManagedServingOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly deps?: DualSparkDiscoveryDeps;
  /** @internal Catalog loader seam for fail-closed tests. */
  readonly loadCatalog?: typeof loadManagedInferenceCatalog;
  readonly bindingStatePath?: string;
  readonly maxReadinessAgeMs?: number;
}

interface QualifiedRail {
  readonly host: DualSparkCx7RailHostObservation;
  readonly address: string;
  readonly peerAddress: string;
  readonly subnet: string;
  readonly gid: DualSparkRoceGidHostObservation;
}

interface QualifiedHost {
  readonly host: DualSparkHostObservation;
  readonly gpu: DualSparkGpuObservation;
  readonly rails: readonly [QualifiedRail, QualifiedRail];
}

interface PairPlan {
  readonly local: QualifiedHost;
  readonly peer: QualifiedHost;
  readonly localConnectivity: readonly [DualSparkConnectivityRequest, DualSparkConnectivityRequest];
  readonly peerConnectivity: readonly [DualSparkConnectivityRequest, DualSparkConnectivityRequest];
}

type DiscoveryFailure = {
  readonly code: DualSparkManagedServingFailureCode;
  readonly reason: string;
};

type Selection = {
  readonly strict: boolean;
  readonly intent: "automatic" | "explicit";
  readonly explicitPeer: string | null;
};

function notSelected(
  code: DualSparkManagedServingFailureCode,
  reason: string,
): DualSparkManagedServingCapability {
  return { kind: "not-selected", code, reason };
}

function unavailable(
  code: DualSparkManagedServingFailureCode,
  reason: string,
): DualSparkManagedServingCapability {
  return { kind: "unavailable", code, reason };
}

function disposition(
  selection: Selection,
  result: DiscoveryFailure,
): DualSparkManagedServingCapability {
  if (selection.strict) return unavailable(result.code, result.reason);
  const code: DualSparkManagedServingFailureCode = [
    "runtime-conflict",
    "runtime-unknown",
    "binding-conflict",
    "binding-persistence-failed",
  ].includes(result.code)
    ? result.code
    : "no-match";
  return notSelected(code, result.reason);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePeerTarget(raw: string): string {
  if (
    raw.length === 0 ||
    raw.length > 286 ||
    raw !== raw.trim() ||
    /[/,:;`'"\\$(){}[\]<>|&!?*\s\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new Error(`${NEMOCLAW_DGX_SPARK_PEER_ENV} must name one canonical SSH host or user@host`);
  }
  const parts = raw.split("@");
  const username = parts.length === 2 ? parts[0] : "";
  const hostname = parts.at(-1) ?? "";
  if (
    parts.length > 2 ||
    (parts.length === 2 && !username) ||
    (username !== "" && !SAFE_USERNAME_PATTERN.test(username)) ||
    (net.isIP(hostname) !== 4 && !SAFE_TARGET_PATTERN.test(hostname))
  ) {
    throw new Error(`${NEMOCLAW_DGX_SPARK_PEER_ENV} must name one canonical SSH host or user@host`);
  }
  return raw;
}

function selectionFromEnvironment(
  env: NodeJS.ProcessEnv,
  loadCatalog: typeof loadManagedInferenceCatalog,
): Selection | DualSparkManagedServingCapability {
  const preset = String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  const peer = String(env[NEMOCLAW_DGX_SPARK_PEER_ENV] ?? "").trim();
  if (preset) {
    let catalog;
    try {
      catalog = loadCatalog();
    } catch {
      return unavailable(
        "incompatible-selection",
        "The selected managed inference preset catalog is unavailable.",
      );
    }
    const compiledPreset = catalog.presets.find(
      ({ definition }) => definition.metadata.id === preset,
    );
    const recipe = compiledPreset
      ? catalog.recipes.find(
          ({ definition }) =>
            definition.metadata.id === compiledPreset.definition.spec.plan.recipeRef,
        )?.definition
      : undefined;
    if (recipe?.spec.execution.materializerRef !== DUAL_SPARK_VLLM_MATERIALIZER_REF) {
      return peer
        ? unavailable(
            "incompatible-selection",
            `${NEMOCLAW_DGX_SPARK_PEER_ENV} cannot be combined with another serving preset.`,
          )
        : notSelected("no-match", "Another managed inference preset is selected.");
    }
  }
  if (peer) {
    try {
      return {
        strict: true,
        intent: "explicit",
        explicitPeer: validatePeerTarget(peer),
      };
    } catch (error) {
      return unavailable("invalid-peer", (error as Error).message);
    }
  }
  return {
    strict: Boolean(preset),
    intent: preset ? "explicit" : "automatic",
    explicitPeer: null,
  };
}

function ipv4ToNumber(address: string): number {
  return address
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);
}

function numberToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

function privateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return (
    (value >= ipv4ToNumber("10.0.0.0") && value <= ipv4ToNumber("10.255.255.255")) ||
    (value >= ipv4ToNumber("172.16.0.0") && value <= ipv4ToNumber("172.31.255.255")) ||
    (value >= ipv4ToNumber("192.168.0.0") && value <= ipv4ToNumber("192.168.255.255"))
  );
}

function slash30Counterpart(address: string, prefixLength: number): string | null {
  if (prefixLength !== DIRECT_RAIL_PREFIX_LENGTH || net.isIP(address) !== 4) return null;
  if (!privateIpv4(address)) return null;
  const value = ipv4ToNumber(address);
  const network = Math.floor(value / 4) * 4;
  const host = value - network;
  if (host === 1) return numberToIpv4(network + 2);
  if (host === 2) return numberToIpv4(network + 1);
  return null;
}

function slash30Subnet(address: string): string {
  return `${numberToIpv4(Math.floor(ipv4ToNumber(address) / 4) * 4)}/30`;
}

function isSafeText(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeInteger(
  value: unknown,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  return Number.isInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function validStorageCapacity(value: unknown): value is DualSparkStorageCapacityObservation {
  if (
    !isRecord(value) ||
    !isSafeText(value.requestedPath) ||
    !path.isAbsolute(value.requestedPath)
  ) {
    return false;
  }
  return (
    (value.probePath === null ||
      (isSafeText(value.probePath) && path.isAbsolute(value.probePath))) &&
    (value.filesystemId === null || isSafeText(value.filesystemId, 128)) &&
    (value.availableBytes === null || isSafeInteger(value.availableBytes)) &&
    (value.availableInodes === null || isSafeInteger(value.availableInodes)) &&
    (value.ownerUid === null || isSafeInteger(value.ownerUid, 0, 2 ** 31 - 1)) &&
    (value.ownerGid === null || isSafeInteger(value.ownerGid, 0, 2 ** 31 - 1)) &&
    typeof value.isDirectory === "boolean" &&
    typeof value.writableByUser === "boolean"
  );
}

function validGpu(value: unknown): value is DualSparkGpuObservation {
  return (
    isRecord(value) &&
    isSafeInteger(value.index, 0, 1024) &&
    isSafeText(value.name, 256) &&
    isSafeText(value.uuid, 128) &&
    GPU_UUID_PATTERN.test(value.uuid)
  );
}

function validRail(value: unknown): value is DualSparkCx7RailHostObservation {
  if (
    !isRecord(value) ||
    !isSafeText(value.physicalPortId, 128) ||
    !SAFE_DEVICE_PATTERN.test(value.physicalPortId) ||
    !isSafeText(value.netdev, 64) ||
    !SAFE_DEVICE_PATTERN.test(value.netdev) ||
    !isSafeText(value.hcaDevice, 64) ||
    !SAFE_DEVICE_PATTERN.test(value.hcaDevice) ||
    !isSafeInteger(value.hcaPort, 1, 255) ||
    !isSafeText(value.macAddress, 17) ||
    !MAC_PATTERN.test(value.macAddress) ||
    value.macAddress === "00:00:00:00:00:00" ||
    !isSafeText(value.pciAddress, 32) ||
    !PCI_ADDRESS_PATTERN.test(value.pciAddress) ||
    !isSafeText(value.pciName, 512) ||
    !isSafeText(value.state, 64) ||
    !isSafeText(value.operState, 32) ||
    typeof value.carrier !== "boolean" ||
    !isSafeText(value.linkLayer, 64) ||
    !isSafeInteger(value.speedMbps, -1, 1_000_000) ||
    !isSafeInteger(value.mtu, 0, 1_000_000) ||
    !Array.isArray(value.ipv4Addresses) ||
    value.ipv4Addresses.length > 16 ||
    !Array.isArray(value.roceV2Ipv4Gids) ||
    value.roceV2Ipv4Gids.length > 64
  ) {
    return false;
  }
  return (
    value.ipv4Addresses.every(
      (address) =>
        isRecord(address) &&
        isSafeText(address.address, 15) &&
        net.isIP(address.address) === 4 &&
        isSafeInteger(address.prefixLength, 1, 32),
    ) &&
    value.roceV2Ipv4Gids.every(
      (gid) =>
        isRecord(gid) &&
        isSafeInteger(gid.index, 0, 4095) &&
        isSafeText(gid.value, 64) &&
        net.isIP(gid.value) === 6 &&
        gid.value !== "::" &&
        isSafeText(gid.ipv4Address, 15) &&
        net.isIP(gid.ipv4Address) === 4,
    )
  );
}

function validContainer(value: unknown): value is DualSparkObservedContainer {
  if (
    !isRecord(value) ||
    !isSafeText(value.id, 64) ||
    !SHA256_PATTERN.test(value.id) ||
    !isSafeText(value.name, 256) ||
    !isSafeText(value.image, 1024) ||
    typeof value.running !== "boolean" ||
    typeof value.healthy !== "boolean" ||
    !isRecord(value.labels) ||
    Object.keys(value.labels).length > 128
  ) {
    return false;
  }
  return Object.entries(value.labels).every(
    ([key, label]) =>
      key.length > 0 && key.length <= 256 && typeof label === "string" && label.length <= 4096,
  );
}

export function parseDualSparkHostObservation(value: unknown): DualSparkHostObservation {
  if (
    !isRecord(value) ||
    value.schemaVersion !== HOST_PROBE_SCHEMA_VERSION ||
    !isSafeText(value.hostname, 256) ||
    !isSafeText(value.nodeId, 64) ||
    !MACHINE_ID_PATTERN.test(value.nodeId) ||
    !isSafeText(value.productName, 512) ||
    !isSafeText(value.architecture, 64) ||
    !isSafeText(value.home) ||
    !path.isAbsolute(value.home) ||
    !isSafeText(value.username, 64) ||
    !SAFE_USERNAME_PATTERN.test(value.username) ||
    !isSafeInteger(value.uid, 1, 2 ** 31 - 1) ||
    !isSafeInteger(value.gid, 0, 2 ** 31 - 1) ||
    !Array.isArray(value.gpus) ||
    value.gpus.length > 16 ||
    !value.gpus.every(validGpu) ||
    !Array.isArray(value.rails) ||
    value.rails.length > 16 ||
    !value.rails.every(validRail) ||
    !isRecord(value.earlyoom) ||
    typeof value.earlyoom.installed !== "boolean" ||
    !["active", "inactive", "unknown"].includes(String(value.earlyoom.active)) ||
    !["enabled", "disabled", "unknown"].includes(String(value.earlyoom.enabled)) ||
    typeof value.runtimeInspectionComplete !== "boolean" ||
    !isRecord(value.runtimeSnapshot) ||
    !Array.isArray(value.runtimeSnapshot.containers) ||
    value.runtimeSnapshot.containers.length > 256 ||
    !value.runtimeSnapshot.containers.every(validContainer) ||
    !Array.isArray(value.runtimeSnapshot.listeningPorts) ||
    value.runtimeSnapshot.listeningPorts.length > 65_535 ||
    !value.runtimeSnapshot.listeningPorts.every((port) => isSafeInteger(port, 1, 65_535)) ||
    new Set(value.runtimeSnapshot.listeningPorts).size !==
      value.runtimeSnapshot.listeningPorts.length ||
    new Set(value.runtimeSnapshot.containers.map((container) => container.id)).size !==
      value.runtimeSnapshot.containers.length ||
    !isRecord(value.storage) ||
    !isRecord(value.storage.huggingFace) ||
    !validStorageCapacity(value.storage.huggingFace) ||
    !isSafeText(value.storage.huggingFace.cacheRoot) ||
    !path.isAbsolute(value.storage.huggingFace.cacheRoot) ||
    !isRecord(value.storage.docker) ||
    !validStorageCapacity(value.storage.docker) ||
    (value.storage.docker.dockerRootDir !== null &&
      (!isSafeText(value.storage.docker.dockerRootDir) ||
        !path.isAbsolute(value.storage.docker.dockerRootDir)))
  ) {
    throw new Error("DGX Spark host observation is invalid");
  }
  return value as unknown as DualSparkHostObservation;
}
function qualifyHost(
  host: DualSparkHostObservation,
  label: string,
): QualifiedHost | DiscoveryFailure {
  if (
    !/DGX[_\s-]+Spark/i.test(host.productName) ||
    !/^(?:aarch64|arm64)$/i.test(host.architecture)
  ) {
    return { code: "host-unqualified", reason: `${label} is not an arm64 DGX Spark.` };
  }
  const gpus = host.gpus.filter(({ name }) => /\bGB10\b/i.test(name));
  if (gpus.length !== 1 || host.gpus.length !== 1) {
    return { code: "host-unqualified", reason: `${label} must expose exactly one GB10 GPU.` };
  }
  const cx7 = host.rails.filter(({ pciName }) => /ConnectX[- ]?7|\bCX-?7\b/i.test(pciName));
  if (cx7.length !== 2 || host.rails.length !== 2) {
    return {
      code: "fabric-unavailable",
      reason: `${label} must expose exactly two ConnectX-7 logical rails.`,
    };
  }
  const qualified: QualifiedRail[] = [];
  for (const [index, rail] of cx7.entries()) {
    if (
      !/\bACTIVE\b/i.test(rail.state) ||
      rail.operState.toLowerCase() !== "up" ||
      !rail.carrier ||
      rail.linkLayer.toLowerCase() !== "ethernet" ||
      rail.speedMbps !== EXPECTED_CX7_SPEED_MBPS ||
      rail.mtu < MINIMUM_CX7_MTU
    ) {
      return {
        code: "fabric-unavailable",
        reason: `${label} rail ${String(index + 1)} is not active 200G Ethernet with jumbo MTU.`,
      };
    }
    const addresses = rail.ipv4Addresses
      .map((address) => ({
        address,
        peer: slash30Counterpart(address.address, address.prefixLength),
      }))
      .filter(
        (entry): entry is { address: DualSparkIpv4Observation; peer: string } =>
          entry.peer !== null,
      );
    if (addresses.length !== 1) {
      return {
        code: "fabric-unavailable",
        reason: `${label} rail ${String(index + 1)} must have one usable private /30 address.`,
      };
    }
    const selectedAddress = addresses[0]!;
    const gids = rail.roceV2Ipv4Gids
      .filter(({ ipv4Address }) => ipv4Address === selectedAddress.address.address)
      .sort((left, right) => left.index - right.index || compareStrings(left.value, right.value));
    if (gids.length === 0) {
      return {
        code: "fabric-unavailable",
        reason: `${label} rail ${String(index + 1)} has no usable dynamically resolved RoCEv2 GID.`,
      };
    }
    qualified.push({
      host: rail,
      address: selectedAddress.address.address,
      peerAddress: selectedAddress.peer,
      subnet: slash30Subnet(selectedAddress.address.address),
      gid: gids[0]!,
    });
  }
  if (
    new Set(qualified.map(({ host: rail }) => rail.netdev)).size !== 2 ||
    new Set(qualified.map(({ host: rail }) => rail.macAddress)).size !== 2 ||
    new Set(qualified.map(({ subnet }) => subnet)).size !== 2 ||
    new Set(qualified.map(({ peerAddress }) => peerAddress)).size !== 2
  ) {
    return { code: "fabric-unavailable", reason: `${label} ConnectX-7 identity is ambiguous.` };
  }
  qualified.sort((left, right) => compareStrings(left.subnet, right.subnet));
  return { host, gpu: gpus[0]!, rails: [qualified[0]!, qualified[1]!] };
}

function runtimeFailure(host: DualSparkHostObservation, label: string): DiscoveryFailure | null {
  if (!host.runtimeInspectionComplete) {
    return { code: "runtime-unknown", reason: `${label} runtime inspection is inconclusive.` };
  }
  const container = host.runtimeSnapshot.containers.find(isRelatedManagedVllmContainer);
  if (container) {
    return {
      code: "runtime-conflict",
      reason: `${label} already has related container ${container.name}; it was not changed.`,
    };
  }
  const port = host.runtimeSnapshot.listeningPorts.find(
    (entry) => entry === DUAL_SPARK_VLLM_MASTER_PORT,
  );
  return port === undefined
    ? null
    : {
        code: "runtime-conflict",
        reason: `${label} port ${String(port)} is already in use; its listener was not changed.`,
      };
}

function earlyoomFailure(host: DualSparkHostObservation, label: string): DiscoveryFailure | null {
  if (!host.earlyoom.installed) return null;
  if (host.earlyoom.active === "active") {
    return {
      code: "earlyoom-active",
      reason: `${label} has active earlyoom; NemoClaw did not stop or disable it.`,
    };
  }
  return host.earlyoom.active === "inactive"
    ? null
    : { code: "earlyoom-unknown", reason: `${label} earlyoom state is inconclusive.` };
}

function validCapacity(capacity: DualSparkStorageCapacityObservation): boolean {
  return (
    capacity.probePath !== null &&
    capacity.filesystemId !== null &&
    capacity.availableBytes !== null &&
    capacity.availableInodes !== null &&
    capacity.availableInodes >= MINIMUM_AVAILABLE_INODES &&
    capacity.ownerUid !== null &&
    capacity.ownerGid !== null &&
    capacity.isDirectory
  );
}

function storageFailure(host: DualSparkHostObservation, label: string): DiscoveryFailure | null {
  const huggingFace = host.storage.huggingFace;
  const docker = host.storage.docker;
  if (!validCapacity(huggingFace) || !validCapacity(docker)) {
    return {
      code: "storage-unavailable",
      reason: `${label} cache or Docker filesystem capacity could not be proven.`,
    };
  }
  if (!huggingFace.writableByUser) {
    return {
      code: "storage-unavailable",
      reason: `${label} Hugging Face cache is not writable by the probed non-root user.`,
    };
  }
  if (
    huggingFace.probePath !== huggingFace.cacheRoot ||
    huggingFace.requestedPath !== huggingFace.cacheRoot ||
    !huggingFace.isDirectory
  ) {
    return {
      code: "storage-unavailable",
      reason: `${label} exact Hugging Face cache root must already exist as a directory.`,
    };
  }
  if (huggingFace.ownerUid !== host.uid || huggingFace.ownerGid !== host.gid) {
    return {
      code: "storage-unavailable",
      reason: `${label} Hugging Face cache ownership does not match the probed non-root user.`,
    };
  }

  return null;
}

function pairHosts(local: QualifiedHost, peer: QualifiedHost): PairPlan | DiscoveryFailure {
  if (local.host.nodeId === peer.host.nodeId || local.gpu.uuid === peer.gpu.uuid) {
    return {
      code: "peer-identity-ambiguous",
      reason: "The peer resolves back to the local DGX Spark.",
    };
  }
  const matches = local.rails.map((localRail) => {
    const peers = peer.rails.filter(
      (peerRail) =>
        peerRail.subnet === localRail.subnet &&
        peerRail.address === localRail.peerAddress &&
        peerRail.peerAddress === localRail.address,
    );
    return peers.length === 1 ? { local: localRail, peer: peers[0]! } : null;
  });
  if (matches.some((match) => match === null)) {
    return {
      code: "fabric-unavailable",
      reason: "The peer rails are not exact reciprocal /30 endpoints.",
    };
  }
  const exact = matches as Array<{ local: QualifiedRail; peer: QualifiedRail }>;
  return {
    local,
    peer,
    localConnectivity: exact.map(({ local: localRail, peer: peerRail }) => ({
      netdev: localRail.host.netdev,
      sourceAddress: localRail.address,
      peerAddress: peerRail.address,
      expectedPeerMac: peerRail.host.macAddress,
    })) as [DualSparkConnectivityRequest, DualSparkConnectivityRequest],
    peerConnectivity: exact.map(({ local: localRail, peer: peerRail }) => ({
      netdev: peerRail.host.netdev,
      sourceAddress: peerRail.address,
      peerAddress: localRail.address,
      expectedPeerMac: localRail.host.macAddress,
    })) as [DualSparkConnectivityRequest, DualSparkConnectivityRequest],
  };
}

function topologyRail(rail: QualifiedRail, peerNodeId: string): DualSparkRailObservation {
  return {
    adapter: "connectx-7",
    path: "direct",
    physicalPortId: rail.host.physicalPortId,
    netdev: rail.host.netdev,
    hcaDevice: rail.host.hcaDevice,
    hcaPort: rail.host.hcaPort,
    address: rail.address,
    prefixLength: DIRECT_RAIL_PREFIX_LENGTH,
    peerNodeId,
    peerAddress: rail.peerAddress,
    linkState: "up",
    connectivity: "reachable",
    roceGid: { state: "resolved", index: rail.gid.index, value: rail.gid.value },
  };
}

function topologyObservations(
  pair: PairPlan,
  localReadiness: SystemReadinessReport,
  peerReadiness: SystemReadinessReport,
  identity: QualifiedStationSshIdentity,
  bindingHandle: string,
): { local: DualSparkNodeObservation; peer: DualSparkPeerObservation } {
  return {
    local: {
      nodeId: pair.local.host.nodeId,
      gpuIds: [pair.local.gpu.uuid],
      readiness: localReadiness,
      runtimeState: "clear",
      rails: pair.local.rails.map((rail) => topologyRail(rail, pair.peer.host.nodeId)),
    },
    peer: {
      nodeId: pair.peer.host.nodeId,
      gpuIds: [pair.peer.gpu.uuid],
      readiness: peerReadiness,
      runtimeState: "clear",
      rails: pair.peer.rails.map((rail) => topologyRail(rail, pair.local.host.nodeId)),
      sshBinding: {
        state: "pretrusted",
        fromNodeId: pair.local.host.nodeId,
        toNodeId: pair.peer.host.nodeId,
        peerTarget: identity.sshTarget,
        handle: bindingHandle,
      },
    },
  };
}

function hostPolicyFailure(host: DualSparkHostObservation, label: string): DiscoveryFailure | null {
  return earlyoomFailure(host, label) ?? runtimeFailure(host, label) ?? storageFailure(host, label);
}

function samePhysicalSshIdentity(
  left: QualifiedStationSshIdentity,
  right: QualifiedStationSshIdentity,
): boolean {
  return (
    left.sshUser === right.sshUser &&
    left.port === right.port &&
    left.hostKeyDigest === right.hostKeyDigest
  );
}

function sameExactSshIdentity(
  left: QualifiedStationSshIdentity,
  right: QualifiedStationSshIdentity,
): boolean {
  return (
    left.requestedTarget === right.requestedTarget &&
    left.sshTarget === right.sshTarget &&
    left.resolvedHost === right.resolvedHost &&
    left.sshUser === right.sshUser &&
    left.port === right.port &&
    left.lookupHost === right.lookupHost &&
    left.hostKeyDigest === right.hostKeyDigest &&
    left.knownHostsLines.length === right.knownHostsLines.length &&
    left.knownHostsLines.every((line, index) => line === right.knownHostsLines[index])
  );
}

function samePhysicalHost(
  left: DualSparkHostObservation,
  right: DualSparkHostObservation,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.gpus.length === 1 &&
    right.gpus.length === 1 &&
    left.gpus[0]?.uuid === right.gpus[0]?.uuid
  );
}

function topologyFailureReason(result: ReturnType<typeof qualifyDualSparkTopology>): string {
  return result.outcome === "qualified" ? "" : result.message;
}

function sameDetectedPair(
  detected: DualSparkDetectedManagedServingCapability,
  revalidated: DualSparkDetectedManagedServingCapability,
): boolean {
  return (
    detected.selectionIntent === revalidated.selectionIntent &&
    detected.peerSshBindingStatePath === revalidated.peerSshBindingStatePath &&
    sameExactSshIdentity(detected.peerSshIdentity, revalidated.peerSshIdentity) &&
    detected.local.nodeId === revalidated.local.nodeId &&
    detected.local.hostname === revalidated.local.hostname &&
    detected.local.username === revalidated.local.username &&
    detected.local.uid === revalidated.local.uid &&
    detected.local.gid === revalidated.local.gid &&
    detected.local.home === revalidated.local.home &&
    detected.local.gpus[0]?.uuid === revalidated.local.gpus[0]?.uuid &&
    detected.local.storage.huggingFace.cacheRoot ===
      revalidated.local.storage.huggingFace.cacheRoot &&
    detected.peer.nodeId === revalidated.peer.nodeId &&
    detected.peer.hostname === revalidated.peer.hostname &&
    detected.peer.username === revalidated.peer.username &&
    detected.peer.uid === revalidated.peer.uid &&
    detected.peer.gid === revalidated.peer.gid &&
    detected.peer.home === revalidated.peer.home &&
    detected.peer.gpus[0]?.uuid === revalidated.peer.gpus[0]?.uuid &&
    detected.peer.storage.huggingFace.cacheRoot ===
      revalidated.peer.storage.huggingFace.cacheRoot &&
    detected.topology.subjectDigest === revalidated.topology.subjectDigest &&
    detected.topology.outputDigest === revalidated.topology.outputDigest
  );
}

function topologyWithBinding(
  detected: DualSparkDetectedManagedServingCapability,
  peerSshBindingHandle: string,
): DualSparkTopologyArtifact {
  const output: DualSparkTopologyOutput = {
    ...detected.topology.output,
    peer: {
      ...detected.topology.output.peer,
      sshBindingHandle: peerSshBindingHandle,
    },
  };
  const artifact = immutableManagedInferenceCopy<DualSparkTopologyArtifact>({
    ...detected.topology,
    output,
    outputDigest: dualSparkTopologyOutputDigest(output),
  });
  const error = getDualSparkTopologyArtifactError(artifact);
  if (error) throw new Error(error);
  return artifact;
}

function confirmationUnavailable(
  code: DualSparkManagedServingFailureCode,
  reason: string,
): DualSparkManagedServingConfirmation {
  return { kind: "unavailable", code, reason };
}

export function probeDualSparkManagedServingCapability(
  options: ProbeDualSparkManagedServingOptions = {},
): DualSparkManagedServingCapability {
  const selection = selectionFromEnvironment(
    options.env ?? process.env,
    options.loadCatalog ?? loadManagedInferenceCatalog,
  );
  if (!("strict" in selection)) return selection;
  const deps = options.deps ?? defaultDualSparkDiscoveryDeps;
  const opened: DualSparkPinnedPeerTransport[] = [];
  let local: DualSparkHostObservation;
  let qualifiedLocal: QualifiedHost;
  let localTransport: DualSparkReadOnlyHostTransport;
  try {
    localTransport = deps.localTransport();
    local = deps.probeHost(localTransport);
    const effectiveUid = deps.currentUid();
    if (effectiveUid === null || effectiveUid !== local.uid) {
      return disposition(selection, {
        code: "host-unqualified",
        reason: "The local DGX Spark probe does not match the current non-root controller UID.",
      });
    }
    const candidate = qualifyHost(local, "Local DGX Spark");
    if ("code" in candidate) return disposition(selection, candidate);
    qualifiedLocal = candidate;
    const policyFailure = hostPolicyFailure(local, "Local DGX Spark");
    if (policyFailure) return disposition(selection, policyFailure);
  } catch {
    return disposition(selection, {
      code: "local-host-unavailable",
      reason: "The local DGX Spark read-only probe failed closed.",
    });
  }

  try {
    let selectedIdentity: QualifiedStationSshIdentity;
    let selectedTransport: DualSparkReadOnlyHostTransport;
    let peer: DualSparkHostObservation;
    if (selection.explicitPeer) {
      const identity = deps.inspectPretrustedTarget(selection.explicitPeer);
      if (!identity) {
        return disposition(selection, {
          code: "peer-trust-unavailable",
          reason: "The explicit DGX Spark peer lacks usable pre-existing SSH trust.",
        });
      }
      const pinned = deps.openPinnedPeerTransport(identity);
      opened.push(pinned);
      selectedIdentity = identity;
      selectedTransport = pinned.transport;
      peer = deps.probeHost(selectedTransport);
    } else {
      const targets = qualifiedLocal.rails.map(({ peerAddress }) => peerAddress);
      const identities = targets.map((target) => deps.inspectPretrustedTarget(target));
      if (identities.some((identity) => identity === null)) {
        return disposition(selection, {
          code: "peer-trust-unavailable",
          reason: "Both derived /30 peer addresses require pre-existing SSH host-key trust.",
        });
      }
      const trusted = identities as QualifiedStationSshIdentity[];
      if (!samePhysicalSshIdentity(trusted[0]!, trusted[1]!)) {
        return disposition(selection, {
          code: "peer-identity-ambiguous",
          reason: "The two derived rail addresses map to different SSH identities.",
        });
      }
      const probes = trusted.map((identity) => {
        const pinned = deps.openPinnedPeerTransport(identity);
        opened.push(pinned);
        return { identity, pinned, host: deps.probeHost(pinned.transport) };
      });
      if (!samePhysicalHost(probes[0]!.host, probes[1]!.host)) {
        return disposition(selection, {
          code: "peer-identity-ambiguous",
          reason: "The two derived rail addresses do not resolve to one physical DGX Spark.",
        });
      }
      probes.sort((left, right) =>
        compareStrings(left.identity.requestedTarget, right.identity.requestedTarget),
      );
      selectedIdentity = probes[0]!.identity;
      selectedTransport = probes[0]!.pinned.transport;
      peer = probes[0]!.host;
    }

    const qualifiedPeer = qualifyHost(peer, "Peer DGX Spark");
    if ("code" in qualifiedPeer) return disposition(selection, qualifiedPeer);
    if (peer.username !== selectedIdentity.sshUser || peer.uid <= 0) {
      return disposition(selection, {
        code: "peer-identity-ambiguous",
        reason: "The peer SSH user does not own the probed non-root cache identity.",
      });
    }
    const peerPolicyFailure = hostPolicyFailure(peer, "Peer DGX Spark");
    if (peerPolicyFailure) return disposition(selection, peerPolicyFailure);
    const pair = pairHosts(qualifiedLocal, qualifiedPeer);
    if ("code" in pair) return disposition(selection, pair);
    if (
      !deps.probeConnectivity(localTransport, pair.localConnectivity) ||
      !deps.probeConnectivity(selectedTransport, pair.peerConnectivity)
    ) {
      return disposition(selection, {
        code: "connectivity-unavailable",
        reason: "Direct route, neighbor, or jumbo connectivity failed on a DGX Spark rail.",
      });
    }

    const now = deps.now();
    const buildIdentity = deps.getBuildIdentity();
    let localReadiness: SystemReadinessReport;
    let peerReadiness: SystemReadinessReport;
    try {
      localReadiness = deps.createReadiness(local, localTransport, buildIdentity, now);
      peerReadiness = deps.createReadiness(peer, selectedTransport, buildIdentity, now);
    } catch {
      return disposition(selection, {
        code: "readiness-unavailable",
        reason: "Canonical readiness could not be generated for both DGX Spark nodes.",
      });
    }
    const temporary = topologyObservations(
      pair,
      localReadiness,
      peerReadiness,
      selectedIdentity,
      `pretrusted:${selectedIdentity.hostKeyDigest}`,
    );
    const temporaryQualification = qualifyDualSparkTopology({
      intent: selection.intent,
      evaluatedAt: now.toISOString(),
      maxReadinessAgeMs: options.maxReadinessAgeMs ?? 60_000,
      local: temporary.local,
      peers: [temporary.peer],
    });
    if (temporaryQualification.outcome !== "qualified") {
      return disposition(selection, {
        code: "topology-unavailable",
        reason: topologyFailureReason(temporaryQualification),
      });
    }

    const statePath = options.bindingStatePath ?? deps.resolveBindingStatePath();
    return {
      kind: "ready",
      selectionIntent: selection.intent,
      topology: temporaryQualification.artifact,
      local,
      peer,
      readiness: [
        { nodeId: local.nodeId, report: localReadiness },
        { nodeId: peer.nodeId, report: peerReadiness },
      ],
      peerSshBindingStatePath: statePath,
      peerSshIdentity: selectedIdentity,
    };
  } catch {
    return disposition(selection, {
      code: "peer-host-unavailable",
      reason: "The peer DGX Spark read-only probe failed closed.",
    });
  } finally {
    for (const pinned of opened.reverse()) {
      try {
        pinned.close();
      } catch {
        // The pinned temporary directory contains public host-key material only.
      }
    }
  }
}

/** Revalidate the detected pair without claiming or writing its SSH binding. */
export function revalidateDualSparkManagedServingCapability(
  detected: DualSparkDetectedManagedServingCapability,
  options: ProbeDualSparkManagedServingOptions = {},
): DualSparkManagedServingCapability {
  const deps = options.deps ?? defaultDualSparkDiscoveryDeps;
  const revalidated = probeDualSparkManagedServingCapability({
    ...options,
    deps,
    bindingStatePath: detected.peerSshBindingStatePath,
  });
  if (revalidated.kind !== "ready") {
    return confirmationUnavailable(
      revalidated.code,
      `The confirmed DGX Spark pair no longer qualifies: ${revalidated.reason}`,
    );
  }
  if (!sameDetectedPair(detected, revalidated)) {
    return confirmationUnavailable(
      "peer-identity-ambiguous",
      "The confirmed DGX Spark pair or its exact pretrusted SSH identity changed after selection.",
    );
  }
  return revalidated;
}

/** Atomically claim and persist a previously revalidated pair's SSH binding. */
export function claimDualSparkManagedServingCapability(
  revalidated: DualSparkDetectedManagedServingCapability,
  options: Pick<ProbeDualSparkManagedServingOptions, "deps"> = {},
): DualSparkManagedServingConfirmation {
  const deps = options.deps ?? defaultDualSparkDiscoveryDeps;
  const statePath = revalidated.peerSshBindingStatePath;
  if (!deps.claimBinding(statePath)) {
    return confirmationUnavailable(
      "binding-conflict",
      "An existing DGX Spark SSH binding was preserved and not replaced.",
    );
  }
  try {
    const peerSshBinding = deps.writeBinding(statePath, revalidated.peerSshIdentity);
    const peerSshBindingHandle = deps.encodeBinding(peerSshBinding);
    return {
      ...revalidated,
      topology: topologyWithBinding(revalidated, peerSshBindingHandle),
      peerSshBinding,
      peerSshBindingHandle,
    };
  } catch {
    try {
      deps.clearBinding(statePath);
    } catch {
      return confirmationUnavailable(
        "binding-persistence-failed",
        "The DGX Spark SSH binding failed and its new state could not be cleaned safely.",
      );
    }
    return confirmationUnavailable(
      "binding-persistence-failed",
      "The confirmed DGX Spark SSH binding could not be persisted.",
    );
  }
}

/** Revalidate the detected pair, then claim and persist its SSH binding after confirmation. */
export function confirmDualSparkManagedServingCapability(
  detected: DualSparkDetectedManagedServingCapability,
  options: ProbeDualSparkManagedServingOptions = {},
): DualSparkManagedServingConfirmation {
  const revalidated = revalidateDualSparkManagedServingCapability(detected, options);
  return revalidated.kind === "ready"
    ? claimDualSparkManagedServingCapability(revalidated, options)
    : revalidated;
}

export type { DualSparkSpawnSync } from "./dual-spark-discovery-production.js";

export function createDualSparkDiscoveryDeps(
  spawn?: import("./dual-spark-discovery-production.js").DualSparkSpawnSync,
): DualSparkDiscoveryDeps {
  return createProductionDualSparkDiscoveryDeps(parseDualSparkHostObservation, spawn);
}

const defaultDualSparkDiscoveryDeps = createDualSparkDiscoveryDeps();
