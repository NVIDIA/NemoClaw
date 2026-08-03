// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { checkSystemReadinessSchemaVersion } from "../../readiness/compatibility.js";
import type { SystemReadinessReport } from "../../readiness/types.js";
import { managedInferenceDigest } from "./catalog-integrity.js";
import type { ManagedInferenceTopologyQualification } from "./catalog-types.js";

export const DUAL_SPARK_TOPOLOGY_ID = "dgx-spark.gb10.dual-cx7" as const;
export const DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION = 1 as const;

const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_INTERFACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_BINDING_HANDLE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,8191}$/;
const SSH_USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const SSH_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export type DualSparkQualificationIntent = "automatic" | "explicit" | "resume";
export type DualSparkRuntimeState = "clear" | "conflict" | "unknown";
export type DualSparkObservationState = "up" | "down" | "unknown";
export type DualSparkConnectivityState = "reachable" | "unreachable" | "unknown";
export type DualSparkRoceGidState = "resolved" | "missing" | "unknown";

export interface DualSparkRoceGidObservation {
  state: DualSparkRoceGidState;
  index?: number;
  value?: string;
}

export interface DualSparkRailObservation {
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
  linkState: DualSparkObservationState;
  connectivity: DualSparkConnectivityState;
  roceGid: DualSparkRoceGidObservation;
}

export interface DualSparkNodeObservation {
  nodeId: string;
  gpuIds: readonly string[];
  readiness: SystemReadinessReport;
  runtimeState: DualSparkRuntimeState;
  rails: readonly DualSparkRailObservation[];
}

export interface DualSparkSshBindingObservation {
  state: "pretrusted" | "untrusted" | "unknown";
  fromNodeId: string;
  toNodeId: string;
  peerTarget: string;
  handle: string;
}

export interface DualSparkPeerObservation extends DualSparkNodeObservation {
  sshBinding: DualSparkSshBindingObservation;
}

export interface DualSparkTopologyQualificationInput {
  intent: DualSparkQualificationIntent;
  evaluatedAt: string;
  maxReadinessAgeMs: number;
  local: DualSparkNodeObservation;
  peers: readonly DualSparkPeerObservation[];
}

export interface DualSparkTopologyNode {
  nodeId: string;
  gpuId: string;
  role: "head" | "worker";
}

export interface DualSparkTopologyRoceGid {
  index: number;
  value: string;
}

export interface DualSparkTopologyRailEndpoint {
  nodeId: string;
  netdev: string;
  hcaDevice: string;
  hcaPort: number;
  address: string;
  prefixLength: number;
  peerAddress: string;
  roceGid: DualSparkTopologyRoceGid;
}

export interface DualSparkTopologyRail {
  index: number;
  head: DualSparkTopologyRailEndpoint;
  worker: DualSparkTopologyRailEndpoint;
}

export interface DualSparkTopologyOutput {
  headNodeId: string;
  workerNodeId: string;
  nodes: readonly [DualSparkTopologyNode, DualSparkTopologyNode];
  rails: readonly [DualSparkTopologyRail, DualSparkTopologyRail];
  masterAddress: string;
  peer: {
    target: string;
    sshBindingHandle: string;
  };
}

export type DualSparkTopologyArtifact =
  ManagedInferenceTopologyQualification<DualSparkTopologyOutput> & {
    id: typeof DUAL_SPARK_TOPOLOGY_ID;
    schemaVersion: typeof DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION;
    status: "qualified";
  };

export type DualSparkTopologyFailureCode =
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
  | "fabric-mismatch"
  | "artifact-digest-failed";

export type DualSparkTopologyQualificationResult =
  | { outcome: "qualified"; artifact: DualSparkTopologyArtifact }
  | { outcome: "no-match"; code: DualSparkTopologyFailureCode; message: string }
  | { outcome: "error"; code: DualSparkTopologyFailureCode; message: string };

interface QualificationFailure {
  code: DualSparkTopologyFailureCode;
  message: string;
}

interface QualifiedNode {
  observation: DualSparkNodeObservation;
  gpuId: string;
}

interface ValidatedRail {
  observation: DualSparkRailObservation;
  gid: DualSparkTopologyRoceGid;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function failure(
  intent: DualSparkQualificationIntent,
  result: QualificationFailure,
): DualSparkTopologyQualificationResult {
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
  if (
    report.status !== "supported" ||
    report.exitCode !== 0 ||
    report.findings.some(({ severity }) => severity === "blocking" || severity === "fatal")
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
  node: DualSparkNodeObservation,
  evaluatedAtMs: number,
  maxReadinessAgeMs: number,
): QualifiedNode | QualificationFailure {
  if (!SAFE_ID_PATTERN.test(node.nodeId)) {
    return {
      code: "node-identity-unavailable",
      message: "A node identity is missing or invalid.",
    };
  }
  if (node.gpuIds.length !== 1 || !SAFE_ID_PATTERN.test(node.gpuIds[0] ?? "")) {
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
      message: "An existing runtime conflicts with automatic dual-node activation.",
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

function validateRail(
  rail: DualSparkRailObservation,
  expectedPeerNodeId: string,
): ValidatedRail | QualificationFailure {
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
    !SAFE_ID_PATTERN.test(rail.physicalPortId) ||
    !SAFE_INTERFACE_PATTERN.test(rail.netdev) ||
    !SAFE_INTERFACE_PATTERN.test(rail.hcaDevice) ||
    !Number.isInteger(rail.hcaPort) ||
    rail.hcaPort <= 0 ||
    rail.hcaPort > 255 ||
    !validAddress(rail.address, rail.prefixLength) ||
    net.isIP(rail.peerAddress) === 0 ||
    rail.address === rail.peerAddress ||
    rail.peerNodeId !== expectedPeerNodeId
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
  node: DualSparkNodeObservation,
  expectedPeerNodeId: string,
): readonly [ValidatedRail, ValidatedRail] | QualificationFailure {
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

  const validated = node.rails.map((rail) => validateRail(rail, expectedPeerNodeId));
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
  return [rails[0]!, rails[1]!];
}

function endpoint(nodeId: string, rail: ValidatedRail): DualSparkTopologyRailEndpoint {
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
  local: DualSparkNodeObservation,
  peer: DualSparkNodeObservation,
): readonly [DualSparkTopologyRail, DualSparkTopologyRail] | QualificationFailure {
  const localRails = validateNodeRails(local, peer.nodeId);
  if ("code" in localRails) return localRails;
  const peerRails = validateNodeRails(peer, local.nodeId);
  if ("code" in peerRails) return peerRails;

  const remainingPeerRails = [...peerRails];
  const matches: Array<{ head: ValidatedRail; worker: ValidatedRail }> = [];
  for (const localRail of localRails) {
    const peerIndex = remainingPeerRails.findIndex(
      ({ observation }) =>
        observation.address === localRail.observation.peerAddress &&
        observation.peerAddress === localRail.observation.address &&
        observation.prefixLength === localRail.observation.prefixLength &&
        net.isIP(observation.address) === net.isIP(localRail.observation.address),
    );
    if (peerIndex === -1) {
      return {
        code: "fabric-mismatch",
        message: "The ConnectX-7 rail addresses are not reciprocal.",
      };
    }
    matches.push({ head: localRail, worker: remainingPeerRails[peerIndex]! });
    remainingPeerRails.splice(peerIndex, 1);
  }
  if (remainingPeerRails.length !== 0) {
    return {
      code: "fabric-mismatch",
      message: "The ConnectX-7 rail pairing is ambiguous.",
    };
  }
  const endpointAddresses = new Set(
    matches.flatMap(({ head, worker }) => [head.observation.address, worker.observation.address]),
  );
  if (endpointAddresses.size !== 4) {
    return {
      code: "fabric-mismatch",
      message: "The ConnectX-7 rail endpoints must have four distinct addresses.",
    };
  }

  matches.sort((left, right) => {
    const leftNetdev = left.head.observation.netdev;
    const rightNetdev = right.head.observation.netdev;
    return (
      compareStrings(leftNetdev.toLowerCase(), rightNetdev.toLowerCase()) ||
      compareStrings(leftNetdev, rightNetdev)
    );
  });
  const makeRail = (
    match: { head: ValidatedRail; worker: ValidatedRail },
    index: number,
  ): DualSparkTopologyRail => ({
    index,
    head: endpoint(local.nodeId, match.head),
    worker: endpoint(peer.nodeId, match.worker),
  });
  return [makeRail(matches[0]!, 0), makeRail(matches[1]!, 1)];
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
  binding: DualSparkSshBindingObservation,
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
  const { headNodeId, workerNodeId } = output;
  if (
    typeof headNodeId !== "string" ||
    typeof workerNodeId !== "string" ||
    headNodeId === workerNodeId ||
    !SAFE_ID_PATTERN.test(headNodeId) ||
    !SAFE_ID_PATTERN.test(workerNodeId) ||
    [headNodeId, workerNodeId]
      .sort(compareStrings)
      .some((nodeId, index) => nodeId !== subjectNodeIds[index])
  ) {
    return "topology role nodes do not match its subject";
  }

  if (!Array.isArray(output.nodes) || output.nodes.length !== 2) {
    return "topology nodes are invalid";
  }
  const nodes = output.nodes.map(record);
  const head = nodes[0];
  const worker = nodes[1];
  if (
    !head ||
    !worker ||
    head.role !== "head" ||
    head.nodeId !== headNodeId ||
    worker.role !== "worker" ||
    worker.nodeId !== workerNodeId ||
    typeof head.gpuId !== "string" ||
    !SAFE_ID_PATTERN.test(head.gpuId) ||
    typeof worker.gpuId !== "string" ||
    !SAFE_ID_PATTERN.test(worker.gpuId) ||
    head.gpuId === worker.gpuId
  ) {
    return "topology node roles or GPU identities are invalid";
  }

  if (!Array.isArray(output.rails) || output.rails.length !== 2) {
    return "topology rails are invalid";
  }
  const rails: DualSparkTopologyRail[] = [];
  for (const [index, value] of output.rails.entries()) {
    const rail = record(value);
    if (!rail || rail.index !== index) return "topology rail indexes are invalid";
    const headError = artifactEndpointError(rail.head, headNodeId);
    const workerError = artifactEndpointError(rail.worker, workerNodeId);
    if (headError || workerError) return headError ?? workerError;
    const typedRail = rail as unknown as DualSparkTopologyRail;
    if (
      typedRail.head.address !== typedRail.worker.peerAddress ||
      typedRail.worker.address !== typedRail.head.peerAddress ||
      typedRail.head.prefixLength !== typedRail.worker.prefixLength
    ) {
      return "topology rail addresses are not reciprocal";
    }
    rails.push(typedRail);
  }
  if (
    new Set(rails.flatMap(({ head, worker }) => [head.address, worker.address])).size !== 4 ||
    new Set(rails.map(({ head }) => head.netdev)).size !== 2 ||
    new Set(rails.map(({ worker }) => worker.netdev)).size !== 2
  ) {
    return "topology rail identities are not distinct";
  }
  if (output.masterAddress !== rails[0]!.head.address) {
    return "topology master address does not match the primary head rail";
  }

  const peer = record(output.peer);
  if (
    !peer ||
    typeof peer.target !== "string" ||
    !validSshTarget(peer.target) ||
    typeof peer.sshBindingHandle !== "string" ||
    !SAFE_BINDING_HANDLE_PATTERN.test(peer.sshBindingHandle)
  ) {
    return "topology peer binding is invalid";
  }
  return undefined;
}

export function dualSparkTopologySubjectDigest(subjectNodeIds: readonly string[]): string {
  return managedInferenceDigest([...subjectNodeIds].sort(compareStrings));
}

export function dualSparkTopologyOutputDigest(output: DualSparkTopologyOutput): string {
  return managedInferenceDigest(output);
}

export function getDualSparkTopologyArtifactError(
  artifact: ManagedInferenceTopologyQualification<unknown>,
  expectedSubjectNodeIds?: readonly string[],
): string | undefined {
  if (
    artifact.id !== DUAL_SPARK_TOPOLOGY_ID ||
    artifact.schemaVersion !== DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION
  ) {
    return "topology qualification identity is incompatible";
  }
  if (artifact.status !== "qualified") return "topology qualification is not qualified";
  if (!Array.isArray(artifact.subjectNodeIds)) return "topology qualification subject is invalid";
  const subjectNodeIds = [...artifact.subjectNodeIds];
  if (
    subjectNodeIds.length !== 2 ||
    new Set(subjectNodeIds).size !== 2 ||
    subjectNodeIds.some((nodeId) => !SAFE_ID_PATTERN.test(nodeId)) ||
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
    if (artifact.subjectDigest !== dualSparkTopologySubjectDigest(subjectNodeIds)) {
      return "topology qualification subject digest does not match its subject";
    }
    if (
      artifact.outputDigest !==
      dualSparkTopologyOutputDigest(artifact.output as DualSparkTopologyOutput)
    ) {
      return "topology qualification output digest does not match its output";
    }
  } catch {
    return "topology qualification digest is invalid";
  }
  return undefined;
}

export function qualifyDualSparkTopology(
  input: Readonly<DualSparkTopologyQualificationInput>,
): DualSparkTopologyQualificationResult {
  if (input.peers.length !== 1) {
    return failure(input.intent, {
      code: "peer-count",
      message: "Automatic dual-node activation requires exactly one discovered DGX Spark peer.",
    });
  }

  const evaluatedAtMs = validateQualificationPolicy(input.evaluatedAt, input.maxReadinessAgeMs);
  if (typeof evaluatedAtMs !== "number") return failure(input.intent, evaluatedAtMs);

  const peer = input.peers[0]!;
  const localNode = validateNode(input.local, evaluatedAtMs, input.maxReadinessAgeMs);
  if ("code" in localNode) return failure(input.intent, localNode);
  const peerNode = validateNode(peer, evaluatedAtMs, input.maxReadinessAgeMs);
  if ("code" in peerNode) return failure(input.intent, peerNode);

  if (input.local.nodeId === peer.nodeId) {
    return failure(input.intent, {
      code: "duplicate-node-identity",
      message: "The two DGX Spark observations refer to the same node identity.",
    });
  }
  if (localNode.gpuId === peerNode.gpuId) {
    return failure(input.intent, {
      code: "duplicate-gpu-identity",
      message: "The two DGX Spark observations refer to the same GPU identity.",
    });
  }

  const sshFailure = validateSshBinding(peer.sshBinding, input.local.nodeId, peer.nodeId);
  if (sshFailure) return failure(input.intent, sshFailure);
  const rails = matchRails(input.local, peer);
  if ("code" in rails) return failure(input.intent, rails);

  const output: DualSparkTopologyOutput = {
    headNodeId: input.local.nodeId,
    workerNodeId: peer.nodeId,
    nodes: [
      { nodeId: input.local.nodeId, gpuId: localNode.gpuId, role: "head" },
      { nodeId: peer.nodeId, gpuId: peerNode.gpuId, role: "worker" },
    ],
    rails,
    masterAddress: rails[0].head.address,
    peer: {
      target: peer.sshBinding.peerTarget,
      sshBindingHandle: peer.sshBinding.handle,
    },
  };
  const subjectNodeIds = [input.local.nodeId, peer.nodeId].sort();
  try {
    return {
      outcome: "qualified",
      artifact: {
        id: DUAL_SPARK_TOPOLOGY_ID,
        schemaVersion: DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
        status: "qualified",
        subjectNodeIds,
        subjectDigest: dualSparkTopologySubjectDigest(subjectNodeIds),
        outputDigest: dualSparkTopologyOutputDigest(output),
        output,
      },
    };
  } catch {
    return failure(input.intent, {
      code: "artifact-digest-failed",
      message: "The qualified topology could not be bound to its subject and output.",
    });
  }
}
