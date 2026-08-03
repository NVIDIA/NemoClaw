// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadManagedInferenceCatalog } from "./catalog.js";
import type { ResolvedManagedInferenceSelection } from "./catalog-types.js";
import { type DualSparkVllmPlan, materializeDualSparkVllmPlan } from "./dual-spark-materialize.js";
import {
  type DualSparkTopologyOutput,
  dualSparkTopologyOutputDigest,
  dualSparkTopologySubjectDigest,
} from "./dual-spark-topology.js";

export const FIXTURE_DUAL_SPARK_PRESET_ID = "vllm.dgx-spark-gb10.dual.deepseek-v4-flash-0731";

export function fixtureDualSparkSelection(): ResolvedManagedInferenceSelection<DualSparkTopologyOutput> {
  const catalog = loadManagedInferenceCatalog();
  const compiledPreset = catalog.presets.find(
    ({ definition }) => definition.metadata.id === FIXTURE_DUAL_SPARK_PRESET_ID,
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
  const output: DualSparkTopologyOutput = {
    headNodeId: "spark-head",
    workerNodeId: "spark-worker",
    nodes: [
      { nodeId: "spark-head", gpuId: "GPU-head", role: "head" },
      { nodeId: "spark-worker", gpuId: "GPU-worker", role: "worker" },
    ],
    rails: [
      {
        index: 0,
        head: {
          nodeId: "spark-head",
          netdev: "enp1s0f0np0",
          hcaDevice: "rocep1s0f0",
          hcaPort: 1,
          address: "192.168.100.10",
          prefixLength: 24,
          peerAddress: "192.168.100.11",
          roceGid: { index: 3, value: "::ffff:c0a8:640a" },
        },
        worker: {
          nodeId: "spark-worker",
          netdev: "enp1s0f1np1",
          hcaDevice: "rocep1s0f1",
          hcaPort: 1,
          address: "192.168.100.11",
          prefixLength: 24,
          peerAddress: "192.168.100.10",
          roceGid: { index: 6, value: "::ffff:c0a8:640b" },
        },
      },
      {
        index: 1,
        head: {
          nodeId: "spark-head",
          netdev: "enP2p1s0f0np0",
          hcaDevice: "roceP2p1s0f0",
          hcaPort: 1,
          address: "192.168.101.10",
          prefixLength: 24,
          peerAddress: "192.168.101.11",
          roceGid: { index: 4, value: "::ffff:c0a8:650a" },
        },
        worker: {
          nodeId: "spark-worker",
          netdev: "enP2p1s0f1np1",
          hcaDevice: "roceP2p1s0f1",
          hcaPort: 1,
          address: "192.168.101.11",
          prefixLength: 24,
          peerAddress: "192.168.101.10",
          roceGid: { index: 7, value: "::ffff:c0a8:650b" },
        },
      },
    ],
    masterAddress: "192.168.100.10",
    peer: { target: "spark-worker.local", sshBindingHandle: "state/dual-spark/peer" },
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
      id: "dgx-spark.gb10.dual-cx7",
      schemaVersion: 1,
      status: "qualified",
      subjectNodeIds,
      subjectDigest: dualSparkTopologySubjectDigest(subjectNodeIds),
      outputDigest: dualSparkTopologyOutputDigest(output),
      output,
    },
  };
}

export function fixtureDualSparkPlan(): DualSparkVllmPlan {
  return materializeDualSparkVllmPlan(fixtureDualSparkSelection());
}
