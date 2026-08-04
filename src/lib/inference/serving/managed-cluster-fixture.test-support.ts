// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { MANAGED_CLUSTER_VLLM_MATERIALIZER_REF } from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import { managedInferenceDigest } from "./catalog-integrity.js";
import type { ResolvedManagedInferenceSelection } from "./types.js";
import {
  type ManagedClusterVllmPlan,
  materializeManagedClusterVllmPlan,
} from "./managed-cluster-materialize.js";
import {
  MANAGED_CLUSTER_TOPOLOGY_ID,
  MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
  type ManagedClusterTopologyOutput,
  managedClusterTopologyOutputDigest,
  managedClusterTopologySubjectDigest,
} from "./managed-cluster-topology.js";

function fixtureCatalogDefinitions() {
  const catalog = loadManagedInferenceCatalog();
  for (const compiledPreset of catalog.presets) {
    const compiledRecipe = catalog.recipes.find(
      ({ metadata }) => metadata.id === compiledPreset.spec.plan.recipeRef,
    );
    if (compiledRecipe?.spec.execution.materializerRef === MANAGED_CLUSTER_VLLM_MATERIALIZER_REF) {
      return { catalog, compiledPreset, compiledRecipe };
    }
  }
  throw new Error("managed inference fixture catalog is incomplete");
}

export const FIXTURE_MANAGED_CLUSTER_PRESET_ID =
  fixtureCatalogDefinitions().compiledPreset.metadata.id;

export function fixtureManagedClusterSelection(): ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput> {
  const { catalog, compiledPreset, compiledRecipe } = fixtureCatalogDefinitions();
  const preset = structuredClone(compiledPreset);
  const recipe = structuredClone(compiledRecipe);
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
    presetDigest: managedInferenceDigest(compiledPreset),
    recipeDigest: managedInferenceDigest(compiledRecipe),
    preset,
    recipe,
    topologyQualification: {
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

export function fixtureManagedClusterPlan(): ManagedClusterVllmPlan {
  return materializeManagedClusterVllmPlan(fixtureManagedClusterSelection());
}
