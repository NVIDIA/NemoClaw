// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import { isDgxStationGb300Product } from "../../src/lib/inference/dgx-station-identity.ts";
import { stationKnownHostsDigest } from "../../src/lib/inference/vllm-station-ssh-binding.ts";

export const DUAL_STATION_RESUME_SCHEMA_VERSION = 1;
export const STATION_PREP_REBOOT_REQUIRED_EXIT = 10;
export const STATION_PREP_LOGIN_REQUIRED_EXIT = 11;
export const STATION_PREP_EXISTING_VLLM_EXIT = 12;

const DIRECT_RAIL_PREFIX_LENGTH = 30;
const SAFE_TARGET_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SAFE_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const GPU_UUID_PATTERN = /^GPU-[A-Za-z0-9-]+$/;
const HOST_KEY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{16,86}={0,2}$/;
const MAC_PATTERN = /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const MAX_KNOWN_HOSTS_BYTES = 64 * 1024;
const MAX_KNOWN_HOSTS_LINE_BYTES = 16 * 1024;

export type StationPrepMode = "--check" | "--apply" | "--verify" | "--bind-controller";

export interface StationIpv4Address {
  address: string;
  prefixLength: number;
}

export interface StationDiscoveryRail {
  netdev: string;
  macAddress: string;
  pciAddress: string;
  pciName: string;
  state: string;
  linkLayer: string;
  speedMbps: number;
  mtu: number;
  ipv4Addresses: StationIpv4Address[];
}

export interface StationDiscoveryGpu {
  index: number;
  name: string;
  uuid: string;
}

export interface StationDiscoveryHost {
  schemaVersion: 1;
  hostname: string;
  productName: string;
  architecture: string;
  gpus: StationDiscoveryGpu[];
  rails: StationDiscoveryRail[];
}

export interface PretrustedSshTarget {
  requestedTarget: string;
  sshTarget: string;
  resolvedHost: string;
  sshUser: string;
  port: number;
  lookupHost: string;
  hostKeyDigest: string;
  keyFingerprints: string[];
  knownHostsLines: string[];
}

export interface RailConnectivityRequest {
  netdev: string;
  sourceAddress: string;
  peerAddress: string;
  expectedPeerMac: string;
}

export interface DualStationRailIdentity {
  localAddress: string;
  localMac: string;
  peerAddress: string;
  peerMac: string;
}

export interface DualStationPairIdentity {
  peerTarget: string;
  hostKeyDigest: string;
  localGpuUuid: string;
  peerGpuUuid: string;
  rails: DualStationRailIdentity[];
}

export interface DualStationResumeState extends DualStationPairIdentity {
  schemaVersion: 1;
  revision: string;
  helperSha256: string;
  phase: "remote-preparation" | "remote-reboot-required" | "ready";
}

export type DualStationPreparationResult =
  | { kind: "single-station"; reason: string }
  | {
      kind: "ready";
      peerTarget: string;
      identity: DualStationPairIdentity;
      binding: PretrustedSshTarget;
    }
  | {
      kind: "reboot-required";
      peerTarget: string;
      identity: DualStationPairIdentity;
      binding: PretrustedSshTarget;
    };

export interface DualStationPreparationOptions {
  revision: string;
  helperSha256: string;
  explicitPeer?: string;
  reuseExistingManagedPair?: boolean;
  migrateLegacySingleStationHead?: boolean;
}

export interface DualStationPreparationDeps {
  runLocalHelper(mode: StationPrepMode): number;
  probeLocalHost(): StationDiscoveryHost;
  inspectPretrustedTarget(target: string): PretrustedSshTarget | null;
  probePeerHost(target: PretrustedSshTarget): StationDiscoveryHost;
  probeLocalConnectivity(requests: readonly RailConnectivityRequest[]): boolean;
  probePeerConnectivity(
    target: PretrustedSshTarget,
    requests: readonly RailConnectivityRequest[],
  ): boolean;
  runRemoteHelper(target: PretrustedSshTarget, mode: StationPrepMode): number;
  readResumeState(): DualStationResumeState | null;
  writeResumeState(state: DualStationResumeState): void;
  clearResumeState(): void;
  log(message: string): void;
}

type QualifiedRail = {
  rail: StationDiscoveryRail;
  address: string;
  peerAddress: string;
  subnet: string;
};

type DiscoveryPlan = {
  identity: DualStationPairIdentity;
  localConnectivity: RailConnectivityRequest[];
  peerConnectivity: RailConnectivityRequest[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty printable string`);
  }
  return value;
}

function requireArray(value: unknown, label: string, maxLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new Error(`${label} must be an array with at most ${String(maxLength)} entries`);
  }
  return value;
}

function requireInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    throw new Error(`${label} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return value as number;
}

function normalizeMac(value: unknown, label: string): string {
  const mac = requireString(value, label, 17).toLowerCase();
  if (!MAC_PATTERN.test(mac) || mac === "00:00:00:00:00:00") {
    throw new Error(`${label} must be a nonzero canonical MAC address`);
  }
  const firstOctet = Number.parseInt(mac.slice(0, 2), 16);
  if ((firstOctet & 1) !== 0) throw new Error(`${label} must be a unicast MAC address`);
  return mac;
}

function requireIpv4(value: unknown, label: string): string {
  const address = requireString(value, label, 15);
  if (net.isIP(address) !== 4) throw new Error(`${label} must be IPv4`);
  return address;
}

function isSafeTargetHost(hostname: string): boolean {
  return (
    net.isIP(hostname) === 4 || (!/^[0-9.]+$/.test(hostname) && SAFE_TARGET_PATTERN.test(hostname))
  );
}

export function validateStationPeerTarget(raw: string): string {
  if (raw.length === 0 || raw !== raw.trim() || raw.length > 286) {
    throw new Error("Station peer must be one canonical SSH host or user@host");
  }
  if (/[/,:;`'"\\$(){}[\]<>|&!?*\s\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("Station peer must be one canonical SSH host or user@host");
  }
  const parts = raw.split("@");
  if (parts.length > 2) throw new Error("Station peer must be one canonical SSH host or user@host");
  const username = parts.length === 2 ? parts[0] : "";
  const hostname = parts.at(-1) ?? "";
  const validHost = isSafeTargetHost(hostname);
  if (
    !validHost ||
    (parts.length === 2 && username.length === 0) ||
    (username.length > 0 && !SAFE_USERNAME_PATTERN.test(username))
  ) {
    throw new Error("Station peer must be one canonical SSH host or user@host");
  }
  return raw;
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

function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return (
    (value >= ipv4ToNumber("10.0.0.0") && value <= ipv4ToNumber("10.255.255.255")) ||
    (value >= ipv4ToNumber("172.16.0.0") && value <= ipv4ToNumber("172.31.255.255")) ||
    (value >= ipv4ToNumber("192.168.0.0") && value <= ipv4ToNumber("192.168.255.255"))
  );
}

export function deriveSlash30Counterpart(address: string, prefixLength = 30): string | null {
  if (prefixLength !== DIRECT_RAIL_PREFIX_LENGTH || net.isIP(address) !== 4) return null;
  if (!isPrivateIpv4(address)) return null;
  const value = ipv4ToNumber(address);
  const network = Math.floor(value / 4) * 4;
  const host = value - network;
  if (host === 1) return numberToIpv4(network + 2);
  if (host === 2) return numberToIpv4(network + 1);
  return null;
}

function subnetOfSlash30(address: string): string {
  return `${numberToIpv4(Math.floor(ipv4ToNumber(address) / 4) * 4)}/30`;
}

export function parseStationDiscoveryHost(value: unknown): StationDiscoveryHost {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Station discovery probe schema is unsupported");
  }
  const gpus = requireArray(value.gpus, "Station discovery GPUs", 16).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Station discovery GPU ${String(index)} is invalid`);
    const uuid = requireString(entry.uuid, `Station discovery GPU ${String(index)} UUID`, 128);
    if (!GPU_UUID_PATTERN.test(uuid)) {
      throw new Error(`Station discovery GPU ${String(index)} UUID is invalid`);
    }
    return {
      index: requireInteger(entry.index, `Station discovery GPU ${String(index)} index`, 0, 1024),
      name: requireString(entry.name, `Station discovery GPU ${String(index)} name`, 256),
      uuid,
    };
  });
  const rails = requireArray(value.rails, "Station discovery rails", 16).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`Station discovery rail ${String(index)} is invalid`);
    const netdev = requireString(
      entry.netdev,
      `Station discovery rail ${String(index)} netdev`,
      64,
    );
    if (!SAFE_DEVICE_PATTERN.test(netdev)) {
      throw new Error(`Station discovery rail ${String(index)} netdev is unsafe`);
    }
    const pciAddress = requireString(
      entry.pciAddress,
      `Station discovery rail ${String(index)} PCI address`,
      32,
    );
    if (!/^[0-9A-Fa-f]{4}:[0-9A-Fa-f]{2}:[0-9A-Fa-f]{2}\.[0-7]$/.test(pciAddress)) {
      throw new Error(`Station discovery rail ${String(index)} PCI address is invalid`);
    }
    return {
      netdev,
      macAddress: normalizeMac(entry.macAddress, `Station discovery rail ${String(index)} MAC`),
      pciAddress,
      pciName: requireString(
        entry.pciName,
        `Station discovery rail ${String(index)} PCI name`,
        512,
      ),
      state: requireString(entry.state, `Station discovery rail ${String(index)} state`, 64),
      linkLayer: requireString(
        entry.linkLayer,
        `Station discovery rail ${String(index)} link layer`,
        64,
      ),
      speedMbps: requireInteger(
        entry.speedMbps,
        `Station discovery rail ${String(index)} speed`,
        -1,
        1_000_000,
      ),
      mtu: requireInteger(entry.mtu, `Station discovery rail ${String(index)} MTU`, -1, 1_000_000),
      ipv4Addresses: requireArray(
        entry.ipv4Addresses,
        `Station discovery rail ${String(index)} IPv4 addresses`,
        16,
      ).map((rawAddress, addressIndex) => {
        if (!isRecord(rawAddress)) {
          throw new Error(
            `Station discovery rail ${String(index)} address ${String(addressIndex)} is invalid`,
          );
        }
        return {
          address: requireIpv4(
            rawAddress.address,
            `Station discovery rail ${String(index)} address ${String(addressIndex)}`,
          ),
          prefixLength: requireInteger(
            rawAddress.prefixLength,
            `Station discovery rail ${String(index)} prefix ${String(addressIndex)}`,
            1,
            32,
          ),
        };
      }),
    };
  });
  return {
    schemaVersion: 1,
    hostname: requireString(value.hostname, "Station discovery hostname", 256),
    productName: requireString(value.productName, "Station discovery product", 512),
    architecture: requireString(value.architecture, "Station discovery architecture", 64),
    gpus,
    rails,
  };
}

function selectedGb300(host: StationDiscoveryHost, label: string): StationDiscoveryGpu {
  const matches = host.gpus.filter((gpu) => /\bGB300\b/i.test(gpu.name));
  if (matches.length !== 1) throw new Error(`${label} must expose exactly one GB300 GPU`);
  return matches[0];
}

function assertStationIdentity(host: StationDiscoveryHost, label: string): void {
  if (
    !isDgxStationGb300Product(host.productName) ||
    !/^(?:aarch64|arm64)$/i.test(host.architecture)
  ) {
    throw new Error(`${label} is not a verified arm64 DGX Station GB300`);
  }
}

function qualifyRails(host: StationDiscoveryHost, label: string): QualifiedRail[] {
  const cx8 = host.rails.filter((rail) => /ConnectX[- ]?8|\bCX-?8\b/i.test(rail.pciName));
  if (cx8.length !== 2) throw new Error(`${label} must expose exactly two CX-8 rails`);
  const result = cx8.map((rail, index): QualifiedRail => {
    if (
      !/\bACTIVE\b/i.test(rail.state) ||
      rail.linkLayer.toLowerCase() !== "ethernet" ||
      rail.speedMbps !== 400_000 ||
      rail.mtu !== 9000
    ) {
      throw new Error(`${label} rail ${String(index + 1)} is not active 400G Ethernet MTU 9000`);
    }
    const plausible = rail.ipv4Addresses
      .map((entry) => ({
        entry,
        peer: deriveSlash30Counterpart(entry.address, entry.prefixLength),
      }))
      .filter((entry): entry is { entry: StationIpv4Address; peer: string } => entry.peer !== null);
    if (plausible.length !== 1) {
      throw new Error(
        `${label} rail ${String(index + 1)} must have exactly one usable private /30 address`,
      );
    }
    return {
      rail,
      address: plausible[0].entry.address,
      peerAddress: plausible[0].peer,
      subnet: subnetOfSlash30(plausible[0].entry.address),
    };
  });
  if (
    new Set(result.map((entry) => entry.rail.netdev)).size !== 2 ||
    new Set(result.map((entry) => entry.rail.macAddress)).size !== 2 ||
    new Set(result.map((entry) => entry.rail.pciAddress)).size !== 2 ||
    new Set(result.map((entry) => entry.subnet)).size !== 2 ||
    new Set(result.map((entry) => entry.peerAddress)).size !== 2
  ) {
    throw new Error(`${label} CX-8 rail identity is ambiguous`);
  }
  return result.sort((left, right) => left.subnet.localeCompare(right.subnet));
}

export function deriveDiscoveryCandidates(host: StationDiscoveryHost): string[] {
  assertStationIdentity(host, "Local host");
  selectedGb300(host, "Local host");
  return qualifyRails(host, "Local host").map((entry) => entry.peerAddress);
}

function peerHostFromTarget(target: string): string {
  return target.slice(target.lastIndexOf("@") + 1);
}

function buildDiscoveryPlan(
  binding: PretrustedSshTarget,
  local: StationDiscoveryHost,
  peer: StationDiscoveryHost,
  automatic: boolean,
): DiscoveryPlan {
  assertStationIdentity(local, "Local host");
  assertStationIdentity(peer, "Peer host");
  const localGpu = selectedGb300(local, "Local host");
  const peerGpu = selectedGb300(peer, "Peer host");
  if (localGpu.uuid === peerGpu.uuid) {
    throw new Error("Peer SSH target resolved back to the local Station GPU");
  }
  const localRails = qualifyRails(local, "Local host");
  const peerRails = qualifyRails(peer, "Peer host");
  const matched = localRails.map((localRail) => {
    const peers = peerRails.filter(
      (peerRail) =>
        peerRail.subnet === localRail.subnet &&
        peerRail.address === localRail.peerAddress &&
        peerRail.peerAddress === localRail.address,
    );
    if (peers.length !== 1) {
      throw new Error("Peer did not report one reciprocal address and MAC on each /30 rail");
    }
    return { local: localRail, peer: peers[0] };
  });
  if (new Set(matched.map((entry) => entry.peer.rail.macAddress)).size !== 2) {
    throw new Error("Peer rail MAC identity is ambiguous");
  }
  if (
    automatic &&
    !matched.some((entry) => entry.peer.address === peerHostFromTarget(binding.requestedTarget))
  ) {
    throw new Error("Pretrusted discovery target is not one of the reciprocal peer rail addresses");
  }
  const rails = matched.map(
    (entry): DualStationRailIdentity => ({
      localAddress: entry.local.address,
      localMac: entry.local.rail.macAddress,
      peerAddress: entry.peer.address,
      peerMac: entry.peer.rail.macAddress,
    }),
  );
  return {
    identity: {
      peerTarget: binding.sshTarget,
      hostKeyDigest: binding.hostKeyDigest,
      localGpuUuid: localGpu.uuid,
      peerGpuUuid: peerGpu.uuid,
      rails,
    },
    localConnectivity: matched.map((entry) => ({
      netdev: entry.local.rail.netdev,
      sourceAddress: entry.local.address,
      peerAddress: entry.peer.address,
      expectedPeerMac: entry.peer.rail.macAddress,
    })),
    peerConnectivity: matched.map((entry) => ({
      netdev: entry.peer.rail.netdev,
      sourceAddress: entry.peer.address,
      peerAddress: entry.local.address,
      expectedPeerMac: entry.local.rail.macAddress,
    })),
  };
}

function validateRailIdentity(value: unknown, label: string): DualStationRailIdentity {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const localAddress = requireIpv4(value.localAddress, `${label}.localAddress`);
  const peerAddress = requireIpv4(value.peerAddress, `${label}.peerAddress`);
  if (
    deriveSlash30Counterpart(localAddress) !== peerAddress ||
    deriveSlash30Counterpart(peerAddress) !== localAddress
  ) {
    throw new Error(`${label} must contain reciprocal private /30 addresses`);
  }
  return {
    localAddress,
    localMac: normalizeMac(value.localMac, `${label}.localMac`),
    peerAddress,
    peerMac: normalizeMac(value.peerMac, `${label}.peerMac`),
  };
}

export function parseDualStationResumeState(value: unknown): DualStationResumeState {
  if (!isRecord(value) || value.schemaVersion !== DUAL_STATION_RESUME_SCHEMA_VERSION) {
    throw new Error("Dual-Station resume state schema is unsupported");
  }
  const revision = requireString(value.revision, "Dual-Station resume revision", 40);
  if (!/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error("Dual-Station resume revision is invalid");
  }
  const helperSha256 = requireString(value.helperSha256, "Dual-Station resume helper SHA-256", 64);
  if (!HOST_KEY_DIGEST_PATTERN.test(helperSha256)) {
    throw new Error("Dual-Station resume helper SHA-256 is invalid");
  }
  const peerTarget = validateStationPeerTarget(
    requireString(value.peerTarget, "Dual-Station resume peer target", 286),
  );
  const hostKeyDigest = requireString(
    value.hostKeyDigest,
    "Dual-Station resume host-key digest",
    64,
  );
  if (!HOST_KEY_DIGEST_PATTERN.test(hostKeyDigest)) {
    throw new Error("Dual-Station resume host-key digest is invalid");
  }
  const localGpuUuid = requireString(value.localGpuUuid, "Dual-Station local GPU UUID", 128);
  const peerGpuUuid = requireString(value.peerGpuUuid, "Dual-Station peer GPU UUID", 128);
  if (
    !GPU_UUID_PATTERN.test(localGpuUuid) ||
    !GPU_UUID_PATTERN.test(peerGpuUuid) ||
    localGpuUuid === peerGpuUuid
  ) {
    throw new Error("Dual-Station resume GPU identity is invalid");
  }
  const phase = value.phase;
  if (phase !== "remote-preparation" && phase !== "remote-reboot-required" && phase !== "ready") {
    throw new Error("Dual-Station resume phase is invalid");
  }
  const rails = requireArray(value.rails, "Dual-Station resume rails", 2)
    .map((entry, index) => validateRailIdentity(entry, `Dual-Station resume rail ${String(index)}`))
    .sort((left, right) => left.localAddress.localeCompare(right.localAddress));
  if (
    rails.length !== 2 ||
    new Set(rails.map((rail) => rail.localAddress)).size !== 2 ||
    new Set(rails.map((rail) => rail.peerAddress)).size !== 2 ||
    new Set(rails.map((rail) => rail.localMac)).size !== 2 ||
    new Set(rails.map((rail) => rail.peerMac)).size !== 2
  ) {
    throw new Error("Dual-Station resume rail identity is ambiguous");
  }
  return {
    schemaVersion: 1,
    revision,
    helperSha256,
    phase,
    peerTarget,
    hostKeyDigest,
    localGpuUuid,
    peerGpuUuid,
    rails,
  };
}

export function validateResumeFileMetadata(
  metadata: { isFile: boolean; isSymbolicLink: boolean; uid: number; mode: number; size: number },
  expectedUid: number,
): void {
  if (metadata.isSymbolicLink || !metadata.isFile) {
    throw new Error("Dual-Station resume state must be a regular file, not a symlink");
  }
  if (metadata.uid !== expectedUid) {
    throw new Error("Dual-Station resume state is not owned by the current user");
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error("Dual-Station resume state must have mode 0600");
  }
  if (metadata.size <= 0 || metadata.size > 16 * 1024) {
    throw new Error("Dual-Station resume state size is invalid");
  }
}

function canonicalPairIdentity(value: DualStationPairIdentity): DualStationPairIdentity {
  return {
    peerTarget: value.peerTarget,
    hostKeyDigest: value.hostKeyDigest,
    localGpuUuid: value.localGpuUuid,
    peerGpuUuid: value.peerGpuUuid,
    rails: [...value.rails].sort((left, right) =>
      left.localAddress.localeCompare(right.localAddress),
    ),
  };
}

function samePair(left: DualStationPairIdentity, right: DualStationPairIdentity): boolean {
  return (
    JSON.stringify(canonicalPairIdentity(left)) === JSON.stringify(canonicalPairIdentity(right))
  );
}

function samePhysicalSshIdentity(left: PretrustedSshTarget, right: PretrustedSshTarget): boolean {
  return (
    left.sshUser === right.sshUser &&
    left.port === right.port &&
    left.hostKeyDigest === right.hostKeyDigest
  );
}

function validateKnownHostsLookupHost(binding: PretrustedSshTarget): void {
  const expected =
    binding.port === 22
      ? binding.resolvedHost
      : `[${binding.resolvedHost}]:${String(binding.port)}`;
  if (binding.lookupHost !== expected) {
    throw new Error("Pretrusted SSH target has an invalid known-hosts lookup identity");
  }
}

function validateBinding(binding: PretrustedSshTarget): void {
  const requestedTarget = validateStationPeerTarget(binding.requestedTarget);
  const sshTarget = validateStationPeerTarget(binding.sshTarget);
  if (requestedTarget !== sshTarget) {
    throw new Error("Pretrusted SSH target changed after configuration resolution");
  }
  if (!isSafeTargetHost(binding.resolvedHost)) {
    throw new Error("Pretrusted SSH target resolved to an unsafe host");
  }
  const explicitUser = sshTarget.includes("@") ? sshTarget.slice(0, sshTarget.indexOf("@")) : null;
  if (
    !SAFE_USERNAME_PATTERN.test(binding.sshUser) ||
    (explicitUser !== null && explicitUser !== binding.sshUser) ||
    !Number.isInteger(binding.port) ||
    binding.port < 1 ||
    binding.port > 65535
  ) {
    throw new Error("Pretrusted SSH target has an unsafe user or port");
  }
  validateKnownHostsLookupHost(binding);
  if (!HOST_KEY_DIGEST_PATTERN.test(binding.hostKeyDigest)) {
    throw new Error("Pretrusted SSH target has an invalid host-key digest");
  }
  if (
    !Array.isArray(binding.keyFingerprints) ||
    binding.keyFingerprints.length === 0 ||
    binding.keyFingerprints.some(
      (fingerprint) =>
        typeof fingerprint !== "string" || !HOST_KEY_FINGERPRINT_PATTERN.test(fingerprint),
    ) ||
    !Array.isArray(binding.knownHostsLines) ||
    binding.knownHostsLines.length === 0 ||
    binding.knownHostsLines.some(
      (line) =>
        typeof line !== "string" ||
        line.length === 0 ||
        Buffer.byteLength(line, "utf8") > MAX_KNOWN_HOSTS_LINE_BYTES ||
        line !== line.trim() ||
        line.startsWith("#") ||
        /[\u0000\r\n]/.test(line),
    )
  ) {
    throw new Error("Pretrusted SSH target has invalid known-hosts evidence");
  }
  const knownHosts = `${[...new Set(binding.knownHostsLines)].sort().join("\n")}\n`;
  if (
    Buffer.byteLength(knownHosts, "utf8") > MAX_KNOWN_HOSTS_BYTES ||
    stationKnownHostsDigest(knownHosts) !== binding.hostKeyDigest
  ) {
    throw new Error("Pretrusted SSH target known-hosts evidence does not match its digest");
  }
}

function selectPretrustedTarget(
  options: DualStationPreparationOptions,
  local: StationDiscoveryHost,
  resume: DualStationResumeState | null,
  deps: DualStationPreparationDeps,
): { binding: PretrustedSshTarget; automatic: boolean } | DualStationPreparationResult {
  const candidates = deriveDiscoveryCandidates(local);
  const explicitPeer = options.explicitPeer?.trim() ?? "";
  if (explicitPeer) validateStationPeerTarget(explicitPeer);

  if (resume) {
    if (resume.revision !== options.revision) {
      throw new Error(
        `Dual-Station resume requires NemoClaw revision ${resume.revision}; current revision is ${options.revision}`,
      );
    }
    if (resume.helperSha256 !== options.helperSha256) {
      throw new Error("The reviewed Station host-preparation helper changed during reboot resume");
    }
    if (explicitPeer && explicitPeer !== resume.peerTarget) {
      throw new Error("Explicit Station peer does not match the reboot-resume pair");
    }
    if (!explicitPeer && !candidates.includes(peerHostFromTarget(resume.peerTarget))) {
      throw new Error("The reboot-resume peer is no longer a derived local /30 counterpart");
    }
    const binding = deps.inspectPretrustedTarget(resume.peerTarget);
    if (!binding) throw new Error("The reboot-resume peer is no longer pretrusted");
    validateBinding(binding);
    if (binding.hostKeyDigest !== resume.hostKeyDigest) {
      throw new Error("The reboot-resume peer host-key identity changed");
    }
    return { binding, automatic: !explicitPeer };
  }

  if (explicitPeer) {
    const binding = deps.inspectPretrustedTarget(explicitPeer);
    if (!binding)
      throw new Error("Explicit Station peer is not pretrusted; SSH trust was not changed");
    validateBinding(binding);
    return { binding, automatic: false };
  }

  const trusted: PretrustedSshTarget[] = [];
  for (const candidate of candidates) {
    try {
      const binding = deps.inspectPretrustedTarget(candidate);
      if (!binding) continue;
      validateBinding(binding);
      trusted.push(binding);
    } catch (error) {
      deps.log(
        `Ignoring derived peer ${candidate}: pre-existing SSH trust is unusable (${(error as Error).message})`,
      );
    }
  }
  if (trusted.length === 0) {
    return {
      kind: "single-station",
      reason: "No derived dual-rail peer address has pre-existing SSH host-key trust",
    };
  }
  if (trusted.length === 2 && !samePhysicalSshIdentity(trusted[0], trusted[1])) {
    return {
      kind: "single-station",
      reason: "The two derived rail addresses map to different pretrusted SSH identities",
    };
  }
  const binding = [...trusted].sort((left, right) =>
    left.requestedTarget.localeCompare(right.requestedTarget),
  )[0];
  return { binding, automatic: true };
}

function fallbackOrThrow(
  strict: boolean,
  reason: string,
): Extract<DualStationPreparationResult, { kind: "single-station" }> {
  if (strict) throw new Error(reason);
  return { kind: "single-station", reason };
}

export function prepareDualStationPair(
  options: DualStationPreparationOptions,
  deps: DualStationPreparationDeps,
): DualStationPreparationResult {
  if (!/^[a-f0-9]{40}$/.test(options.revision)) {
    throw new Error("Exact NemoClaw revision is required for dual-Station preparation");
  }
  if (!HOST_KEY_DIGEST_PATTERN.test(options.helperSha256)) {
    throw new Error("Exact Station host-preparation helper SHA-256 is required");
  }
  if (options.reuseExistingManagedPair && options.migrateLegacySingleStationHead) {
    throw new Error("Managed-pair reuse and legacy single-head migration are mutually exclusive");
  }

  if (!options.reuseExistingManagedPair && !options.migrateLegacySingleStationHead) {
    deps.log("Checking the local Station with the reviewed host-preparation helper");
    if (deps.runLocalHelper("--check") !== 0) {
      throw new Error("Local DGX Station host-preparation check failed before peer contact");
    }
    if (deps.runLocalHelper("--verify") !== 0) {
      throw new Error("Local DGX Station verification failed before peer contact");
    }
  } else if (options.reuseExistingManagedPair) {
    deps.log("Revalidating the exact running managed pair without disrupting its workloads");
  } else {
    deps.log("Revalidating the exact running legacy single-Station head before migration");
  }

  const resume = deps.readResumeState();
  let local: StationDiscoveryHost;
  try {
    local = deps.probeLocalHost();
    deriveDiscoveryCandidates(local);
  } catch (error) {
    if (resume || options.explicitPeer?.trim()) throw error;
    return {
      kind: "single-station",
      reason: `Local direct-rail discovery is unavailable: ${(error as Error).message}`,
    };
  }

  const selected = selectPretrustedTarget(options, local, resume, deps);
  if ("kind" in selected) return selected;
  const strict = Boolean(
    resume ||
      options.explicitPeer?.trim() ||
      options.reuseExistingManagedPair ||
      options.migrateLegacySingleStationHead,
  );
  const { binding, automatic } = selected;

  let peer: StationDiscoveryHost;
  try {
    peer = deps.probePeerHost(binding);
  } catch (error) {
    return fallbackOrThrow(
      strict,
      `Trusted peer identity probe failed: ${(error as Error).message}`,
    );
  }

  let plan: DiscoveryPlan;
  try {
    plan = buildDiscoveryPlan(binding, local, peer, automatic);
  } catch (error) {
    return fallbackOrThrow(strict, `Trusted peer was not reciprocal: ${(error as Error).message}`);
  }
  if (resume && !samePair(resume, plan.identity)) {
    throw new Error("The physical dual-Station pair changed during reboot resume");
  }

  let connectivityReady = false;
  try {
    connectivityReady =
      deps.probeLocalConnectivity(plan.localConnectivity) &&
      deps.probePeerConnectivity(binding, plan.peerConnectivity);
  } catch {
    connectivityReady = false;
  }
  if (!connectivityReady) {
    return fallbackOrThrow(
      strict,
      "Trusted peer failed direct-route, neighbor-MAC, or jumbo-frame checks",
    );
  }

  let peerPreparationCheckStatus = 0;
  if (!options.reuseExistingManagedPair) {
    deps.log(`Checking reciprocal peer ${binding.sshTarget} with the exact reviewed helper`);
    peerPreparationCheckStatus = deps.runRemoteHelper(binding, "--check");
    if (peerPreparationCheckStatus === STATION_PREP_EXISTING_VLLM_EXIT && !strict) {
      return {
        kind: "single-station",
        reason:
          "Trusted reciprocal peer has an active vLLM workload; leaving it unchanged and using single-Station inference",
      };
    }
  }

  const state: DualStationResumeState = {
    schemaVersion: 1,
    revision: options.revision,
    helperSha256: options.helperSha256,
    phase: "remote-preparation",
    ...plan.identity,
  };
  deps.writeResumeState(state);
  deps.log("Binding the local Station controller account to the qualified pair");
  if (deps.runLocalHelper("--bind-controller") !== 0) {
    throw new Error("Local DGX Station controller UID binding failed");
  }
  if (options.reuseExistingManagedPair) {
    deps.log("Binding the reciprocal peer controller account without disrupting managed inference");
    if (deps.runRemoteHelper(binding, "--bind-controller") !== 0) {
      throw new Error("Peer DGX Station controller UID binding failed");
    }
    deps.writeResumeState({ ...state, phase: "ready" });
    return {
      kind: "ready",
      peerTarget: binding.sshTarget,
      identity: plan.identity,
      binding,
    };
  }
  deps.log(`Preparing reciprocal peer ${binding.sshTarget} with the exact reviewed helper`);

  if (peerPreparationCheckStatus !== 0) {
    throw new Error(
      "Peer DGX Station host-preparation check failed; the selected pair remains pinned",
    );
  }
  const applyStatus = deps.runRemoteHelper(binding, "--apply");
  if (applyStatus === STATION_PREP_REBOOT_REQUIRED_EXIT) {
    deps.writeResumeState({ ...state, phase: "remote-reboot-required" });
    return {
      kind: "reboot-required",
      peerTarget: binding.sshTarget,
      identity: plan.identity,
      binding,
    };
  }
  if (applyStatus !== 0) {
    if (applyStatus !== STATION_PREP_LOGIN_REQUIRED_EXIT) {
      throw new Error("Peer DGX Station host preparation failed; refusing single-Station fallback");
    }
    deps.log("Peer Docker access requires a new login; reopening SSH before verification");
  }
  if (deps.runRemoteHelper(binding, "--bind-controller") !== 0) {
    throw new Error("Peer DGX Station controller UID binding failed");
  }
  if (deps.runRemoteHelper(binding, "--verify") !== 0) {
    throw new Error("Peer DGX Station verification failed; refusing single-Station fallback");
  }

  deps.writeResumeState({ ...state, phase: "ready" });
  return {
    kind: "ready",
    peerTarget: binding.sshTarget,
    identity: plan.identity,
    binding,
  };
}
