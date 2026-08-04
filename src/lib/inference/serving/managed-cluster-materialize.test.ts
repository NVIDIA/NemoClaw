// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  NO_PREPARATION_REF,
  SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
} from "./adapter-registry.js";
import { managedInferenceDigest } from "./catalog-integrity.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import { fixtureManagedClusterSelection } from "./managed-cluster-fixture.test-support.js";
import {
  MANAGED_CLUSTER_PRESET_LABEL,
  MANAGED_CLUSTER_RECIPE_LABEL,
  materializeManagedClusterVllmPlan,
} from "./managed-cluster-materialize.js";
import {
  type ManagedClusterTopologyOutput,
  managedClusterTopologyOutputDigest,
  managedClusterTopologySubjectDigest,
} from "./managed-cluster-topology.js";
import type {
  CompiledManagedInferenceCatalog,
  ManagedInferenceServingPreset,
  ManagedInferenceServingRecipe,
  ResolvedManagedInferenceSelection,
} from "./types.js";

interface SyntheticProfile {
  readonly catalog: CompiledManagedInferenceCatalog;
  readonly selection: ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>;
}

function selectionWithDigests(): ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput> {
  const selection = fixtureManagedClusterSelection();
  return {
    ...selection,
    presetDigest: managedInferenceDigest(selection.preset),
    recipeDigest: managedInferenceDigest(selection.recipe),
  };
}

function threeNodeTopology(): ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>["topologyQualification"] {
  const endpoint = (nodeId: string, peerAddress: string, address: string, index: number) => ({
    nodeId,
    netdev: `eth${String(index)}`,
    hcaDevice: `roce${String(index)}`,
    hcaPort: 1,
    address,
    prefixLength: 30,
    peerAddress,
    roceGid: { index: 3 + index, value: `fe80::${address.replaceAll(".", ":")}` },
  });
  const output: ManagedClusterTopologyOutput = {
    controllerNodeId: "spark-head",
    nodes: [
      { nodeId: "spark-head", gpuId: "GPU-head", rank: 0, role: "head" },
      { nodeId: "spark-worker-a", gpuId: "GPU-worker-a", rank: 1, role: "worker" },
      { nodeId: "spark-worker-b", gpuId: "GPU-worker-b", rank: 2, role: "worker" },
    ],
    rails: [
      {
        index: 0,
        endpoints: [
          endpoint("spark-head", "192.168.100.2", "192.168.100.1", 0),
          endpoint("spark-worker-a", "192.168.100.1", "192.168.100.2", 0),
        ],
      },
      {
        index: 1,
        endpoints: [
          endpoint("spark-worker-a", "192.168.101.2", "192.168.101.1", 1),
          endpoint("spark-worker-b", "192.168.101.1", "192.168.101.2", 0),
        ],
      },
      {
        index: 2,
        endpoints: [
          endpoint("spark-head", "192.168.102.2", "192.168.102.1", 1),
          endpoint("spark-worker-b", "192.168.102.1", "192.168.102.2", 1),
        ],
      },
    ],
    masterAddress: "192.168.100.1",
    peers: [
      { nodeId: "spark-worker-a", target: "worker-a.local", sshBindingHandle: "binding-a" },
      { nodeId: "spark-worker-b", target: "worker-b.local", sshBindingHandle: "binding-b" },
    ],
  };
  const subjectNodeIds = output.nodes.map(({ nodeId }) => nodeId);
  return {
    ...fixtureManagedClusterSelection().topologyQualification,
    subjectNodeIds,
    subjectDigest: managedClusterTopologySubjectDigest(subjectNodeIds),
    output,
    outputDigest: managedClusterTopologyOutputDigest(output),
  };
}

function syntheticSecondProfile(
  temporaryFilesystemTarget = "/dev/shm-scratch",
  nodeCount = 2,
): SyntheticProfile {
  const baseCatalog = loadManagedInferenceCatalog();
  const baseSelection = selectionWithDigests();
  const topology = nodeCount === 3 ? threeNodeTopology() : baseSelection.topologyQualification;
  const basePreset = baseCatalog.presets.find(
    ({ metadata }) => metadata.id === baseSelection.preset.metadata.id,
  );
  const baseRecipe = baseCatalog.recipes.find(
    ({ metadata }) => metadata.id === baseSelection.recipe.metadata.id,
  );
  expect(basePreset).toBeDefined();
  expect(baseRecipe).toBeDefined();
  const presetTemplate = basePreset as ManagedInferenceServingPreset;
  const recipeTemplate = baseRecipe as ManagedInferenceServingRecipe;

  const recipe: ManagedInferenceServingRecipe = {
    ...recipeTemplate,
    metadata: {
      id: "vllm.synthetic-model.managed-cluster.v1",
      displayName: "Synthetic model on a compatible cluster",
    },
    spec: {
      ...recipeTemplate.spec,
      model: {
        ...recipeTemplate.spec.model,
        id: "example-org/Synthetic-Model",
        revision: "b".repeat(40),
        servedName: "synthetic-model",
        downloadSizeBytes: 1_234_567,
        preparation: {
          ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
          snapshotCopy: {
            sourcePath: "assets/synthetic_tokenizer.py",
            digest: `sha256:${"4".repeat(64)}`,
            targetPath: "/opt/synthetic-vllm/tokenizers/copied.py",
          },
          exactTextReplacement: {
            targetPath: "/opt/synthetic-vllm/parsers/reasoning.py",
            expectedText: "MODE = 'legacy'",
            replacementText: "MODE = 'compatible'",
          },
        },
      },
      runtime: {
        ...recipeTemplate.spec.runtime,
        image: `registry.example.test/inference/vllm@sha256:${"c".repeat(64)}`,
        imageDownloadSizeBytes: 7_654_321,
        pullTimeoutSeconds: 7_200,
        sharedMemoryBytes: 8_589_934_592,
        gpuRequest: "device=all",
        devices: ["/dev/infiniband", "/dev/synthetic"],
        ulimits: { memlock: "unlimited", stackBytes: 33_554_432 },
        modelCache: { source: "huggingface-cache", target: "/models/cache" },
        temporaryFilesystems: [
          {
            target: temporaryFilesystemTarget,
            sizeBytes: 4_294_967_296,
            mode: "0700",
            options: ["rw", "nosuid", "nodev"],
          },
        ],
        environment: { SYNTHETIC_PROFILE: "enabled" },
      },
      execution: {
        ...recipeTemplate.spec.execution,
        nodeCount,
        tensorParallelSize: nodeCount,
      },
      serve: {
        ...recipeTemplate.spec.serve,
        executable: "/opt/vllm/bin/vllm",
        arguments: [
          { name: "--port", value: 9_001 },
          { name: "--max-model-len", value: 4_096 },
          { name: "--generation-config", value: "auto" },
        ],
      },
      readiness: { timeoutSeconds: 900, expectedModel: "synthetic-model" },
    },
  };
  const preset: ManagedInferenceServingPreset = {
    ...presetTemplate,
    metadata: {
      id: "vllm.synthetic-profile.managed-cluster",
      displayName: "Synthetic profile on a compatible cluster",
    },
    spec: {
      ...presetTemplate.spec,
      priority: 399,
      plan: { ...presetTemplate.spec.plan, recipeRef: recipe.metadata.id },
    },
  };
  const recipeDigest = managedInferenceDigest(recipe);
  const presetDigest = managedInferenceDigest(preset);
  const recipeSourceFile = "managed-inference/recipes/vllm.synthetic-model.managed-cluster.v1.yaml";
  const presetSourceFile = "managed-inference/presets/vllm.synthetic-profile.managed-cluster.yaml";
  const sources = [
    ...baseCatalog.sources,
    {
      path: presetSourceFile,
      kind: "ServingPreset" as const,
      id: preset.metadata.id,
      digest: presetDigest,
    },
    {
      path: recipeSourceFile,
      kind: "ServingRecipe" as const,
      id: recipe.metadata.id,
      digest: recipeDigest,
    },
  ];
  const catalogContents = {
    compilerVersion: baseCatalog.compilerVersion,
    presets: [...baseCatalog.presets, preset],
    recipes: [...baseCatalog.recipes, recipe],
    readinessSchemaRef: baseCatalog.readinessSchemaRef,
    schemaVersion: baseCatalog.schemaVersion,
    sources,
    sourceRevision: baseCatalog.sourceRevision,
  } as const;
  const catalog: CompiledManagedInferenceCatalog = {
    ...catalogContents,
    catalogDigest: managedInferenceDigest(catalogContents),
  };
  return {
    catalog,
    selection: {
      outcome: "selected",
      selection: "automatic",
      catalogDigest: catalog.catalogDigest,
      presetDigest,
      recipeDigest,
      preset,
      recipe,
      topologyQualification: topology,
    },
  };
}

describe("managed-cluster vLLM materializer", () => {
  it("creates deterministic plans entirely from the selected catalog definitions", () => {
    const selection = selectionWithDigests();
    const plan = materializeManagedClusterVllmPlan(selection);
    const recipe = selection.recipe.spec;

    expect(materializeManagedClusterVllmPlan(selection)).toEqual(plan);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan).toMatchObject({
      catalogDigest: selection.catalogDigest,
      presetId: selection.preset.metadata.id,
      presetDigest: selection.presetDigest,
      recipeId: selection.recipe.metadata.id,
      recipeDigest: selection.recipeDigest,
      model: {
        id: recipe.model.id,
        revision: recipe.model.revision,
        servedName: recipe.model.servedName,
      },
      authentication: recipe.serve.authentication,
      readiness: {
        timeoutMs: recipe.readiness.timeoutSeconds * 1_000,
        expectedModel: recipe.readiness.expectedModel,
      },
    });
    expect(plan.roles[0]).toMatchObject({
      image: recipe.runtime.image,
      runtime: {
        architecture: recipe.runtime.architecture,
        networkMode: recipe.runtime.networkMode,
        ipcMode: recipe.runtime.ipcMode,
        sharedMemoryBytes: recipe.runtime.sharedMemoryBytes,
        gpuRequest: recipe.runtime.gpuRequest,
        devices: recipe.runtime.devices,
        imageDownloadSizeBytes: recipe.runtime.imageDownloadSizeBytes,
        pullTimeoutSeconds: recipe.runtime.pullTimeoutSeconds,
        ulimits: {
          memlock: recipe.runtime.ulimits.memlock,
          stack: recipe.runtime.ulimits.stackBytes,
        },
        modelCache: recipe.runtime.modelCache,
        temporaryFilesystems: recipe.runtime.temporaryFilesystems,
      },
      command: { executable: recipe.serve.executable },
    });
    const configuredPort = recipe.serve.arguments.find(({ name }) => name === "--port")?.value;
    expect(plan.apiPort).toBe(configuredPort);
    expect(plan.roles[0].endpoint).toBe(`http://${plan.masterAddress}:${String(configuredPort)}`);
  });

  it("uses role-local topology values and starts rank 1 headless", () => {
    const plan = materializeManagedClusterVllmPlan(selectionWithDigests());

    expect(plan.roles[0].environment).toMatchObject({
      VLLM_HOST_IP: "192.168.100.10",
      NCCL_IB_HCA: "rocep1s0f0:1",
      NCCL_SOCKET_IFNAME: "enp1s0f0np0",
      NCCL_IB_GID_INDEX: "3",
      NODE_RANK: "0",
    });
    expect(plan.roles[1].environment).toMatchObject({
      VLLM_HOST_IP: "192.168.100.11",
      NCCL_IB_HCA: "rocep1s0f1:1",
      NCCL_SOCKET_IFNAME: "enp1s0f1np1",
      NCCL_IB_GID_INDEX: "6",
      NODE_RANK: "1",
      HEADLESS: "1",
    });
    expect(plan.roles[0].command.arguments).toEqual(
      expect.arrayContaining(["--host", "192.168.100.10"]),
    );
    expect(plan.roles[1].command.arguments).toEqual(
      expect.arrayContaining(["--host", "192.168.100.11", "--headless"]),
    );
    expect(plan.roles[0].command.arguments).not.toContain("--headless");
    expect(plan.roles[1].command.arguments).toEqual(
      expect.arrayContaining([
        "--tensor-parallel-size",
        "2",
        "--pipeline-parallel-size",
        "1",
        "--distributed-executor-backend",
        "mp",
        "--nnodes",
        "2",
        "--node-rank",
        "1",
        "--master-port",
        String(selectionWithDigests().recipe.spec.execution.rendezvousPort),
      ]),
    );
  });

  it("passes every recipe serving argument without embedding an API key", () => {
    const selection = selectionWithDigests();
    const plan = materializeManagedClusterVllmPlan(selection);
    const headArguments = plan.roles[0].command.arguments;

    for (const argument of selection.recipe.spec.serve.arguments) {
      const index = headArguments.indexOf(argument.name);
      expect(index).toBeGreaterThan(-1);
    }
    for (const argument of selection.recipe.spec.serve.arguments.filter(
      ({ value }) => value !== undefined,
    )) {
      const index = headArguments.indexOf(argument.name);
      expect(headArguments[index + 1]).toBe(String(argument.value));
    }
    expect(headArguments).not.toContain("--api-key");
    expect(plan.roles[1].command.arguments).not.toContain("--api-key");
  });

  it("rejects a selected definition changed after catalog resolution", () => {
    const selection = selectionWithDigests();
    (selection.recipe.spec.runtime as { image: string }).image =
      `registry.example.test/vllm@sha256:${"d".repeat(64)}`;

    expect(() => materializeManagedClusterVllmPlan(selection)).toThrow(/definition digest/u);
  });

  it("rejects stale topology subject and output digests", () => {
    const staleSubject = selectionWithDigests();
    (staleSubject.topologyQualification as { subjectDigest: string }).subjectDigest =
      `sha256:${"f".repeat(64)}`;
    expect(() => materializeManagedClusterVllmPlan(staleSubject)).toThrow(/subject digest/u);

    const staleOutput = selectionWithDigests();
    (staleOutput.topologyQualification.output.peers[0] as { target: string }).target =
      "other-worker.local";
    expect(() => materializeManagedClusterVllmPlan(staleOutput)).toThrow(/output digest/u);
  });

  it("rejects an inconsistent master address even with a recomputed digest", () => {
    const selection = selectionWithDigests();
    const artifact = selection.topologyQualification;
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.100.99";
    (artifact as { outputDigest: string }).outputDigest = managedClusterTopologyOutputDigest(
      artifact.output,
    );

    expect(() => materializeManagedClusterVllmPlan(selection)).toThrow(/master address/u);
  });

  it("selects each role endpoint by direct reachability to the qualified master", () => {
    const selection = selectionWithDigests();
    const artifact = selection.topologyQualification;
    (artifact.output as { masterAddress: string }).masterAddress = "192.168.101.10";
    (artifact as { outputDigest: string }).outputDigest = managedClusterTopologyOutputDigest(
      artifact.output,
    );

    const plan = materializeManagedClusterVllmPlan(selection);

    expect(plan.roles[0].fabric.address).toBe("192.168.101.10");
    expect(plan.roles[1].fabric.address).toBe("192.168.101.11");
  });

  it("materializes bounded preparation operations from recipe data", () => {
    const selection = selectionWithDigests();
    const preparation = materializeManagedClusterVllmPlan(selection).roles[0].preparation;
    const configured = selection.recipe.spec.model.preparation;
    expect(configured.ref).not.toBe(NO_PREPARATION_REF);
    const boundedConfigured = configured as Extract<
      typeof configured,
      { ref: typeof SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF }
    >;

    expect(preparation).toMatchObject({
      ref: boundedConfigured.ref,
      phase: "container-before-exec",
      modelId: selection.recipe.spec.model.id,
      modelRevision: selection.recipe.spec.model.revision,
      modelDownloadSizeBytes: selection.recipe.spec.model.downloadSizeBytes,
      snapshotCopy: {
        digest: boundedConfigured.snapshotCopy.digest,
        targetPath: boundedConfigured.snapshotCopy.targetPath,
      },
      exactTextReplacement: boundedConfigured.exactTextReplacement,
    });
    expect(preparation.ref).not.toBe(NO_PREPARATION_REF);
    const boundedPreparation = preparation as Extract<
      typeof preparation,
      { ref: typeof SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF }
    >;
    expect(boundedPreparation.snapshotCopy.sourcePath).toContain(boundedPreparation.modelRevision);
    expect(boundedPreparation.snapshotCopy.sourcePath).toContain(
      boundedConfigured.snapshotCopy.sourcePath,
    );
  });

  it("materializes a synthetic second profile without materializer code changes", () => {
    const { catalog, selection } = syntheticSecondProfile();
    const plan = materializeManagedClusterVllmPlan(selection, { catalog });

    expect(plan).toMatchObject({
      presetId: selection.preset.metadata.id,
      recipeId: selection.recipe.metadata.id,
      model: {
        id: "example-org/Synthetic-Model",
        servedName: "synthetic-model",
      },
      apiPort: 9_001,
      readiness: { timeoutMs: 900_000, expectedModel: "synthetic-model" },
    });
    expect(plan.roles[0]).toMatchObject({
      image: selection.recipe.spec.runtime.image,
      runtime: {
        sharedMemoryBytes: 8_589_934_592,
        gpuRequest: "device=all",
        pullTimeoutSeconds: 7_200,
        ulimits: { memlock: "unlimited", stack: 33_554_432 },
        modelCache: { source: "huggingface-cache", target: "/models/cache" },
      },
      preparation: {
        ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
        snapshotCopy: {
          sourcePath: expect.stringContaining(
            "/models/cache/hub/models--example-org--Synthetic-Model/",
          ),
          digest: `sha256:${"4".repeat(64)}`,
          targetPath: "/opt/synthetic-vllm/tokenizers/copied.py",
        },
        exactTextReplacement: {
          targetPath: "/opt/synthetic-vllm/parsers/reasoning.py",
          expectedText: "MODE = 'legacy'",
          replacementText: "MODE = 'compatible'",
        },
      },
      command: { executable: "/opt/vllm/bin/vllm" },
      baseLabels: {
        [MANAGED_CLUSTER_PRESET_LABEL]: selection.preset.metadata.id,
        [MANAGED_CLUSTER_RECIPE_LABEL]: selection.recipe.metadata.id,
      },
    });
    expect(plan.roles[0].environment).toMatchObject({
      HF_HOME: "/models/cache",
      SYNTHETIC_PROFILE: "enabled",
    });
    expect(plan.roles[0].command.arguments).toEqual(
      expect.arrayContaining(["--port", "9001", "--max-model-len", "4096"]),
    );

    const originalSelection = selectionWithDigests();
    const originalPlan = materializeManagedClusterVllmPlan(originalSelection);
    const originalFromExpandedCatalog = materializeManagedClusterVllmPlan(
      { ...originalSelection, catalogDigest: catalog.catalogDigest },
      { catalog },
    );
    expect(originalFromExpandedCatalog.planId).toBe(originalPlan.planId);
  });

  it("rejects a larger catalog profile only when its fabric cannot reach the master", () => {
    const { catalog, selection } = syntheticSecondProfile("/dev/shm-scratch", 3);

    expect(selection.recipe.spec.execution).toMatchObject({
      nodeCount: 3,
      tensorParallelSize: 3,
    });
    expect(() => materializeManagedClusterVllmPlan(selection, { catalog })).toThrow(
      /spark-worker-b has no direct fabric endpoint to master address/u,
    );
  });

  it("rejects a temporary filesystem that shadows the model cache", () => {
    const { catalog, selection } = syntheticSecondProfile("/models");

    expect(() => materializeManagedClusterVllmPlan(selection, { catalog })).toThrow(
      /temporary filesystem cannot shadow the model cache/u,
    );
  });
});
