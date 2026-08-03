// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SystemReadinessReport } from "../../readiness/types.js";
import {
  DUAL_SPARK_TOPOLOGY_ID,
  DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
  type DualSparkNodeObservation,
  type DualSparkPeerObservation,
  type DualSparkRailObservation,
  type DualSparkTopologyQualificationInput,
  qualifyDualSparkTopology,
} from "./dual-spark-topology.js";

const EVALUATED_AT = "2026-08-02T18:00:00.000Z";
const READINESS_OBSERVED_AT = "2026-08-02T17:59:30.000Z";
const REQUIRED_CAPABILITIES = [
  "host.platform.supported",
  "host.platform.dgx_spark",
  "host.docker.available",
  "host.docker.daemon_reachable",
  "host.docker.runtime_supported",
  "host.docker.storage_compatible",
  "host.gpu.nvidia_available",
  "host.gpu.container_toolkit_available",
  "host.gpu.cdi_healthy",
] as const;

function readiness(overrides: Partial<SystemReadinessReport> = {}): SystemReadinessReport {
  const base = {
    schemaVersion: "1.1.0",
    mutated: false,
    provenance: {
      nemoclawVersion: "0.1.0",
      sourceRevision: "1d6948d89b46eab739728215f9a19ef40b8f6121",
      observedAt: READINESS_OBSERVED_AT,
    },
    observations: [],
    capabilities: REQUIRED_CAPABILITIES.map((id) => ({
      id,
      state: "present" as const,
    })),
    qualifications: [
      {
        id: "host.platform.dgx_spark",
        status: "qualified" as const,
        capabilityIds: ["host.platform.dgx_spark"],
      },
    ],
    findings: [],
    evidence: [],
    status: "supported" as const,
    exitCode: 0 as const,
  } satisfies SystemReadinessReport;
  return { ...base, ...overrides } as SystemReadinessReport;
}

function rail(
  node: "head" | "worker",
  index: 0 | 1,
  overrides: Partial<DualSparkRailObservation> = {},
): DualSparkRailObservation {
  const headAddress = `192.168.${100 + index}.10`;
  const workerAddress = `192.168.${100 + index}.11`;
  const isHead = node === "head";
  return {
    adapter: "connectx-7",
    path: "direct",
    physicalPortId: isHead ? "cx7-left-head" : "cx7-left-worker",
    netdev: index === 0 ? "enp1s0f0np0" : "enP2p1s0f0np0",
    hcaDevice: index === 0 ? "rocep1s0f0" : "roceP2p1s0f0",
    hcaPort: 1,
    address: isHead ? headAddress : workerAddress,
    prefixLength: 24,
    peerNodeId: isHead ? "spark-worker" : "spark-head",
    peerAddress: isHead ? workerAddress : headAddress,
    linkState: "up",
    connectivity: "reachable",
    roceGid: {
      state: "resolved",
      index: index === 0 ? 5 : 7,
      value: isHead ? `fe80::${10 + index}` : `fe80::${20 + index}`,
    },
    ...overrides,
  };
}

function localNode(): DualSparkNodeObservation {
  return {
    nodeId: "spark-head",
    gpuIds: ["GPU-head"],
    readiness: readiness(),
    runtimeState: "clear",
    rails: [rail("head", 1), rail("head", 0)],
  };
}

function peerNode(index = 0): DualSparkPeerObservation {
  const suffix = index === 0 ? "" : `-${index}`;
  return {
    nodeId: `spark-worker${suffix}`,
    gpuIds: [`GPU-worker${suffix}`],
    readiness: readiness(),
    runtimeState: "clear",
    rails:
      index === 0
        ? [rail("worker", 0), rail("worker", 1)]
        : [
            rail("worker", 0, { peerNodeId: "spark-head" }),
            rail("worker", 1, { peerNodeId: "spark-head" }),
          ],
    sshBinding: {
      state: "pretrusted",
      fromNodeId: "spark-head",
      toNodeId: `spark-worker${suffix}`,
      peerTarget: `spark-worker${suffix}.local`,
      handle: `ssh-binding:worker${suffix || "-0"}`,
    },
  };
}

function qualificationInput(
  peers: readonly DualSparkPeerObservation[] = [peerNode()],
): DualSparkTopologyQualificationInput {
  return {
    intent: "automatic",
    evaluatedAt: EVALUATED_AT,
    maxReadinessAgeMs: 60_000,
    local: localNode(),
    peers,
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("dual DGX Spark topology qualification", () => {
  it("returns no match when discovery finds no peer", () => {
    expect(qualifyDualSparkTopology(qualificationInput([]))).toMatchObject({
      outcome: "no-match",
      code: "peer-count",
    });
  });

  it("qualifies one peer as a two-node direct ConnectX-7 topology", () => {
    const result = qualifyDualSparkTopology(qualificationInput());

    expect(result.outcome).toBe("qualified");
    const qualified = result as Extract<typeof result, { outcome: "qualified" }>;
    expect(qualified.artifact).toMatchObject({
      id: DUAL_SPARK_TOPOLOGY_ID,
      schemaVersion: DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
      status: "qualified",
      subjectNodeIds: ["spark-head", "spark-worker"],
      output: {
        headNodeId: "spark-head",
        workerNodeId: "spark-worker",
        masterAddress: "192.168.100.10",
        peer: {
          target: "spark-worker.local",
          sshBindingHandle: "ssh-binding:worker-0",
        },
      },
    });
    expect(qualified.artifact.subjectDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(qualified.artifact.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(qualified.artifact.output.nodes).toEqual([
      { nodeId: "spark-head", gpuId: "GPU-head", role: "head" },
      { nodeId: "spark-worker", gpuId: "GPU-worker", role: "worker" },
    ]);
    expect(qualified.artifact.output.rails).toHaveLength(2);
    expect(qualified.artifact.output.rails.map(({ head }) => head.netdev)).toEqual([
      "enp1s0f0np0",
      "enP2p1s0f0np0",
    ]);
    expect(qualified.artifact.output.rails[0]).toMatchObject({
      index: 0,
      head: {
        hcaDevice: "rocep1s0f0",
        address: "192.168.100.10",
        peerAddress: "192.168.100.11",
        roceGid: { index: 5, value: "fe80::10" },
      },
      worker: {
        hcaDevice: "rocep1s0f0",
        address: "192.168.100.11",
        peerAddress: "192.168.100.10",
        roceGid: { index: 5, value: "fe80::20" },
      },
    });
  });

  it("returns no match when discovery finds two peers", () => {
    expect(qualifyDualSparkTopology(qualificationInput([peerNode(), peerNode(1)]))).toMatchObject({
      outcome: "no-match",
      code: "peer-count",
    });
  });

  it("returns a strict error when discovery finds more than two peers", () => {
    const input = qualificationInput([peerNode(), peerNode(1), peerNode(2)]);
    input.intent = "explicit";

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "error",
      code: "peer-count",
    });
  });

  it("returns a strict error for a resume topology mismatch", () => {
    const input = qualificationInput([]);
    input.intent = "resume";

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "error",
      code: "peer-count",
    });
  });

  it.each([
    {
      name: "an incompatible schema",
      mutate: (report: SystemReadinessReport) => {
        report.schemaVersion = "2.0.0";
      },
      code: "readiness-schema-incompatible",
    },
    {
      name: "a stale observation",
      mutate: (report: SystemReadinessReport) => {
        report.provenance.observedAt = "2026-08-02T17:58:00.000Z";
      },
      code: "readiness-stale",
    },
    {
      name: "an inconclusive result",
      mutate: (report: SystemReadinessReport) => {
        Object.assign(report, { status: "inconclusive", exitCode: 3 });
      },
      code: "readiness-inconclusive",
    },
    {
      name: "an incompatible result",
      mutate: (report: SystemReadinessReport) => {
        Object.assign(report, { status: "incompatible", exitCode: 2 });
      },
      code: "readiness-incompatible",
    },
    {
      name: "no Spark qualification",
      mutate: (report: SystemReadinessReport) => {
        report.qualifications = [];
      },
      code: "spark-qualification-unavailable",
    },
    {
      name: "an unknown Spark qualification",
      mutate: (report: SystemReadinessReport) => {
        report.qualifications = [
          {
            id: "host.platform.dgx_spark",
            status: "unknown",
            capabilityIds: [],
          },
        ];
      },
      code: "spark-qualification-unavailable",
    },
  ])("fails closed for $name", ({ mutate, code }) => {
    const input = qualificationInput();
    mutate(input.peers[0]!.readiness);

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it("leaves serving runtime capability policy to preset resolution", () => {
    const input = qualificationInput();
    input.peers[0]!.readiness.capabilities = input.peers[0]!.readiness.capabilities.map(
      (capability) =>
        capability.id === "host.docker.runtime_supported"
          ? { ...capability, state: "unknown" }
          : capability,
    );

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "qualified",
    });
  });

  it.each([
    {
      name: "the same node identity",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.peers[0]!.nodeId = input.local.nodeId;
        input.peers[0]!.sshBinding.toNodeId = input.local.nodeId;
      },
      code: "duplicate-node-identity",
    },
    {
      name: "the same GPU identity",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.peers[0]!.gpuIds = input.local.gpuIds;
      },
      code: "duplicate-gpu-identity",
    },
    {
      name: "more than one local GPU identity",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.local.gpuIds = ["GPU-head", "GPU-extra"];
      },
      code: "gpu-identity-unavailable",
    },
  ])("rejects $name", ({ mutate, code }) => {
    const input = qualificationInput();
    mutate(input);

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it.each([
    { state: "conflict" as const, code: "runtime-conflict" },
    { state: "unknown" as const, code: "runtime-state-unknown" },
  ])("does not replace a peer runtime in the $state state", ({ state, code }) => {
    const input = qualificationInput();
    input.peers[0]!.runtimeState = state;

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it.each([
    {
      name: "one logical rail",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.local.rails = input.local.rails.slice(0, 1);
      },
      code: "fabric-degraded",
    },
    {
      name: "three logical rails",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.local.rails = [...input.local.rails, rail("head", 0, { netdev: "extra0" })];
      },
      code: "fabric-multiple",
    },
    {
      name: "two physical ports",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.local.rails[1]!.physicalPortId = "cx7-right-head";
      },
      code: "fabric-multiple",
    },
    {
      name: "a switched path",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.local.rails[0]!.path = "switched";
      },
      code: "fabric-degraded",
    },
    {
      name: "an unreachable peer address",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.peers[0]!.rails[0]!.connectivity = "unreachable";
      },
      code: "fabric-degraded",
    },
    {
      name: "nonreciprocal addresses",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.peers[0]!.rails[0]!.peerAddress = "192.168.100.99";
      },
      code: "fabric-mismatch",
    },
    {
      name: "an unresolved RoCE GID",
      mutate: (input: DualSparkTopologyQualificationInput) => {
        input.local.rails[0]!.roceGid = { state: "unknown" };
      },
      code: "fabric-degraded",
    },
  ])("rejects a fabric with $name", ({ mutate, code }) => {
    const input = qualificationInput();
    mutate(input);

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it("rejects a peer without an opaque pretrusted SSH binding", () => {
    const input = qualificationInput();
    input.peers[0]!.sshBinding.state = "untrusted";
    input.peers[0]!.sshBinding.handle = "not-an-opaque-binding";

    expect(qualifyDualSparkTopology(input)).toMatchObject({
      outcome: "no-match",
      code: "ssh-binding-unavailable",
    });
  });

  it("produces the same artifact for either injected rail order", () => {
    const firstInput = qualificationInput();
    const secondInput = clone(firstInput);
    secondInput.local.rails = [...secondInput.local.rails].reverse();
    secondInput.peers[0]!.rails = [...secondInput.peers[0]!.rails].reverse();

    const first = qualifyDualSparkTopology(firstInput);
    const second = qualifyDualSparkTopology(secondInput);
    expect(first.outcome).toBe("qualified");
    expect(second.outcome).toBe("qualified");
    const firstQualified = first as Extract<typeof first, { outcome: "qualified" }>;
    const secondQualified = second as Extract<typeof second, { outcome: "qualified" }>;
    expect(secondQualified.artifact).toEqual(firstQualified.artifact);
  });
});
