// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadManagedInferenceCatalog } from "./catalog.js";
import type { ResolvedManagedInferenceSelection } from "./catalog-types.js";
import {
  type ManagedClusterVllmPlan,
  materializeManagedClusterVllmPlan,
} from "./managed-cluster-materialize.js";
import {
  type ManagedClusterTopologyOutput,
  managedClusterTopologyOutputDigest,
  managedClusterTopologySubjectDigest,
} from "./managed-cluster-topology.js";

export const FIXTURE_MANAGED_CLUSTER_PRESET_ID = "vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731";

export function fixtureManagedClusterSelection(): ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput> {
  const catalog = loadManagedInferenceCatalog();
  const compiledPreset = catalog.presets.find(
    ({ definition }) => definition.metadata.id === FIXTURE_MANAGED_CLUSTER_PRESET_ID,
  );
  const compiledRecipe = catalog.recipes.find(
    ({ definition }) => definition.metadata.id === compiledPreset?.definition.spec.plan.recipeRef,
  );
  if (!compiledPreset || !compiledRecipe) {
    throw new Error("managed inference fixture catalog is incomplete");
  }
  const preset = structuredClone(compiledPreset.definition);
  const recipe = structuredClone(compiledRecipe.definition);
  const subjectNodeIds = ["spark-head", "spark-worker"] as const;
  const output: ManagedClusterTopologyOutput = {
    controllerNodeId: "spark-head",
    nodes: [
      { nodeId: "spark-head", gpuId: "GPU-head", rank: 0, role: "head" },
      { nodeId: "spark-worker", gpuId: "GPU-worker", rank: 1, role: "worker" },
    ],
    rails: [
      {
        index: 0,
        endpoints: [
          {
            nodeId: "spark-head",
            netdev: "enp1s0f0np0",
            hcaDevice: "rocep1s0f0",
            hcaPort: 1,
            address: "192.168.100.10",
            prefixLength: 24,
            peerAddress: "192.168.100.11",
            roceGid: { index: 3, value: "::ffff:c0a8:640a" },
          },
          {
            nodeId: "spark-worker",
            netdev: "enp1s0f1np1",
            hcaDevice: "rocep1s0f1",
            hcaPort: 1,
            address: "192.168.100.11",
            prefixLength: 24,
            peerAddress: "192.168.100.10",
            roceGid: { index: 6, value: "::ffff:c0a8:640b" },
          },
        ],
      },
      {
        index: 1,
        endpoints: [
          {
            nodeId: "spark-head",
            netdev: "enP2p1s0f0np0",
            hcaDevice: "roceP2p1s0f0",
            hcaPort: 1,
            address: "192.168.101.10",
            prefixLength: 24,
            peerAddress: "192.168.101.11",
            roceGid: { index: 4, value: "::ffff:c0a8:650a" },
          },
          {
            nodeId: "spark-worker",
            netdev: "enP2p1s0f1np1",
            hcaDevice: "roceP2p1s0f1",
            hcaPort: 1,
            address: "192.168.101.11",
            prefixLength: 24,
            peerAddress: "192.168.101.10",
            roceGid: { index: 7, value: "::ffff:c0a8:650b" },
          },
        ],
      },
    ],
    masterAddress: "192.168.100.10",
    peers: [
      {
        nodeId: "spark-worker",
        target: "spark-worker.local",
        sshBindingHandle: "state/managed-cluster/peer",
      },
    ],
  };
  return {
    outcome: "selected",
    selection: "automatic",
    catalogDigest: catalog.catalogDigest,
    presetDigest: compiledPreset.definitionDigest,
    recipeDigest: compiledRecipe.definitionDigest,
    preset,
    recipe,
    topologyQualification: {
      id: "host-cluster.direct-cx7",
      schemaVersion: 1,
      status: "qualified",
      subjectNodeIds,
      subjectDigest: managedClusterTopologySubjectDigest(subjectNodeIds),
      outputDigest: managedClusterTopologyOutputDigest(output),
      output,
    },
  };
}

export function fixtureManagedClusterPlan(): ManagedClusterVllmPlan {
  return materializeManagedClusterVllmPlan(fixtureManagedClusterSelection());
}
