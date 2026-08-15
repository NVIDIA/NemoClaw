// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SystemReadinessReport } from "../../readiness/types.js";
import {
  MANAGED_CLUSTER_TOPOLOGY_ID,
  MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
  type ManagedClusterNodeObservation,
  type ManagedClusterPeerObservation,
  type ManagedClusterRailObservation,
  type ManagedClusterTopologyQualificationInput,
  qualifyManagedClusterTopology,
} from "./managed-cluster-topology.js";

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

function remediableStorageReadiness(): SystemReadinessReport {
  const base = readiness();
  return {
    ...base,
    capabilities: [
      ...base.capabilities.map((capability) =>
        capability.id === "host.docker.storage_compatible"
          ? { ...capability, state: "absent" as const }
          : capability,
      ),
      { id: "host.docker.storage_remediation_available", state: "present" as const },
    ],
    findings: [
      {
        id: "host.docker.storage_incompatible",
        severity: "blocking" as const,
        summary: "The Docker storage configuration cannot support nested overlay mounts.",
        capabilityIds: ["host.docker.storage_compatible"],
      },
    ],
    status: "incompatible",
    exitCode: 2,
  } as SystemReadinessReport;
}

function rail(
  node: "head" | "worker",
  index: 0 | 1,
  overrides: Partial<ManagedClusterRailObservation> = {},
): ManagedClusterRailObservation {
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

function localNode(): ManagedClusterNodeObservation {
  return {
    nodeId: "spark-head",
    gpuIds: ["GPU-head"],
    readiness: readiness(),
    runtimeState: "clear",
    rails: [rail("head", 1), rail("head", 0)],
  };
}

function peerNode(index = 0): ManagedClusterPeerObservation {
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
  peers: readonly ManagedClusterPeerObservation[] = [peerNode()],
): ManagedClusterTopologyQualificationInput {
  return {
    intent: "automatic",
    evaluatedAt: EVALUATED_AT,
    maxReadinessAgeMs: 60_000,
    local: localNode(),
    peers,
  };
}

function ringRail(
  nodeId: string,
  peerNodeId: string,
  subnet: number,
  addressHost: number,
  peerHost: number,
  index: number,
): ManagedClusterRailObservation {
  return {
    adapter: "connectx-7",
    path: "direct",
    physicalPortId: `cx7-${nodeId}`,
    netdev: `eth${String(index)}`,
    hcaDevice: `roce${String(index)}`,
    hcaPort: 1,
    address: `192.168.${String(subnet)}.${String(addressHost)}`,
    prefixLength: 30,
    peerNodeId,
    peerAddress: `192.168.${String(subnet)}.${String(peerHost)}`,
    linkState: "up",
    connectivity: "reachable",
    roceGid: {
      state: "resolved",
      index: 3 + index,
      value: `fe80::${String(subnet)}:${String(addressHost)}`,
    },
  };
}

function threeNodeQualificationInput(): ManagedClusterTopologyQualificationInput {
  const input = qualificationInput();
  input.local.rails = [
    ringRail("spark-head", "spark-worker-a", 100, 1, 2, 0),
    ringRail("spark-head", "spark-worker-b", 102, 1, 2, 1),
  ];
  input.peers = [
    {
      ...peerNode(),
      nodeId: "spark-worker-a",
      gpuIds: ["GPU-worker-a"],
      rails: [
        ringRail("spark-worker-a", "spark-head", 100, 2, 1, 0),
        ringRail("spark-worker-a", "spark-worker-b", 101, 1, 2, 1),
      ],
      sshBinding: {
        state: "pretrusted",
        fromNodeId: "spark-head",
        toNodeId: "spark-worker-a",
        peerTarget: "spark-worker-a.local",
        handle: "ssh-binding:worker-a",
      },
    },
    {
      ...peerNode(),
      nodeId: "spark-worker-b",
      gpuIds: ["GPU-worker-b"],
      rails: [
        ringRail("spark-worker-b", "spark-worker-a", 101, 2, 1, 0),
        ringRail("spark-worker-b", "spark-head", 102, 2, 1, 1),
      ],
      sshBinding: {
        state: "pretrusted",
        fromNodeId: "spark-head",
        toNodeId: "spark-worker-b",
        peerTarget: "spark-worker-b.local",
        handle: "ssh-binding:worker-b",
      },
    },
  ];
  return input;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe("managed DGX Spark cluster topology qualification", () => {
  it("returns no match when discovery finds no peer", () => {
    expect(qualifyManagedClusterTopology(qualificationInput([]))).toMatchObject({
      outcome: "no-match",
      code: "peer-count",
    });
  });

  it("qualifies the profile-declared node set as a direct ConnectX-7 topology", () => {
    const result = qualifyManagedClusterTopology(qualificationInput());

    expect(result).toMatchObject({ outcome: "qualified" });
    const qualified = result as Extract<typeof result, { outcome: "qualified" }>;
    expect(qualified.artifact).toMatchObject({
      id: MANAGED_CLUSTER_TOPOLOGY_ID,
      schemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
      status: "qualified",
      subjectNodeIds: ["spark-head", "spark-worker"],
      output: {
        controllerNodeId: "spark-head",
        peers: [
          {
            nodeId: "spark-worker",
            target: "spark-worker.local",
            sshBindingHandle: "ssh-binding:worker-0",
          },
        ],
      },
    });
    expect(qualified.artifact.subjectDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(qualified.artifact.outputDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(qualified.artifact.output.nodes).toEqual([
      { nodeId: "spark-head", gpuId: "GPU-head", rank: 0, role: "head" },
      { nodeId: "spark-worker", gpuId: "GPU-worker", rank: 1, role: "worker" },
    ]);
    expect(qualified.artifact.output.rails).toHaveLength(2);
    expect(
      qualified.artifact.output.rails.flatMap(({ endpoints }) =>
        endpoints.map(({ nodeId }) => nodeId),
      ),
    ).toEqual(expect.arrayContaining(["spark-head", "spark-worker"]));
  });

  it("reports a fabric mismatch when two peers claim the same rail addresses", () => {
    expect(
      qualifyManagedClusterTopology(qualificationInput([peerNode(), peerNode(1)])),
    ).toMatchObject({
      outcome: "no-match",
      code: "fabric-mismatch",
    });
  });

  it("qualifies a three-node ring and assigns deterministic ranks", () => {
    const result = qualifyManagedClusterTopology(threeNodeQualificationInput());
    expect(result).toMatchObject({ outcome: "qualified" });
    const artifact = (result as Extract<typeof result, { outcome: "qualified" }>).artifact;
    expect(artifact.output.nodes).toEqual([
      { nodeId: "spark-head", gpuId: "GPU-head", rank: 0, role: "head" },
      { nodeId: "spark-worker-a", gpuId: "GPU-worker-a", rank: 1, role: "worker" },
      { nodeId: "spark-worker-b", gpuId: "GPU-worker-b", rank: 2, role: "worker" },
    ]);
    expect(artifact.output.rails).toHaveLength(3);
    expect(artifact.output.peers.map(({ nodeId }) => nodeId)).toEqual([
      "spark-worker-a",
      "spark-worker-b",
    ]);
  });

  it("reports strict fabric errors without a fixed peer-count branch", () => {
    const input = qualificationInput([peerNode(), peerNode(1), peerNode(2)]);
    input.intent = "explicit";

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "error",
      code: "fabric-mismatch",
    });
  });

  it("returns a strict error for a resume topology mismatch", () => {
    const input = qualificationInput([]);
    input.intent = "resume";

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
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

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it("qualifies nodes whose only blocking readiness finding has an available storage remediation", () => {
    const input = qualificationInput();
    input.local.readiness = remediableStorageReadiness();
    input.peers[0]!.readiness = remediableStorageReadiness();

    expect(qualifyManagedClusterTopology(input)).toMatchObject({ outcome: "qualified" });
  });

  it("fails closed when the storage conflict has no available remediation", () => {
    const input = qualificationInput();
    const report = remediableStorageReadiness();
    report.capabilities = report.capabilities.map((capability) =>
      capability.id === "host.docker.storage_remediation_available"
        ? { ...capability, state: "absent" as const }
        : capability,
    );
    input.peers[0]!.readiness = report;

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code: "readiness-incompatible",
    });
  });

  it("fails closed when another blocking readiness finding joins the remediable storage conflict", () => {
    const input = qualificationInput();
    const report = remediableStorageReadiness();
    report.findings = [
      ...report.findings,
      {
        id: "host.gpu.nvidia_runtime_missing",
        severity: "blocking" as const,
        summary: "Docker NVIDIA runtime support is missing for Jetson/Tegra sandbox GPU.",
        capabilityIds: ["host.gpu.container_toolkit_available"],
      },
    ];
    input.peers[0]!.readiness = report;

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code: "readiness-incompatible",
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

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "qualified",
    });
  });

  it.each([
    {
      name: "the same node identity",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.peers[0]!.nodeId = input.local.nodeId;
        input.peers[0]!.sshBinding.toNodeId = input.local.nodeId;
      },
      code: "duplicate-node-identity",
    },
    {
      name: "the same GPU identity",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.peers[0]!.gpuIds = input.local.gpuIds;
      },
      code: "duplicate-gpu-identity",
    },
    {
      name: "more than one local GPU identity",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.local.gpuIds = ["GPU-head", "GPU-extra"];
      },
      code: "gpu-identity-unavailable",
    },
  ])("rejects $name", ({ mutate, code }) => {
    const input = qualificationInput();
    mutate(input);

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
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

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it.each([
    {
      name: "one logical rail",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.local.rails = input.local.rails.slice(0, 1);
      },
      code: "fabric-degraded",
    },
    {
      name: "three logical rails",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.local.rails = [...input.local.rails, rail("head", 0, { netdev: "extra0" })];
      },
      code: "fabric-multiple",
    },
    {
      name: "two physical ports",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.local.rails[1]!.physicalPortId = "cx7-right-head";
      },
      code: "fabric-multiple",
    },
    {
      name: "a switched path",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.local.rails[0]!.path = "switched";
      },
      code: "fabric-degraded",
    },
    {
      name: "an unreachable peer address",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.peers[0]!.rails[0]!.connectivity = "unreachable";
      },
      code: "fabric-degraded",
    },
    {
      name: "nonreciprocal addresses",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.peers[0]!.rails[0]!.peerAddress = "192.168.100.99";
      },
      code: "fabric-mismatch",
    },
    {
      name: "an unresolved RoCE GID",
      mutate: (input: ManagedClusterTopologyQualificationInput) => {
        input.local.rails[0]!.roceGid = { state: "unknown" };
      },
      code: "fabric-degraded",
    },
  ])("rejects a fabric with $name", ({ mutate, code }) => {
    const input = qualificationInput();
    mutate(input);

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code,
    });
  });

  it.each([
    { target: "local" as const, nodeId: "spark-head", suffix: "head" },
    { target: "peer" as const, nodeId: "spark-worker", suffix: "worker" },
  ])("reports the $target node and sorted physical-port identities", ({
    target,
    nodeId,
    suffix,
  }) => {
    const input = qualificationInput();
    const node = target === "local" ? input.local : input.peers[0]!;
    node.rails[0]!.physicalPortId = `cx7-right-${suffix}`;
    node.rails[1]!.physicalPortId = `cx7-left-${suffix}`;

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code: "fabric-multiple",
      message: `The candidate logical rails on node ${nodeId} belong to more than one physical port: cx7-left-${suffix}, cx7-right-${suffix}.`,
    });
  });

  it("rejects a peer whose SSH binding state is not trusted", () => {
    const input = qualificationInput();
    input.peers[0]!.sshBinding.state = "untrusted";

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code: "ssh-binding-unavailable",
    });
  });

  it("rejects a peer whose trusted SSH binding handle is empty", () => {
    const input = qualificationInput();
    input.peers[0]!.sshBinding.handle = "   ";

    expect(qualifyManagedClusterTopology(input)).toMatchObject({
      outcome: "no-match",
      code: "ssh-binding-unavailable",
    });
  });

  it("produces the same artifact for either injected rail order", () => {
    const firstInput = qualificationInput();
    const secondInput = clone(firstInput);
    secondInput.local.rails = [...secondInput.local.rails].reverse();
    secondInput.peers[0]!.rails = [...secondInput.peers[0]!.rails].reverse();

    const first = qualifyManagedClusterTopology(firstInput);
    const second = qualifyManagedClusterTopology(secondInput);
    expect(first.outcome).toBe("qualified");
    expect(second.outcome).toBe("qualified");
    const firstQualified = first as Extract<typeof first, { outcome: "qualified" }>;
    const secondQualified = second as Extract<typeof second, { outcome: "qualified" }>;
    expect(secondQualified.artifact).toEqual(firstQualified.artifact);
  });
});
