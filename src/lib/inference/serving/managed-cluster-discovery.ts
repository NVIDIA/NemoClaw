// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import path from "node:path";

import type { BuildIdentity } from "../../core/version.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import { MANAGED_CLUSTER_VLLM_MATERIALIZER_REF } from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import { immutableManagedInferenceCopy } from "./catalog-integrity.js";
import { createProductionManagedClusterDiscoveryDeps } from "./managed-cluster-discovery-production.js";
import {
  isRelatedManagedVllmContainer,
  type ManagedClusterNodeSnapshot,
  type ManagedClusterObservedContainer,
} from "./managed-cluster-lifecycle.js";
import {
  type ManagedVllmSshBinding,
  type QualifiedManagedVllmSshIdentity,
} from "./managed-cluster-ssh-binding.js";
import {
  getManagedClusterTopologyArtifactError,
  type ManagedClusterNodeObservation,
  type ManagedClusterPeerObservation,
  type ManagedClusterRailObservation,
  type ManagedClusterTopologyArtifact,
  type ManagedClusterTopologyOutput,
  managedClusterTopologyOutputDigest,
  qualifyManagedClusterTopology,
} from "./managed-cluster-topology.js";

export const NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV = "NEMOCLAW_MANAGED_CLUSTER_PEERS" as const;
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

export interface ManagedClusterCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface ManagedClusterReadOnlyHostTransport {
  execute(argv: readonly string[]): ManagedClusterCommandResult;
  readFile(filePath: string): string;
  readdir(directory: string): string[];
}

export interface ManagedClusterGpuObservation {
  readonly index: number;
  readonly name: string;
  readonly uuid: string;
}

export interface ManagedClusterIpv4Observation {
  readonly address: string;
  readonly prefixLength: number;
}

export interface ManagedClusterRoceGidHostObservation {
  readonly index: number;
  readonly value: string;
  readonly ipv4Address: string;
}

export interface ManagedClusterCx7RailHostObservation {
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
  readonly ipv4Addresses: readonly ManagedClusterIpv4Observation[];
  readonly roceV2Ipv4Gids: readonly ManagedClusterRoceGidHostObservation[];
}

export interface ManagedClusterEarlyoomObservation {
  readonly installed: boolean;
  readonly active: "active" | "inactive" | "unknown";
  readonly enabled: "enabled" | "disabled" | "unknown";
}

export interface ManagedClusterStorageCapacityObservation {
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

export interface ManagedClusterStorageObservation {
  readonly huggingFace: ManagedClusterStorageCapacityObservation & {
    readonly cacheRoot: string;
  };
  readonly docker: ManagedClusterStorageCapacityObservation & {
    readonly dockerRootDir: string | null;
  };
}

export interface ManagedClusterHostObservation {
  readonly schemaVersion: 1;
  readonly hostname: string;
  readonly nodeId: string;
  readonly productName: string;
  readonly architecture: string;
  readonly home: string;
  readonly username: string;
  readonly uid: number;
  readonly gid: number;
  readonly gpus: readonly ManagedClusterGpuObservation[];
  readonly rails: readonly ManagedClusterCx7RailHostObservation[];
  readonly earlyoom: ManagedClusterEarlyoomObservation;
  readonly runtimeInspectionComplete: boolean;
  readonly runtimeSnapshot: ManagedClusterNodeSnapshot;
  readonly storage: ManagedClusterStorageObservation;
}

export interface ManagedClusterPinnedPeerTransport {
  readonly transport: ManagedClusterReadOnlyHostTransport;
  close(): void;
}

export interface ManagedClusterConnectivityRequest {
  readonly netdev: string;
  readonly sourceAddress: string;
  readonly peerAddress: string;
  readonly expectedPeerMac: string;
}

/**
 * Which connectivity probe rejected the fabric. `rails` means the candidate rail
 * set itself was unusable, so no per-rail probe ran.
 */
export type ManagedClusterConnectivityFailure =
  | { readonly check: "rails" }
  | { readonly check: "route" | "jumbo" | "neighbor"; readonly netdev: string };

export interface ManagedClusterDiscoveryDeps {
  now(): Date;
  currentUid(): number | null;
  getBuildIdentity(): BuildIdentity;
  localTransport(): ManagedClusterReadOnlyHostTransport;
  probeHost(transport: ManagedClusterReadOnlyHostTransport): ManagedClusterHostObservation;
  inspectPretrustedTarget(target: string): QualifiedManagedVllmSshIdentity | null;
  openPinnedPeerTransport(
    identity: QualifiedManagedVllmSshIdentity,
  ): ManagedClusterPinnedPeerTransport;
  createReadiness(
    host: ManagedClusterHostObservation,
    transport: ManagedClusterReadOnlyHostTransport,
    buildIdentity: BuildIdentity,
    now: Date,
  ): SystemReadinessReport;
  /** Null means every rail passed every probe. */
  probeConnectivity(
    transport: ManagedClusterReadOnlyHostTransport,
    requests: readonly ManagedClusterConnectivityRequest[],
  ): ManagedClusterConnectivityFailure | null;
  /** Atomically claim a new binding root. False means an existing owner won. */
  claimBinding(statePath: string): boolean;
  writeBinding(statePath: string, identity: QualifiedManagedVllmSshIdentity): ManagedVllmSshBinding;
  clearBinding(statePath: string): void;
  encodeBinding(binding: ManagedVllmSshBinding): string;
  resolveBindingStatePath(nodeId: string): string;
}

export type ManagedClusterManagedServingFailureCode =
  | "no-match"
  | "incompatible-selection"
  | "invalid-peer"
  | "local-host-unavailable"
  | "peer-trust-unavailable"
  | "peer-identity-ambiguous"
  | "peer-host-unavailable"
  | "peer-count"
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

export type ManagedClusterDetectedManagedServingCapability = {
  readonly kind: "ready";
  readonly selectionIntent: "automatic" | "explicit";
  readonly topology: ManagedClusterTopologyArtifact;
  readonly local: ManagedClusterHostObservation;
  readonly peers: readonly ManagedClusterHostObservation[];
  readonly readiness: readonly {
    readonly nodeId: string;
    readonly report: SystemReadinessReport;
  }[];
  /** Exact transaction claims that may be persisted only after confirmation. */
  readonly sshClaims: readonly ManagedClusterSshClaim[];
};

export interface ManagedClusterSshClaim {
  readonly nodeId: string;
  readonly statePath: string;
  readonly identity: QualifiedManagedVllmSshIdentity;
}

export interface ManagedClusterSshBinding extends ManagedClusterSshClaim {
  readonly binding: ManagedVllmSshBinding;
  readonly handle: string;
}

export type ManagedClusterManagedServingCapability =
  | {
      readonly kind: "not-selected";
      readonly code: ManagedClusterManagedServingFailureCode;
      readonly reason: string;
    }
  | {
      readonly kind: "unavailable";
      readonly code: ManagedClusterManagedServingFailureCode;
      readonly reason: string;
    }
  | ManagedClusterDetectedManagedServingCapability;

export type ManagedClusterConfirmedManagedServingCapability =
  ManagedClusterDetectedManagedServingCapability & {
    readonly sshBindings: readonly ManagedClusterSshBinding[];
  };

export type ManagedClusterManagedServingConfirmation =
  | Exclude<ManagedClusterManagedServingCapability, { kind: "ready" }>
  | ManagedClusterConfirmedManagedServingCapability;

export interface ProbeManagedClusterManagedServingOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly deps?: ManagedClusterDiscoveryDeps;
  /** @internal Catalog loader seam for fail-closed tests. */
  readonly loadCatalog?: typeof loadManagedInferenceCatalog;
  readonly bindingStatePaths?: Readonly<Record<string, string>>;
  readonly maxReadinessAgeMs?: number;
}

interface QualifiedRail {
  readonly host: ManagedClusterCx7RailHostObservation;
  readonly address: string;
  readonly peerAddress: string;
  readonly subnet: string;
  readonly gid: ManagedClusterRoceGidHostObservation;
}

interface QualifiedHost {
  readonly host: ManagedClusterHostObservation;
  readonly gpu: ManagedClusterGpuObservation;
  readonly rails: readonly [QualifiedRail, QualifiedRail];
}

interface ClusterPlan {
  readonly nodes: readonly QualifiedHost[];
  readonly connectivity: ReadonlyMap<string, readonly ManagedClusterConnectivityRequest[]>;
  readonly peerNodeIdsByRail: ReadonlyMap<QualifiedRail, string>;
}

type DiscoveryFailure = {
  readonly code: ManagedClusterManagedServingFailureCode;
  readonly reason: string;
};

type Selection = {
  readonly strict: boolean;
  readonly intent: "automatic" | "explicit";
  readonly explicitPeers: readonly string[];
};

function notSelected(
  code: ManagedClusterManagedServingFailureCode,
  reason: string,
): ManagedClusterManagedServingCapability {
  return { kind: "not-selected", code, reason };
}

function unavailable(
  code: ManagedClusterManagedServingFailureCode,
  reason: string,
): ManagedClusterManagedServingCapability {
  return { kind: "unavailable", code, reason };
}

function disposition(
  selection: Selection,
  result: DiscoveryFailure,
): ManagedClusterManagedServingCapability {
  if (selection.strict) return unavailable(result.code, result.reason);
  const code: ManagedClusterManagedServingFailureCode = [
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
    throw new Error(
      `${NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV} must contain canonical SSH hosts or user@host values`,
    );
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
    throw new Error(
      `${NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV} must contain canonical SSH hosts or user@host values`,
    );
  }
  return raw;
}

function selectionFromEnvironment(
  env: NodeJS.ProcessEnv,
  loadCatalog: typeof loadManagedInferenceCatalog,
): Selection | ManagedClusterManagedServingCapability {
  const preset = String(env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
  const peersValue = String(env[NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV] ?? "").trim();
  let peers: readonly string[] = [];
  if (peersValue) {
    try {
      peers = peersValue.split(",").map((peer) => validatePeerTarget(peer.trim()));
      if (new Set(peers).size !== peers.length || peers.length > 1_023) {
        throw new Error(
          `${NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV} contains duplicate or too many peers`,
        );
      }
    } catch (error) {
      return unavailable("invalid-peer", (error as Error).message);
    }
  }
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
    const compiledPreset = catalog.presets.find(({ metadata }) => metadata.id === preset);
    const recipe = compiledPreset
      ? catalog.recipes.find(({ metadata }) => metadata.id === compiledPreset.spec.plan.recipeRef)
      : undefined;
    if (recipe?.spec.execution.materializerRef !== MANAGED_CLUSTER_VLLM_MATERIALIZER_REF) {
      return peers.length > 0
        ? unavailable(
            "incompatible-selection",
            `${NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV} cannot be combined with another serving preset.`,
          )
        : notSelected("no-match", "Another managed inference preset is selected.");
    }
  }
  if (peers.length > 0) {
    return { strict: true, intent: "explicit", explicitPeers: peers };
  }
  return {
    strict: Boolean(preset),
    intent: preset ? "explicit" : "automatic",
    explicitPeers: [],
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

function validStorageCapacity(value: unknown): value is ManagedClusterStorageCapacityObservation {
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

function validGpu(value: unknown): value is ManagedClusterGpuObservation {
  return (
    isRecord(value) &&
    isSafeInteger(value.index, 0, 1024) &&
    isSafeText(value.name, 256) &&
    isSafeText(value.uuid, 128) &&
    GPU_UUID_PATTERN.test(value.uuid)
  );
}

function validRail(value: unknown): value is ManagedClusterCx7RailHostObservation {
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

function validContainer(value: unknown): value is ManagedClusterObservedContainer {
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

export function parseManagedClusterHostObservation(value: unknown): ManagedClusterHostObservation {
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
  return value as unknown as ManagedClusterHostObservation;
}
function qualifyHost(
  host: ManagedClusterHostObservation,
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
  const observedPciAddresses = new Set(cx7.map(({ pciAddress }) => pciAddress.toLowerCase()));
  const normalizedCx7 =
    observedPciAddresses.size === 2 &&
    observedPciAddresses.has("0000:01:00.0") &&
    observedPciAddresses.has("0002:01:00.0")
      ? cx7.map((rail) => ({ ...rail, physicalPortId: "dgx-spark-qsfp-near-rj45" }))
      : cx7;
  for (const [index, rail] of normalizedCx7.entries()) {
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
        (entry): entry is { address: ManagedClusterIpv4Observation; peer: string } =>
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

function runtimeFailure(
  host: ManagedClusterHostObservation,
  label: string,
): DiscoveryFailure | null {
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
  return null;
}

function earlyoomFailure(
  host: ManagedClusterHostObservation,
  label: string,
): DiscoveryFailure | null {
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

function validCapacity(capacity: ManagedClusterStorageCapacityObservation): boolean {
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

function storageFailure(
  host: ManagedClusterHostObservation,
  label: string,
): DiscoveryFailure | null {
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

function matchClusterHosts(nodes: readonly QualifiedHost[]): ClusterPlan | DiscoveryFailure {
  if (
    nodes.length < 2 ||
    new Set(nodes.map(({ host }) => host.nodeId)).size !== nodes.length ||
    new Set(nodes.map(({ gpu }) => gpu.uuid)).size !== nodes.length
  ) {
    return {
      code: "peer-identity-ambiguous",
      reason: "Managed cluster nodes or GPU identities are duplicated.",
    };
  }
  const peerNodeIdsByRail = new Map<QualifiedRail, string>();
  const connectivity = new Map<string, ManagedClusterConnectivityRequest[]>();
  for (const node of nodes) {
    const requests: ManagedClusterConnectivityRequest[] = [];
    for (const rail of node.rails) {
      const matches = nodes.flatMap((candidate) =>
        candidate.host.nodeId === node.host.nodeId
          ? []
          : candidate.rails
              .filter(
                (candidateRail) =>
                  candidateRail.subnet === rail.subnet &&
                  candidateRail.address === rail.peerAddress &&
                  candidateRail.peerAddress === rail.address,
              )
              .map((candidateRail) => ({ candidate, candidateRail })),
      );
      if (matches.length !== 1) {
        return {
          code: "fabric-unavailable",
          reason: "Managed cluster rails are not unique reciprocal /30 endpoints.",
        };
      }
      const match = matches[0]!;
      peerNodeIdsByRail.set(rail, match.candidate.host.nodeId);
      requests.push({
        netdev: rail.host.netdev,
        sourceAddress: rail.address,
        peerAddress: match.candidateRail.address,
        expectedPeerMac: match.candidateRail.host.macAddress,
      });
    }
    connectivity.set(node.host.nodeId, requests);
  }
  return { nodes, connectivity, peerNodeIdsByRail };
}

function topologyRail(rail: QualifiedRail, peerNodeId: string): ManagedClusterRailObservation {
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
  cluster: ClusterPlan,
  readiness: ReadonlyMap<string, SystemReadinessReport>,
  identities: ReadonlyMap<string, QualifiedManagedVllmSshIdentity>,
  bindingHandles: ReadonlyMap<string, string>,
): { local: ManagedClusterNodeObservation; peers: readonly ManagedClusterPeerObservation[] } {
  const controller = cluster.nodes[0]!;
  const nodeObservation = (node: QualifiedHost): ManagedClusterNodeObservation => ({
    nodeId: node.host.nodeId,
    gpuIds: [node.gpu.uuid],
    readiness: readiness.get(node.host.nodeId)!,
    runtimeState: "clear",
    rails: node.rails.map((rail) => topologyRail(rail, cluster.peerNodeIdsByRail.get(rail)!)),
  });
  return {
    local: nodeObservation(controller),
    peers: cluster.nodes.slice(1).map((node) => {
      const identity = identities.get(node.host.nodeId)!;
      return {
        ...nodeObservation(node),
        sshBinding: {
          state: "pretrusted",
          fromNodeId: controller.host.nodeId,
          toNodeId: node.host.nodeId,
          peerTarget: identity.sshTarget,
          handle: bindingHandles.get(node.host.nodeId)!,
        },
      };
    }),
  };
}

function hostPolicyFailure(
  host: ManagedClusterHostObservation,
  label: string,
): DiscoveryFailure | null {
  return earlyoomFailure(host, label) ?? runtimeFailure(host, label) ?? storageFailure(host, label);
}

function samePhysicalSshIdentity(
  left: QualifiedManagedVllmSshIdentity,
  right: QualifiedManagedVllmSshIdentity,
): boolean {
  return (
    left.sshUser === right.sshUser &&
    left.port === right.port &&
    left.hostKeyDigest === right.hostKeyDigest
  );
}

function sameExactSshIdentity(
  left: QualifiedManagedVllmSshIdentity,
  right: QualifiedManagedVllmSshIdentity,
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
  left: ManagedClusterHostObservation,
  right: ManagedClusterHostObservation,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.gpus.length === 1 &&
    right.gpus.length === 1 &&
    left.gpus[0]?.uuid === right.gpus[0]?.uuid
  );
}

function topologyFailureReason(result: ReturnType<typeof qualifyManagedClusterTopology>): string {
  return result.outcome === "qualified" ? "" : result.message;
}

const CONNECTIVITY_CHECK_LABELS = {
  route: "route",
  jumbo: "jumbo-frame",
  neighbor: "neighbor",
} as const;

function connectivityFailureReason(
  hostname: string,
  failure: ManagedClusterConnectivityFailure,
): string {
  return failure.check === "rails"
    ? `Managed cluster connectivity needs exactly two direct ConnectX-7 rails on ${hostname}.`
    : `The ${CONNECTIVITY_CHECK_LABELS[failure.check]} check failed on ${hostname} rail ${failure.netdev}.`;
}

function sameHostIdentity(
  left: ManagedClusterHostObservation,
  right: ManagedClusterHostObservation,
): boolean {
  return (
    left.nodeId === right.nodeId &&
    left.hostname === right.hostname &&
    left.username === right.username &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.home === right.home &&
    left.gpus[0]?.uuid === right.gpus[0]?.uuid &&
    left.storage.huggingFace.cacheRoot === right.storage.huggingFace.cacheRoot
  );
}

function sameDetectedCluster(
  detected: ManagedClusterDetectedManagedServingCapability,
  revalidated: ManagedClusterDetectedManagedServingCapability,
): boolean {
  return (
    detected.selectionIntent === revalidated.selectionIntent &&
    sameHostIdentity(detected.local, revalidated.local) &&
    detected.peers.length === revalidated.peers.length &&
    detected.peers.every((peer, index) => sameHostIdentity(peer, revalidated.peers[index]!)) &&
    detected.sshClaims.length === revalidated.sshClaims.length &&
    detected.sshClaims.every((claim, index) => {
      const candidate = revalidated.sshClaims[index];
      return (
        candidate?.nodeId === claim.nodeId &&
        candidate.statePath === claim.statePath &&
        sameExactSshIdentity(claim.identity, candidate.identity)
      );
    }) &&
    detected.topology.subjectDigest === revalidated.topology.subjectDigest &&
    detected.topology.outputDigest === revalidated.topology.outputDigest
  );
}

function topologyWithBinding(
  detected: ManagedClusterDetectedManagedServingCapability,
  bindings: readonly ManagedClusterSshBinding[],
): ManagedClusterTopologyArtifact {
  const output: ManagedClusterTopologyOutput = {
    ...detected.topology.output,
    peers: detected.topology.output.peers.map((peer) => ({
      ...peer,
      sshBindingHandle:
        bindings.find(({ nodeId }) => nodeId === peer.nodeId)?.handle ?? peer.sshBindingHandle,
    })),
  };
  const artifact = immutableManagedInferenceCopy<ManagedClusterTopologyArtifact>({
    ...detected.topology,
    output,
    outputDigest: managedClusterTopologyOutputDigest(output),
  });
  const error = getManagedClusterTopologyArtifactError(artifact);
  if (error) throw new Error(error);
  return artifact;
}

function confirmationUnavailable(
  code: ManagedClusterManagedServingFailureCode,
  reason: string,
): ManagedClusterManagedServingConfirmation {
  return { kind: "unavailable", code, reason };
}

export function probeManagedClusterManagedServingCapability(
  options: ProbeManagedClusterManagedServingOptions = {},
): ManagedClusterManagedServingCapability {
  const selection = selectionFromEnvironment(
    options.env ?? process.env,
    options.loadCatalog ?? loadManagedInferenceCatalog,
  );
  if (!("strict" in selection)) return selection;
  const deps = options.deps ?? defaultManagedClusterDiscoveryDeps;
  const opened: ManagedClusterPinnedPeerTransport[] = [];
  let local: ManagedClusterHostObservation;
  let qualifiedLocal: QualifiedHost;
  let localTransport: ManagedClusterReadOnlyHostTransport;
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
    const targets =
      selection.explicitPeers.length > 0
        ? selection.explicitPeers
        : qualifiedLocal.rails.map(({ peerAddress }) => peerAddress);
    const probes = targets.map((target) => {
      const identity = deps.inspectPretrustedTarget(target);
      if (!identity) return null;
      const pinned = deps.openPinnedPeerTransport(identity);
      opened.push(pinned);
      return { identity, pinned, host: deps.probeHost(pinned.transport) };
    });
    if (probes.some((probe) => probe === null)) {
      return disposition(selection, {
        code: "peer-trust-unavailable",
        reason: "Every managed cluster peer requires usable pre-existing SSH host-key trust.",
      });
    }

    const unique = new Map<
      string,
      {
        identity: QualifiedManagedVllmSshIdentity;
        transport: ManagedClusterReadOnlyHostTransport;
        host: ManagedClusterHostObservation;
      }
    >();
    for (const probe of probes as Array<NonNullable<(typeof probes)[number]>>) {
      if (samePhysicalHost(local, probe.host)) {
        return disposition(selection, {
          code: "peer-identity-ambiguous",
          reason: "A managed cluster peer resolves back to the local DGX Spark.",
        });
      }
      const existing = unique.get(probe.host.nodeId);
      if (
        existing &&
        (!samePhysicalHost(existing.host, probe.host) ||
          !samePhysicalSshIdentity(existing.identity, probe.identity))
      ) {
        return disposition(selection, {
          code: "peer-identity-ambiguous",
          reason: "Multiple peer targets disagree about one physical DGX Spark identity.",
        });
      }
      if (
        !existing ||
        compareStrings(probe.identity.requestedTarget, existing.identity.requestedTarget) < 0
      ) {
        unique.set(probe.host.nodeId, {
          identity: probe.identity,
          transport: probe.pinned.transport,
          host: probe.host,
        });
      }
    }
    const selectedPeers = [...unique.values()].sort((left, right) =>
      compareStrings(left.host.nodeId, right.host.nodeId),
    );
    if (selectedPeers.length === 0) {
      return disposition(selection, {
        code: "peer-count",
        reason: "No distinct managed cluster peer was detected.",
      });
    }

    const qualifiedPeers: QualifiedHost[] = [];
    for (const [index, selected] of selectedPeers.entries()) {
      const label = `Managed cluster peer ${String(index + 1)}`;
      const qualifiedPeer = qualifyHost(selected.host, label);
      if ("code" in qualifiedPeer) return disposition(selection, qualifiedPeer);
      if (selected.host.username !== selected.identity.sshUser || selected.host.uid <= 0) {
        return disposition(selection, {
          code: "peer-identity-ambiguous",
          reason: `${label} SSH user does not own the probed non-root cache identity.`,
        });
      }
      const policyFailure = hostPolicyFailure(selected.host, label);
      if (policyFailure) return disposition(selection, policyFailure);
      qualifiedPeers.push(qualifiedPeer);
    }

    const cluster = matchClusterHosts([qualifiedLocal, ...qualifiedPeers]);
    if ("code" in cluster) return disposition(selection, cluster);
    const transportByNodeId = new Map<string, ManagedClusterReadOnlyHostTransport>([
      [local.nodeId, localTransport],
      ...selectedPeers.map(({ host, transport }) => [host.nodeId, transport] as const),
    ]);
    for (const node of cluster.nodes) {
      const connectivityFailure = deps.probeConnectivity(
        transportByNodeId.get(node.host.nodeId)!,
        cluster.connectivity.get(node.host.nodeId)!,
      );
      if (connectivityFailure) {
        return disposition(selection, {
          code: "connectivity-unavailable",
          reason: connectivityFailureReason(node.host.hostname, connectivityFailure),
        });
      }
    }

    const now = deps.now();
    const buildIdentity = deps.getBuildIdentity();
    const readiness = new Map<string, SystemReadinessReport>();
    try {
      for (const node of cluster.nodes) {
        readiness.set(
          node.host.nodeId,
          deps.createReadiness(
            node.host,
            transportByNodeId.get(node.host.nodeId)!,
            buildIdentity,
            now,
          ),
        );
      }
    } catch {
      return disposition(selection, {
        code: "readiness-unavailable",
        reason: "Canonical readiness could not be generated for every managed cluster node.",
      });
    }
    const identities = new Map(
      selectedPeers.map(({ host, identity }) => [host.nodeId, identity] as const),
    );
    const temporaryHandles = new Map(
      selectedPeers.map(
        ({ host, identity }) => [host.nodeId, `pretrusted:${identity.hostKeyDigest}`] as const,
      ),
    );
    const temporary = topologyObservations(cluster, readiness, identities, temporaryHandles);
    const temporaryQualification = qualifyManagedClusterTopology({
      intent: selection.intent,
      evaluatedAt: now.toISOString(),
      maxReadinessAgeMs: options.maxReadinessAgeMs ?? 60_000,
      local: temporary.local,
      peers: temporary.peers,
    });
    if (temporaryQualification.outcome !== "qualified") {
      return disposition(selection, {
        code: "topology-unavailable",
        reason: topologyFailureReason(temporaryQualification),
      });
    }

    const sshClaims = selectedPeers.map(({ host, identity }) => ({
      nodeId: host.nodeId,
      statePath:
        options.bindingStatePaths?.[host.nodeId] ?? deps.resolveBindingStatePath(host.nodeId),
      identity,
    }));
    return {
      kind: "ready",
      selectionIntent: selection.intent,
      topology: temporaryQualification.artifact,
      local,
      peers: selectedPeers.map(({ host }) => host),
      readiness: cluster.nodes.map(({ host }) => ({
        nodeId: host.nodeId,
        report: readiness.get(host.nodeId)!,
      })),
      sshClaims,
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

/** Revalidate the detected cluster without claiming or writing SSH bindings. */
export function revalidateManagedClusterManagedServingCapability(
  detected: ManagedClusterDetectedManagedServingCapability,
  options: ProbeManagedClusterManagedServingOptions = {},
): ManagedClusterManagedServingCapability {
  const deps = options.deps ?? defaultManagedClusterDiscoveryDeps;
  const revalidated = probeManagedClusterManagedServingCapability({
    ...options,
    deps,
    bindingStatePaths: Object.fromEntries(
      detected.sshClaims.map(({ nodeId, statePath }) => [nodeId, statePath]),
    ),
  });
  if (revalidated.kind !== "ready") {
    return confirmationUnavailable(
      revalidated.code,
      `The confirmed managed cluster no longer qualifies: ${revalidated.reason}`,
    );
  }
  if (!sameDetectedCluster(detected, revalidated)) {
    return confirmationUnavailable(
      "peer-identity-ambiguous",
      "The confirmed managed cluster or an exact pretrusted SSH identity changed after selection.",
    );
  }
  return revalidated;
}

/** Claim and persist every previously revalidated peer SSH binding. */
export function claimManagedClusterManagedServingCapability(
  revalidated: ManagedClusterDetectedManagedServingCapability,
  options: Pick<ProbeManagedClusterManagedServingOptions, "deps"> = {},
): ManagedClusterManagedServingConfirmation {
  const deps = options.deps ?? defaultManagedClusterDiscoveryDeps;
  const claimed: string[] = [];
  try {
    const sshBindings: ManagedClusterSshBinding[] = [];
    for (const claim of revalidated.sshClaims) {
      if (!deps.claimBinding(claim.statePath)) {
        throw new Error("binding-conflict");
      }
      claimed.push(claim.statePath);
      const binding = deps.writeBinding(claim.statePath, claim.identity);
      sshBindings.push({ ...claim, binding, handle: deps.encodeBinding(binding) });
    }
    return {
      ...revalidated,
      topology: topologyWithBinding(revalidated, sshBindings),
      sshBindings,
    };
  } catch (error) {
    let cleanupFailed = false;
    for (const statePath of claimed.reverse()) {
      try {
        deps.clearBinding(statePath);
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) {
      return confirmationUnavailable(
        "binding-persistence-failed",
        "A managed cluster SSH binding failed and newly claimed state could not be cleaned safely.",
      );
    }
    return confirmationUnavailable(
      (error as Error).message === "binding-conflict"
        ? "binding-conflict"
        : "binding-persistence-failed",
      (error as Error).message === "binding-conflict"
        ? "An existing managed cluster SSH binding was preserved and not replaced."
        : "The confirmed managed cluster SSH bindings could not be persisted.",
    );
  }
}

/** Revalidate the detected cluster, then persist its SSH bindings after confirmation. */
export function confirmManagedClusterManagedServingCapability(
  detected: ManagedClusterDetectedManagedServingCapability,
  options: ProbeManagedClusterManagedServingOptions = {},
): ManagedClusterManagedServingConfirmation {
  const revalidated = revalidateManagedClusterManagedServingCapability(detected, options);
  return revalidated.kind === "ready"
    ? claimManagedClusterManagedServingCapability(revalidated, options)
    : revalidated;
}

export type { ManagedClusterSpawnSync } from "./managed-cluster-discovery-production.js";

export function createManagedClusterDiscoveryDeps(
  spawn?: import("./managed-cluster-discovery-production.js").ManagedClusterSpawnSync,
): ManagedClusterDiscoveryDeps {
  return createProductionManagedClusterDiscoveryDeps(parseManagedClusterHostObservation, spawn);
}

const defaultManagedClusterDiscoveryDeps = createManagedClusterDiscoveryDeps();
