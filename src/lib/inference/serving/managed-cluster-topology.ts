// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { checkSystemReadinessSchemaVersion } from "../../readiness/compatibility.js";
import { hasRemediableStorageConflict } from "../../readiness/storage-remediation.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import { managedInferenceDigest } from "./catalog-integrity.js";
import type { ManagedInferenceTopologyQualification } from "./types.js";
import { MANAGED_CLUSTER_ID_PATTERN } from "./managed-cluster-identifiers.js";

export const MANAGED_CLUSTER_TOPOLOGY_ID = "host-cluster.direct-cx7" as const;
export const MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION = 1 as const;

const SAFE_INTERFACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_BINDING_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,8191}$/;
const SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SSH_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export type ManagedClusterQualificationIntent = "automatic" | "explicit" | "resume";
export type ManagedClusterRuntimeState = "clear" | "conflict" | "unknown";
export type ManagedClusterObservationState = "up" | "down" | "unknown";
export type ManagedClusterConnectivityState = "reachable" | "unreachable" | "unknown";
export type ManagedClusterRoceGidState = "resolved" | "missing" | "unknown";

export interface ManagedClusterRoceGidObservation {
  state: ManagedClusterRoceGidState;
  index?: number;
  value?: string;
}

export interface ManagedClusterRailObservation {
  adapter: "connectx-7" | "other" | "unknown";
  path: "direct" | "switched" | "unknown";
  physicalPortId: string;
  netdev: string;
  hcaDevice: string;
  hcaPort: number;
  address: string;
  prefixLength: number;
  peerNodeId: string;
  peerAddress: string;
  linkState: ManagedClusterObservationState;
  connectivity: ManagedClusterConnectivityState;
  roceGid: ManagedClusterRoceGidObservation;
}

export interface ManagedClusterNodeObservation {
  nodeId: string;
  gpuIds: readonly string[];
  readiness: SystemReadinessReport;
  runtimeState: ManagedClusterRuntimeState;
  rails: readonly ManagedClusterRailObservation[];
}

export interface ManagedClusterSshBindingObservation {
  state: "pretrusted" | "untrusted" | "unknown";
  fromNodeId: string;
  toNodeId: string;
  peerTarget: string;
  handle: string;
}

export interface ManagedClusterPeerObservation extends ManagedClusterNodeObservation {
  sshBinding: ManagedClusterSshBindingObservation;
}

export interface ManagedClusterTopologyQualificationInput {
  intent: ManagedClusterQualificationIntent;
  evaluatedAt: string;
  maxReadinessAgeMs: number;
  local: ManagedClusterNodeObservation;
  peers: readonly ManagedClusterPeerObservation[];
}

export interface ManagedClusterTopologyNode {
  nodeId: string;
  gpuId: string;
  rank: number;
  role: "head" | "worker";
}

export interface ManagedClusterTopologyRoceGid {
  index: number;
  value: string;
}

export interface ManagedClusterTopologyRailEndpoint {
  nodeId: string;
  netdev: string;
  hcaDevice: string;
  hcaPort: number;
  address: string;
  prefixLength: number;
  peerAddress: string;
  roceGid: ManagedClusterTopologyRoceGid;
}

export interface ManagedClusterTopologyRail {
  index: number;
  endpoints: readonly [ManagedClusterTopologyRailEndpoint, ManagedClusterTopologyRailEndpoint];
}

export interface ManagedClusterTopologyOutput {
  controllerNodeId: string;
  nodes: readonly ManagedClusterTopologyNode[];
  rails: readonly ManagedClusterTopologyRail[];
  masterAddress: string;
  peers: readonly {
    nodeId: string;
    target: string;
    sshBindingHandle: string;
  }[];
}

export type ManagedClusterTopologyArtifact =
  ManagedInferenceTopologyQualification<ManagedClusterTopologyOutput> & {
    id: typeof MANAGED_CLUSTER_TOPOLOGY_ID;
    schemaVersion: typeof MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION;
    status: "qualified";
  };

export type ManagedClusterTopologyFailureCode =
  | "peer-count"
  | "qualification-policy-invalid"
  | "readiness-schema-incompatible"
  | "readiness-stale"
  | "readiness-incompatible"
  | "readiness-inconclusive"
  | "spark-qualification-unavailable"
  | "runtime-qualification-unavailable"
  | "node-identity-unavailable"
  | "duplicate-node-identity"
  | "gpu-identity-unavailable"
  | "duplicate-gpu-identity"
  | "runtime-conflict"
  | "runtime-state-unknown"
  | "ssh-binding-unavailable"
  | "fabric-degraded"
  | "fabric-multiple"
  | "fabric-mismatch";

export type ManagedClusterTopologyQualificationResult =
  | { outcome: "qualified"; artifact: ManagedClusterTopologyArtifact }
  | { outcome: "no-match"; code: ManagedClusterTopologyFailureCode; message: string }
  | { outcome: "error"; code: ManagedClusterTopologyFailureCode; message: string };

interface QualificationFailure {
  code: ManagedClusterTopologyFailureCode;
  message: string;
}

interface QualifiedNode {
  observation: ManagedClusterNodeObservation;
  gpuId: string;
}

interface ValidatedRail {
  observation: ManagedClusterRailObservation;
  gid: ManagedClusterTopologyRoceGid;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(
  intent: ManagedClusterQualificationIntent,
  result: QualificationFailure,
): ManagedClusterTopologyQualificationResult {
  return intent === "automatic"
    ? { outcome: "no-match", ...result }
    : { outcome: "error", ...result };
}

function validateQualificationPolicy(
  evaluatedAt: string,
  maxReadinessAgeMs: number,
): number | QualificationFailure {
  const evaluatedAtMs = Date.parse(evaluatedAt);
  if (
    !Number.isFinite(evaluatedAtMs) ||
    !Number.isSafeInteger(maxReadinessAgeMs) ||
    maxReadinessAgeMs <= 0
  ) {
    return {
      code: "qualification-policy-invalid",
      message: "The topology qualification time or readiness age limit is invalid.",
    };
  }
  return evaluatedAtMs;
}

function validateReadiness(
  report: SystemReadinessReport,
  evaluatedAtMs: number,
  maxReadinessAgeMs: number,
): QualificationFailure | undefined {
  const compatibility = checkSystemReadinessSchemaVersion(report.schemaVersion);
  if (!compatibility.compatible || report.mutated !== false) {
    return {
      code: "readiness-schema-incompatible",
      message: "A node readiness report has an incompatible schema.",
    };
  }

  const observedAtMs = Date.parse(report.provenance.observedAt);
  const readinessAgeMs = evaluatedAtMs - observedAtMs;
  if (!Number.isFinite(observedAtMs) || readinessAgeMs < 0 || readinessAgeMs > maxReadinessAgeMs) {
    return {
      code: "readiness-stale",
      message: "A node readiness report is outside the accepted observation window.",
    };
  }

  if (report.status === "inconclusive") {
    return {
      code: "readiness-inconclusive",
      message: "A node readiness report is inconclusive.",
    };
  }
  const remediableStorage = hasRemediableStorageConflict(report);
  if (
    (report.status !== "supported" ||
      report.exitCode !== 0 ||
      report.findings.some(({ severity }) => severity === "blocking" || severity === "fatal")) &&
    !remediableStorage
  ) {
    return {
      code: "readiness-incompatible",
      message: "A node readiness report is incompatible with this topology.",
    };
  }

  const sparkQualifications = report.qualifications.filter(
    (qualification) => qualification.id === "host.platform.dgx_spark",
  );
  if (sparkQualifications.length !== 1 || sparkQualifications[0]?.status !== "qualified") {
    return {
      code: "spark-qualification-unavailable",
      message: "A node does not have one qualified DGX Spark readiness result.",
    };
  }

  return undefined;
}

function validateNode(
  node: ManagedClusterNodeObservation,
  evaluatedAtMs: number,
  maxReadinessAgeMs: number,
): QualifiedNode | QualificationFailure {
  if (!MANAGED_CLUSTER_ID_PATTERN.test(node.nodeId)) {
    return {
      code: "node-identity-unavailable",
      message: "A node identity is missing or invalid.",
    };
  }
  if (node.gpuIds.length !== 1 || !MANAGED_CLUSTER_ID_PATTERN.test(node.gpuIds[0] ?? "")) {
    return {
      code: "gpu-identity-unavailable",
      message: "Each DGX Spark node must have exactly one valid GPU identity.",
    };
  }
  const readinessFailure = validateReadiness(node.readiness, evaluatedAtMs, maxReadinessAgeMs);
  if (readinessFailure) return readinessFailure;
  if (node.runtimeState === "conflict") {
    return {
      code: "runtime-conflict",
      message: "An existing runtime conflicts with automatic managed cluster activation.",
    };
  }
  if (node.runtimeState !== "clear") {
    return {
      code: "runtime-state-unknown",
      message: "The existing runtime state is unknown.",
    };
  }
  return { observation: node, gpuId: node.gpuIds[0]! };
}

function validAddress(address: string, prefixLength: number): boolean {
  const version = net.isIP(address);
  const maxPrefixLength = version === 4 ? 32 : version === 6 ? 128 : 0;
  return (
    maxPrefixLength > 0 &&
    address !== "0.0.0.0" &&
    address !== "::" &&
    Number.isInteger(prefixLength) &&
    prefixLength > 0 &&
    prefixLength <= maxPrefixLength
  );
}

function validateRail(rail: ManagedClusterRailObservation): ValidatedRail | QualificationFailure {
  if (
    rail.adapter !== "connectx-7" ||
    rail.path !== "direct" ||
    rail.linkState !== "up" ||
    rail.connectivity !== "reachable"
  ) {
    return {
      code: "fabric-degraded",
      message: "The direct ConnectX-7 fabric is incomplete or degraded.",
    };
  }
  if (
    !MANAGED_CLUSTER_ID_PATTERN.test(rail.physicalPortId) ||
    !SAFE_INTERFACE_PATTERN.test(rail.netdev) ||
    !SAFE_INTERFACE_PATTERN.test(rail.hcaDevice) ||
    !Number.isInteger(rail.hcaPort) ||
    rail.hcaPort <= 0 ||
    rail.hcaPort > 255 ||
    !validAddress(rail.address, rail.prefixLength) ||
    net.isIP(rail.peerAddress) === 0 ||
    rail.address === rail.peerAddress ||
    !MANAGED_CLUSTER_ID_PATTERN.test(rail.peerNodeId)
  ) {
    return {
      code: "fabric-mismatch",
      message: "The ConnectX-7 rail identity or peer address is invalid.",
    };
  }
  const gid = rail.roceGid;
  if (
    gid.state !== "resolved" ||
    !Number.isInteger(gid.index) ||
    (gid.index ?? -1) < 0 ||
    (gid.index ?? 4096) > 4095 ||
    typeof gid.value !== "string" ||
    net.isIP(gid.value) !== 6 ||
    gid.value === "::"
  ) {
    return {
      code: "fabric-degraded",
      message: "A ConnectX-7 rail does not have a resolved RoCE GID.",
    };
  }
  return { observation: rail, gid: { index: gid.index!, value: gid.value } };
}

function validateNodeRails(
  node: ManagedClusterNodeObservation,
): readonly ValidatedRail[] | QualificationFailure {
  if (node.rails.length < 2) {
    return {
      code: "fabric-degraded",
      message: "One direct ConnectX-7 cable must expose two logical rails on each node.",
    };
  }
  if (node.rails.length > 2) {
    return {
      code: "fabric-multiple",
      message: "More than one candidate ConnectX-7 cable topology was observed.",
    };
  }

  const physicalPorts = new Set(node.rails.map(({ physicalPortId }) => physicalPortId));
  if (physicalPorts.size !== 1) {
    return {
      code: "fabric-multiple",
      message: "The candidate logical rails belong to more than one physical port.",
    };
  }

  const validated = node.rails.map((rail) => validateRail(rail));
  const validationFailure = validated.find((rail): rail is QualificationFailure => "code" in rail);
  if (validationFailure) return validationFailure;
  const rails = validated as ValidatedRail[];
  const uniqueNetdevs = new Set(rails.map(({ observation }) => observation.netdev));
  const uniqueHcas = new Set(
    rails.map(({ observation }) => `${observation.hcaDevice}:${observation.hcaPort}`),
  );
  const uniqueAddresses = new Set(rails.map(({ observation }) => observation.address));
  const uniqueGids = new Set(
    rails.map(({ gid, observation }) => `${observation.hcaDevice}:${gid.index}:${gid.value}`),
  );
  if (
    uniqueNetdevs.size !== 2 ||
    uniqueHcas.size !== 2 ||
    uniqueAddresses.size !== 2 ||
    uniqueGids.size !== 2
  ) {
    return {
      code: "fabric-mismatch",
      message: "The two logical ConnectX-7 rails must have distinct interfaces and addresses.",
    };
  }
  return rails;
}

function endpoint(nodeId: string, rail: ValidatedRail): ManagedClusterTopologyRailEndpoint {
  const observation = rail.observation;
  return {
    nodeId,
    netdev: observation.netdev,
    hcaDevice: observation.hcaDevice,
    hcaPort: observation.hcaPort,
    address: observation.address,
    prefixLength: observation.prefixLength,
    peerAddress: observation.peerAddress,
    roceGid: rail.gid,
  };
}

function matchRails(
  orderedNodes: readonly ManagedClusterNodeObservation[],
): readonly ManagedClusterTopologyRail[] | QualificationFailure {
  const ranks = new Map(orderedNodes.map(({ nodeId }, rank) => [nodeId, rank]));
  const validatedByNode = new Map<string, readonly ValidatedRail[]>();
  for (const node of orderedNodes) {
    const validated = validateNodeRails(node);
    if ("code" in validated) return validated;
    validatedByNode.set(node.nodeId, validated);
  }

  const candidates = orderedNodes.flatMap((node) =>
    validatedByNode.get(node.nodeId)!.map((rail) => ({ nodeId: node.nodeId, rail })),
  );
  const used = new Set<string>();
  const matches: Array<{
    leftNodeId: string;
    left: ValidatedRail;
    rightNodeId: string;
    right: ValidatedRail;
  }> = [];
  const candidateKey = ({ nodeId, rail }: (typeof candidates)[number]) =>
    `${nodeId}\0${rail.observation.netdev}`;

  for (const candidate of candidates) {
    if (used.has(candidateKey(candidate))) continue;
    const observation = candidate.rail.observation;
    const reciprocal = candidates.filter(
      (other) =>
        other.nodeId === observation.peerNodeId &&
        other.rail.observation.peerNodeId === candidate.nodeId &&
        other.rail.observation.address === observation.peerAddress &&
        other.rail.observation.peerAddress === observation.address &&
        other.rail.observation.prefixLength === observation.prefixLength &&
        net.isIP(other.rail.observation.address) === net.isIP(observation.address),
    );
    if (reciprocal.length !== 1) {
      return {
        code: "fabric-mismatch",
        message: "Every ConnectX-7 rail must have one reciprocal endpoint in the cluster.",
      };
    }
    const peer = reciprocal[0]!;
    const peerKey = candidateKey(peer);
    if (used.has(peerKey)) {
      return {
        code: "fabric-mismatch",
        message: "The ConnectX-7 rail pairing is ambiguous.",
      };
    }
    used.add(candidateKey(candidate));
    used.add(peerKey);
    const candidateRank = ranks.get(candidate.nodeId)!;
    const peerRank = ranks.get(peer.nodeId)!;
    matches.push(
      candidateRank < peerRank
        ? {
            leftNodeId: candidate.nodeId,
            left: candidate.rail,
            rightNodeId: peer.nodeId,
            right: peer.rail,
          }
        : {
            leftNodeId: peer.nodeId,
            left: peer.rail,
            rightNodeId: candidate.nodeId,
            right: candidate.rail,
          },
    );
  }

  if (used.size !== candidates.length) {
    return { code: "fabric-mismatch", message: "The ConnectX-7 cluster graph is incomplete." };
  }
  const endpointAddresses = new Set(
    matches.flatMap(({ left, right }) => [left.observation.address, right.observation.address]),
  );
  if (endpointAddresses.size !== candidates.length) {
    return {
      code: "fabric-mismatch",
      message: "The ConnectX-7 rail endpoints must have distinct addresses.",
    };
  }

  const adjacency = new Map(orderedNodes.map(({ nodeId }) => [nodeId, new Set<string>()]));
  for (const { leftNodeId, rightNodeId } of matches) {
    adjacency.get(leftNodeId)!.add(rightNodeId);
    adjacency.get(rightNodeId)!.add(leftNodeId);
  }
  const visited = new Set<string>();
  const queue = [orderedNodes[0]!.nodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    queue.push(...adjacency.get(nodeId)!);
  }
  if (visited.size !== orderedNodes.length) {
    return { code: "fabric-mismatch", message: "The ConnectX-7 cluster graph is disconnected." };
  }

  matches.sort(
    (left, right) =>
      ranks.get(left.leftNodeId)! - ranks.get(right.leftNodeId)! ||
      compareStrings(left.left.observation.netdev, right.left.observation.netdev) ||
      ranks.get(left.rightNodeId)! - ranks.get(right.rightNodeId)!,
  );
  return matches.map(({ leftNodeId, left, rightNodeId, right }, index) => ({
    index,
    endpoints: [endpoint(leftNodeId, left), endpoint(rightNodeId, right)],
  }));
}

function validSshTarget(target: string): boolean {
  if (target.length === 0 || target.length > 286 || target !== target.trim()) return false;
  const parts = target.split("@");
  if (parts.length > 2) return false;
  const host = parts.at(-1) ?? "";
  const username = parts.length === 2 ? parts[0] : undefined;
  return (
    (username === undefined || SSH_USERNAME_PATTERN.test(username)) &&
    (net.isIP(host) === 4 || SSH_HOST_PATTERN.test(host))
  );
}

function validateSshBinding(
  binding: ManagedClusterSshBindingObservation,
  localNodeId: string,
  peerNodeId: string,
): QualificationFailure | undefined {
  if (
    binding.state !== "pretrusted" ||
    binding.fromNodeId !== localNodeId ||
    binding.toNodeId !== peerNodeId ||
    !validSshTarget(binding.peerTarget) ||
    !SAFE_BINDING_HANDLE_PATTERN.test(binding.handle)
  ) {
    return {
      code: "ssh-binding-unavailable",
      message: "The peer does not have a valid pretrusted SSH binding.",
    };
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function artifactEndpointError(value: unknown, expectedNodeId: string): string | undefined {
  const candidate = record(value);
  const gid = record(candidate?.roceGid);
  if (
    !candidate ||
    candidate.nodeId !== expectedNodeId ||
    typeof candidate.netdev !== "string" ||
    !SAFE_INTERFACE_PATTERN.test(candidate.netdev) ||
    typeof candidate.hcaDevice !== "string" ||
    !SAFE_INTERFACE_PATTERN.test(candidate.hcaDevice) ||
    !Number.isInteger(candidate.hcaPort) ||
    (candidate.hcaPort as number) <= 0 ||
    (candidate.hcaPort as number) > 255 ||
    typeof candidate.address !== "string" ||
    typeof candidate.prefixLength !== "number" ||
    !validAddress(candidate.address, candidate.prefixLength) ||
    typeof candidate.peerAddress !== "string" ||
    net.isIP(candidate.peerAddress) !== net.isIP(candidate.address) ||
    candidate.peerAddress === candidate.address ||
    !gid ||
    !Number.isInteger(gid.index) ||
    (gid.index as number) < 0 ||
    (gid.index as number) > 4095 ||
    typeof gid.value !== "string" ||
    net.isIP(gid.value) !== 6 ||
    gid.value === "::"
  ) {
    return `the ${expectedNodeId} rail endpoint is invalid`;
  }
  return undefined;
}

function topologyOutputError(
  value: unknown,
  subjectNodeIds: readonly string[],
): string | undefined {
  const output = record(value);
  if (!output) return "topology qualification output is invalid";
  const controllerNodeId = output.controllerNodeId;
  if (typeof controllerNodeId !== "string" || !MANAGED_CLUSTER_ID_PATTERN.test(controllerNodeId)) {
    return "topology controller node is invalid";
  }
  if (!Array.isArray(output.nodes) || output.nodes.length !== subjectNodeIds.length) {
    return "topology nodes are invalid";
  }
  const nodes = output.nodes.map(record);
  if (nodes.some((node) => !node)) return "topology nodes are invalid";
  const typedNodes = nodes as Record<string, unknown>[];
  const nodeIds = typedNodes.map(({ nodeId }) => nodeId);
  const gpuIds = typedNodes.map(({ gpuId }) => gpuId);
  if (
    typedNodes.some(
      (node, rank) =>
        node.rank !== rank ||
        node.role !== (rank === 0 ? "head" : "worker") ||
        typeof node.nodeId !== "string" ||
        !MANAGED_CLUSTER_ID_PATTERN.test(node.nodeId) ||
        typeof node.gpuId !== "string" ||
        !MANAGED_CLUSTER_ID_PATTERN.test(node.gpuId),
    ) ||
    nodeIds[0] !== controllerNodeId ||
    new Set(nodeIds).size !== nodeIds.length ||
    new Set(gpuIds).size !== gpuIds.length ||
    [...(nodeIds as string[])]
      .sort(compareStrings)
      .some((nodeId, index) => nodeId !== subjectNodeIds[index])
  ) {
    return "topology node roles or GPU identities are invalid";
  }

  if (!Array.isArray(output.rails) || output.rails.length !== typedNodes.length) {
    return "topology rails are invalid";
  }
  const rails: ManagedClusterTopologyRail[] = [];
  const endpointCounts = new Map((nodeIds as string[]).map((nodeId) => [nodeId, 0]));
  const endpointNetdevs = new Map(
    (nodeIds as string[]).map((nodeId) => [nodeId, new Set<string>()]),
  );
  const endpointAddresses = new Set<string>();
  const adjacency = new Map((nodeIds as string[]).map((nodeId) => [nodeId, new Set<string>()]));
  for (const [index, candidate] of output.rails.entries()) {
    const rail = record(candidate);
    if (
      !rail ||
      rail.index !== index ||
      !Array.isArray(rail.endpoints) ||
      rail.endpoints.length !== 2
    ) {
      return "topology rail indexes or endpoints are invalid";
    }
    const endpoints = rail.endpoints.map(record);
    const leftNodeId = endpoints[0]?.nodeId;
    const rightNodeId = endpoints[1]?.nodeId;
    if (
      typeof leftNodeId !== "string" ||
      typeof rightNodeId !== "string" ||
      leftNodeId === rightNodeId ||
      !endpointCounts.has(leftNodeId) ||
      !endpointCounts.has(rightNodeId)
    ) {
      return "topology rail node identities are invalid";
    }
    const leftError = artifactEndpointError(rail.endpoints[0], leftNodeId);
    const rightError = artifactEndpointError(rail.endpoints[1], rightNodeId);
    if (leftError || rightError) return leftError ?? rightError;
    const typedRail = rail as unknown as ManagedClusterTopologyRail;
    const [left, right] = typedRail.endpoints;
    if (
      left.address !== right.peerAddress ||
      right.address !== left.peerAddress ||
      left.prefixLength !== right.prefixLength
    ) {
      return "topology rail addresses are not reciprocal";
    }
    endpointCounts.set(leftNodeId, endpointCounts.get(leftNodeId)! + 1);
    endpointCounts.set(rightNodeId, endpointCounts.get(rightNodeId)! + 1);
    endpointNetdevs.get(leftNodeId)!.add(left.netdev);
    endpointNetdevs.get(rightNodeId)!.add(right.netdev);
    endpointAddresses.add(left.address);
    endpointAddresses.add(right.address);
    adjacency.get(leftNodeId)!.add(rightNodeId);
    adjacency.get(rightNodeId)!.add(leftNodeId);
    rails.push(typedRail);
  }
  if (
    [...endpointCounts.values()].some((count) => count !== 2) ||
    [...endpointNetdevs.values()].some((netdevs) => netdevs.size !== 2) ||
    endpointAddresses.size !== rails.length * 2
  ) {
    return "topology rail identities are not distinct";
  }
  const visited = new Set<string>();
  const queue = [controllerNodeId];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    queue.push(...adjacency.get(nodeId)!);
  }
  if (visited.size !== typedNodes.length) return "topology rail graph is disconnected";
  const controllerAddresses = rails.flatMap(({ endpoints }) =>
    endpoints.filter(({ nodeId }) => nodeId === controllerNodeId).map(({ address }) => address),
  );
  if (
    typeof output.masterAddress !== "string" ||
    !controllerAddresses.includes(output.masterAddress)
  ) {
    return "topology master address does not belong to the controller node";
  }

  if (!Array.isArray(output.peers) || output.peers.length !== typedNodes.length - 1) {
    return "topology peer binding is invalid";
  }
  const workerNodeIds = new Set((nodeIds as string[]).slice(1));
  const boundNodeIds = new Set<string>();
  for (const candidate of output.peers) {
    const peer = record(candidate);
    if (
      !peer ||
      typeof peer.nodeId !== "string" ||
      !workerNodeIds.has(peer.nodeId) ||
      boundNodeIds.has(peer.nodeId) ||
      typeof peer.target !== "string" ||
      !validSshTarget(peer.target) ||
      typeof peer.sshBindingHandle !== "string" ||
      !SAFE_BINDING_HANDLE_PATTERN.test(peer.sshBindingHandle)
    ) {
      return "topology peer binding is invalid";
    }
    boundNodeIds.add(peer.nodeId);
  }
  return undefined;
}

export function managedClusterTopologySubjectDigest(subjectNodeIds: readonly string[]): string {
  return managedInferenceDigest([...subjectNodeIds].sort(compareStrings));
}

export function managedClusterTopologyOutputDigest(output: ManagedClusterTopologyOutput): string {
  return managedInferenceDigest(output);
}

export function getManagedClusterTopologyArtifactError(
  artifact: ManagedInferenceTopologyQualification<unknown>,
  expectedSubjectNodeIds?: readonly string[],
): string | undefined {
  if (
    artifact.id !== MANAGED_CLUSTER_TOPOLOGY_ID ||
    artifact.schemaVersion !== MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION
  ) {
    return "topology qualification identity is incompatible";
  }
  if (artifact.status !== "qualified") return "topology qualification is not qualified";
  if (!Array.isArray(artifact.subjectNodeIds)) return "topology qualification subject is invalid";
  const subjectNodeIds = [...artifact.subjectNodeIds];
  if (
    subjectNodeIds.length < 2 ||
    subjectNodeIds.length > 1024 ||
    new Set(subjectNodeIds).size !== subjectNodeIds.length ||
    subjectNodeIds.some((nodeId) => !MANAGED_CLUSTER_ID_PATTERN.test(nodeId)) ||
    subjectNodeIds.some((nodeId, index) => index > 0 && subjectNodeIds[index - 1]! >= nodeId)
  ) {
    return "topology qualification subject is invalid";
  }
  if (
    expectedSubjectNodeIds &&
    subjectNodeIds.some((nodeId, index) => nodeId !== expectedSubjectNodeIds[index])
  ) {
    return "topology qualification subject does not match the readiness reports";
  }

  const outputError = topologyOutputError(artifact.output, subjectNodeIds);
  if (outputError) return outputError;
  try {
    if (artifact.subjectDigest !== managedClusterTopologySubjectDigest(subjectNodeIds)) {
      return "topology qualification subject digest does not match its subject";
    }
    if (
      artifact.outputDigest !==
      managedClusterTopologyOutputDigest(artifact.output as ManagedClusterTopologyOutput)
    ) {
      return "topology qualification output digest does not match its output";
    }
  } catch {
    return "topology qualification digest is invalid";
  }
  return undefined;
}

export function qualifyManagedClusterTopology(
  input: Readonly<ManagedClusterTopologyQualificationInput>,
): ManagedClusterTopologyQualificationResult {
  if (input.peers.length < 1 || input.peers.length > 1023) {
    return failure(input.intent, {
      code: "peer-count",
      message: "Managed cluster activation requires between one and 1023 discovered peers.",
    });
  }

  const evaluatedAtMs = validateQualificationPolicy(input.evaluatedAt, input.maxReadinessAgeMs);
  if (typeof evaluatedAtMs !== "number") return failure(input.intent, evaluatedAtMs);

  const orderedObservations = [
    input.local,
    ...[...input.peers].sort((left, right) => compareStrings(left.nodeId, right.nodeId)),
  ];
  const qualifiedNodes: QualifiedNode[] = [];
  for (const observation of orderedObservations) {
    const qualified = validateNode(observation, evaluatedAtMs, input.maxReadinessAgeMs);
    if ("code" in qualified) return failure(input.intent, qualified);
    qualifiedNodes.push(qualified);
  }
  const nodeIds = orderedObservations.map(({ nodeId }) => nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) {
    return failure(input.intent, {
      code: "duplicate-node-identity",
      message: "The managed cluster observations contain a duplicate node identity.",
    });
  }
  const gpuIds = qualifiedNodes.map(({ gpuId }) => gpuId);
  if (new Set(gpuIds).size !== gpuIds.length) {
    return failure(input.intent, {
      code: "duplicate-gpu-identity",
      message: "The managed cluster observations contain a duplicate GPU identity.",
    });
  }

  for (const peer of input.peers) {
    const sshFailure = validateSshBinding(peer.sshBinding, input.local.nodeId, peer.nodeId);
    if (sshFailure) return failure(input.intent, sshFailure);
  }
  const rails = matchRails(orderedObservations);
  if ("code" in rails) return failure(input.intent, rails);
  const controllerEndpoint = rails
    .flatMap(({ endpoints }) => endpoints)
    .filter(({ nodeId }) => nodeId === input.local.nodeId)
    .sort((left, right) => compareStrings(left.netdev, right.netdev))[0];
  if (!controllerEndpoint) {
    return failure(input.intent, {
      code: "fabric-mismatch",
      message: "The managed cluster controller has no qualified fabric endpoint.",
    });
  }

  const output: ManagedClusterTopologyOutput = {
    controllerNodeId: input.local.nodeId,
    nodes: qualifiedNodes.map(({ observation, gpuId }, rank) => ({
      nodeId: observation.nodeId,
      gpuId,
      rank,
      role: rank === 0 ? "head" : "worker",
    })),
    rails,
    masterAddress: controllerEndpoint.address,
    peers: orderedObservations.slice(1).map((observation) => {
      const peer = observation as ManagedClusterPeerObservation;
      return {
        nodeId: peer.nodeId,
        target: peer.sshBinding.peerTarget,
        sshBindingHandle: peer.sshBinding.handle,
      };
    }),
  };
  const subjectNodeIds = [...nodeIds].sort(compareStrings);
  return {
    outcome: "qualified",
    artifact: {
      id: MANAGED_CLUSTER_TOPOLOGY_ID,
      schemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
      status: "qualified",
      subjectNodeIds,
      subjectDigest: managedClusterTopologySubjectDigest(subjectNodeIds),
      outputDigest: managedClusterTopologyOutputDigest(output),
      output,
    },
  };
}
