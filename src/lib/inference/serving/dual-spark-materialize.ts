// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { loadManagedInferenceCatalog } from "./catalog.js";
import {
  immutableManagedInferenceCopy,
  managedInferenceDigest,
  managedInferenceHexDigest,
} from "./catalog-integrity.js";
import {
  DUAL_SPARK_PRESET_ID,
  DUAL_SPARK_RECIPE_ID,
  isManagedInferenceMaterializerOwnedArgument,
  type ResolvedManagedInferenceSelection,
} from "./catalog-types.js";
import {
  DUAL_SPARK_TOPOLOGY_ID,
  DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
  type DualSparkTopologyOutput,
  type DualSparkTopologyRailEndpoint,
  getDualSparkTopologyArtifactError,
} from "./dual-spark-topology.js";

export const DUAL_SPARK_VLLM_ADAPTER_ID = "vllm.dual-dgx-spark/v1" as const;
const SHIPPED_DUAL_SPARK_RECIPE = loadManagedInferenceCatalog().recipes[0]!.definition;
export const DUAL_SPARK_VLLM_IMAGE = SHIPPED_DUAL_SPARK_RECIPE.spec.runtime.image;
export const DUAL_SPARK_VLLM_MODEL = SHIPPED_DUAL_SPARK_RECIPE.spec.model.id;
export const DUAL_SPARK_VLLM_MODEL_REVISION = SHIPPED_DUAL_SPARK_RECIPE.spec.model.revision;
export const DUAL_SPARK_VLLM_API_PORT = 8000;
export const DUAL_SPARK_VLLM_MASTER_PORT = 25000;
export const DUAL_SPARK_VLLM_HEAD_CONTAINER_NAME = "nemoclaw-vllm-dspark-head";
export const DUAL_SPARK_VLLM_WORKER_CONTAINER_NAME = "nemoclaw-vllm-dspark-worker";
export const DUAL_SPARK_VLLM_PROJECT_ID = "nemoclaw-vllm-dspark";

export const DUAL_SPARK_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm";
export const DUAL_SPARK_ADAPTER_LABEL = "com.nvidia.nemoclaw.serving-adapter";
export const DUAL_SPARK_PRESET_LABEL = "com.nvidia.nemoclaw.serving-preset";
export const DUAL_SPARK_RECIPE_LABEL = "com.nvidia.nemoclaw.serving-recipe";
export const DUAL_SPARK_ROLE_LABEL = "com.nvidia.nemoclaw.serving-role";
export const DUAL_SPARK_CLUSTER_LABEL = "com.nvidia.nemoclaw.serving-cluster";
export const DUAL_SPARK_PLAN_LABEL = "com.nvidia.nemoclaw.serving-plan";
export const DUAL_SPARK_GPU_LABEL = "com.nvidia.nemoclaw.serving-gpu";
export const DUAL_SPARK_IMAGE_LABEL = "com.nvidia.nemoclaw.serving-image";
export const DUAL_SPARK_MODEL_REVISION_LABEL = "com.nvidia.nemoclaw.serving-model-revision";
export const DUAL_SPARK_API_KEY_FINGERPRINT_LABEL =
  "com.nvidia.nemoclaw.serving-api-key-fingerprint";
export const DUAL_SPARK_TRANSACTION_LABEL = "com.nvidia.nemoclaw.serving-transaction";

const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
export type DualSparkVllmRole = "head" | "worker";

export interface DualSparkVllmRolePlan {
  readonly role: DualSparkVllmRole;
  readonly rank: 0 | 1;
  readonly nodeId: string;
  readonly gpuId: string;
  readonly containerName: string;
  readonly execution:
    | { readonly kind: "local" }
    | {
        readonly kind: "ssh";
        readonly expectedTarget: string;
        readonly bindingHandle: string;
      };
  readonly image: string;
  readonly runtime: {
    readonly networkMode: "host";
    readonly ipcMode: "host";
    readonly sharedMemoryBytes: number;
    readonly gpuRequest: "all";
    readonly devices: readonly string[];
    readonly imageDownloadSizeBytes: number;
    readonly ulimits: {
      readonly memlock: -1;
      readonly stack: 67_108_864;
    };
    readonly modelCache: {
      readonly source: "huggingface-cache";
      readonly target: "/cache/huggingface";
    };
  };
  readonly preparation: {
    readonly ref: string;
    /** Code-owned adapter operation executed in the new container before vLLM. */
    readonly phase: "container-before-exec";
    readonly modelId: string;
    readonly modelRevision: string;
    readonly modelDownloadSizeBytes: number;
    readonly encodingPath: string;
    readonly encodingSourcePath: string;
    readonly encodingTargetPath: "/usr/local/lib/python3.12/dist-packages/vllm/tokenizers/deepseek_v4_encoding.py";
    readonly reasoningModulePath: "/usr/local/lib/python3.12/dist-packages/vllm/tokenizers/deepseek_v4.py";
    readonly reasoningCompatibility: {
      readonly existingText: string;
      readonly replacementText: string;
    };
  };
  readonly fabric: {
    readonly primaryRailIndex: number;
    readonly netdev: string;
    readonly hcaDevice: string;
    readonly hcaPort: number;
    readonly address: string;
    readonly roceGidIndex: number;
    readonly roceGidValue: string;
  };
  readonly environment: Readonly<Record<string, string>>;
  readonly command: {
    readonly executable: "/usr/local/bin/vllm";
    readonly arguments: readonly string[];
  };
  readonly endpoint: string | null;
  readonly baseLabels: Readonly<Record<string, string>>;
}

export interface DualSparkVllmPlan {
  readonly schemaVersion: 1;
  readonly adapterId: typeof DUAL_SPARK_VLLM_ADAPTER_ID;
  readonly catalogDigest: string;
  readonly presetId: typeof DUAL_SPARK_PRESET_ID;
  readonly recipeId: typeof DUAL_SPARK_RECIPE_ID;
  readonly topologyId: typeof DUAL_SPARK_TOPOLOGY_ID;
  readonly topologySchemaVersion: typeof DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION;
  readonly topologySubjectDigest: string;
  readonly topologyOutputDigest: string;
  readonly clusterId: string;
  readonly planId: string;
  readonly model: {
    readonly id: string;
    readonly revision: string;
    readonly servedName: string;
  };
  readonly apiPort: typeof DUAL_SPARK_VLLM_API_PORT;
  readonly masterAddress: string;
  readonly masterPort: typeof DUAL_SPARK_VLLM_MASTER_PORT;
  readonly readiness: {
    readonly timeoutMs: number;
    readonly expectedModel: string;
  };
  readonly roles: {
    readonly worker: DualSparkVllmRolePlan;
    readonly head: DualSparkVllmRolePlan;
  };
}

function fail(message: string): never {
  throw new Error(`Cannot materialize dual-DGX-Spark vLLM: ${message}`);
}

function commandArguments(
  selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
  rank: 0 | 1,
  hostAddress: string,
): string[] {
  const recipe = selection.recipe.spec;
  const seen = new Set<string>();
  const staticArguments: string[] = [];
  for (const argument of recipe.serve.arguments) {
    if (!/^--[a-z0-9][a-z0-9-]*$/.test(argument.name)) fail("a serve argument is invalid");
    if (seen.has(argument.name)) fail(`serve argument ${argument.name} is duplicated`);
    if (isManagedInferenceMaterializerOwnedArgument(argument.name)) {
      fail(`serve argument ${argument.name} is owned by the materializer`);
    }
    seen.add(argument.name);
    staticArguments.push(argument.name);
    if (argument.value !== undefined) staticArguments.push(String(argument.value));
  }

  const portIndex = staticArguments.indexOf("--port");
  if (portIndex < 0 || staticArguments[portIndex + 1] !== String(DUAL_SPARK_VLLM_API_PORT)) {
    fail(`the shipped recipe must bind API port ${String(DUAL_SPARK_VLLM_API_PORT)}`);
  }

  return [
    "serve",
    recipe.model.id,
    "--served-model-name",
    recipe.model.servedName,
    "--host",
    hostAddress,
    ...staticArguments,
    "--tensor-parallel-size",
    String(recipe.execution.tensorParallelSize),
    "--pipeline-parallel-size",
    String(recipe.execution.pipelineParallelSize),
    "--distributed-executor-backend",
    recipe.execution.distributedExecutorBackend,
    "--nnodes",
    String(recipe.execution.nodeCount),
    "--node-rank",
    String(rank),
    "--master-addr",
    selection.topologyQualification.output.masterAddress,
    "--master-port",
    String(DUAL_SPARK_VLLM_MASTER_PORT),
    ...(rank === 1 ? ["--headless"] : []),
  ];
}

function assertShippedSelection(
  selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
): void {
  const { recipe, preset, topologyQualification: topology } = selection;
  const catalog = loadManagedInferenceCatalog();
  const compiledPreset = catalog.presets[0];
  const compiledRecipe = catalog.recipes[0];
  if (
    selection.catalogDigest !== catalog.catalogDigest ||
    !compiledPreset ||
    !compiledRecipe ||
    managedInferenceDigest(preset) !== compiledPreset.definitionDigest ||
    managedInferenceDigest(recipe) !== compiledRecipe.definitionDigest ||
    preset.metadata.id !== DUAL_SPARK_PRESET_ID ||
    recipe.metadata.id !== DUAL_SPARK_RECIPE_ID ||
    preset.spec.plan.recipeRef !== recipe.metadata.id
  ) {
    fail("the selected preset and recipe are not the shipped dual-Spark profile");
  }
  if (
    recipe.spec.execution.materializerRef !== DUAL_SPARK_VLLM_ADAPTER_ID ||
    recipe.spec.execution.lifecycleRef !== DUAL_SPARK_VLLM_ADAPTER_ID ||
    recipe.spec.execution.nodeCount !== 2 ||
    recipe.spec.execution.tensorParallelSize !== 2 ||
    recipe.spec.execution.pipelineParallelSize !== 1 ||
    recipe.spec.execution.distributedExecutorBackend !== "mp"
  ) {
    fail("recipe execution does not match adapter v1");
  }
  if (
    topology.id !== DUAL_SPARK_TOPOLOGY_ID ||
    topology.schemaVersion !== DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION ||
    topology.status !== "qualified"
  ) {
    fail("topology artifact is not the qualified dual-Spark v1 artifact");
  }
  const topologyError = getDualSparkTopologyArtifactError(topology);
  if (topologyError) fail(topologyError);
  if (
    !Number.isSafeInteger(recipe.spec.readiness.timeoutSeconds) ||
    recipe.spec.readiness.timeoutSeconds <= 0 ||
    recipe.spec.readiness.timeoutSeconds > 86_400
  ) {
    fail("readiness timeout is invalid");
  }
}

function endpointForRole(
  output: DualSparkTopologyOutput,
  role: DualSparkVllmRole,
): DualSparkTopologyRailEndpoint {
  const endpoint = output.rails[0]?.[role];
  if (!endpoint || endpoint.nodeId !== output[`${role}NodeId`]) {
    fail(`primary ${role} fabric endpoint does not match the role node`);
  }
  if (!SAFE_DEVICE_PATTERN.test(endpoint.hcaDevice) || !SAFE_DEVICE_PATTERN.test(endpoint.netdev)) {
    fail(`primary ${role} fabric device identity is invalid`);
  }
  return endpoint;
}

function rolePlan(
  selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
  role: DualSparkVllmRole,
  clusterId: string,
  planId: string,
): DualSparkVllmRolePlan {
  const output = selection.topologyQualification.output;
  const recipe = selection.recipe.spec;
  const rank = role === "head" ? 0 : 1;
  const nodeId = role === "head" ? output.headNodeId : output.workerNodeId;
  const node = output.nodes.find(
    (candidate) => candidate.nodeId === nodeId && candidate.role === role,
  );
  if (!node) fail(`${role} node is missing from the topology artifact`);
  const endpoint = endpointForRole(output, role);
  const baseLabels = {
    [DUAL_SPARK_MANAGED_LABEL]: "true",
    [DUAL_SPARK_ADAPTER_LABEL]: DUAL_SPARK_VLLM_ADAPTER_ID,
    [DUAL_SPARK_PRESET_LABEL]: DUAL_SPARK_PRESET_ID,
    [DUAL_SPARK_RECIPE_LABEL]: DUAL_SPARK_RECIPE_ID,
    [DUAL_SPARK_ROLE_LABEL]: role,
    [DUAL_SPARK_CLUSTER_LABEL]: clusterId,
    [DUAL_SPARK_PLAN_LABEL]: planId,
    [DUAL_SPARK_GPU_LABEL]: node.gpuId,
    [DUAL_SPARK_IMAGE_LABEL]: recipe.runtime.image,
    [DUAL_SPARK_MODEL_REVISION_LABEL]: recipe.model.revision,
  };
  const environment = {
    ...recipe.runtime.environment,
    VLLM_HOST_IP: endpoint.address,
    NCCL_IB_HCA: `${endpoint.hcaDevice}:${String(endpoint.hcaPort)}`,
    NCCL_SOCKET_IFNAME: endpoint.netdev,
    TP_SOCKET_IFNAME: endpoint.netdev,
    GLOO_SOCKET_IFNAME: endpoint.netdev,
    NCCL_IB_GID_INDEX: String(endpoint.roceGid.index),
    MASTER_ADDR: output.masterAddress,
    MASTER_PORT: String(DUAL_SPARK_VLLM_MASTER_PORT),
    NODE_RANK: String(rank),
    HEADLESS: role === "worker" ? "1" : "",
  };

  return {
    role,
    rank,
    nodeId,
    gpuId: node.gpuId,
    containerName:
      role === "head" ? DUAL_SPARK_VLLM_HEAD_CONTAINER_NAME : DUAL_SPARK_VLLM_WORKER_CONTAINER_NAME,
    execution:
      role === "head"
        ? { kind: "local" }
        : {
            kind: "ssh",
            expectedTarget: output.peer.target,
            bindingHandle: output.peer.sshBindingHandle,
          },
    image: recipe.runtime.image,
    runtime: {
      networkMode: recipe.runtime.networkMode,
      ipcMode: recipe.runtime.ipcMode,
      sharedMemoryBytes: recipe.runtime.sharedMemoryBytes,
      gpuRequest: "all",
      devices: recipe.runtime.devices,
      imageDownloadSizeBytes: recipe.runtime.imageDownloadSizeBytes,
      ulimits: { memlock: -1, stack: 67_108_864 },
      modelCache: { source: "huggingface-cache", target: "/cache/huggingface" },
    },
    preparation: {
      ref: recipe.model.preparationRef,
      phase: "container-before-exec",
      modelId: recipe.model.id,
      modelRevision: recipe.model.revision,
      modelDownloadSizeBytes: recipe.model.downloadSizeBytes,
      encodingPath: recipe.model.encodingPath,
      encodingSourcePath: `/cache/huggingface/hub/models--${recipe.model.id.replaceAll(
        "/",
        "--",
      )}/snapshots/${recipe.model.revision}/${recipe.model.encodingPath}`,
      encodingTargetPath:
        "/usr/local/lib/python3.12/dist-packages/vllm/tokenizers/deepseek_v4_encoding.py",
      reasoningModulePath: "/usr/local/lib/python3.12/dist-packages/vllm/tokenizers/deepseek_v4.py",
      reasoningCompatibility: {
        existingText:
          'elif reasoning_effort in ("max", "xhigh"):\n                reasoning_effort = "max"\n            else:\n                reasoning_effort = "high"',
        replacementText:
          'elif reasoning_effort in ("max", "xhigh"):\n                reasoning_effort = "max"\n            elif reasoning_effort == "high":\n                reasoning_effort = "high"\n            else:\n                reasoning_effort = "low"',
      },
    },
    fabric: {
      primaryRailIndex: output.rails[0].index,
      netdev: endpoint.netdev,
      hcaDevice: endpoint.hcaDevice,
      hcaPort: endpoint.hcaPort,
      address: endpoint.address,
      roceGidIndex: endpoint.roceGid.index,
      roceGidValue: endpoint.roceGid.value,
    },
    environment,
    command: {
      executable: "/usr/local/bin/vllm",
      arguments: commandArguments(selection, rank, endpoint.address),
    },
    endpoint:
      role === "head" ? `http://${output.masterAddress}:${String(DUAL_SPARK_VLLM_API_PORT)}` : null,
    baseLabels,
  };
}

/** Compile one resolved, qualified catalog selection into immutable role-local plans. */
export function materializeDualSparkVllmPlan(
  selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
): DualSparkVllmPlan {
  let snapshot: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>;
  try {
    snapshot = immutableManagedInferenceCopy(selection);
  } catch {
    fail("the resolved selection is not immutable JSON data");
  }
  assertShippedSelection(snapshot);
  const output = snapshot.topologyQualification.output;
  const clusterId = managedInferenceHexDigest({
    topologyId: snapshot.topologyQualification.id,
    subjectDigest: snapshot.topologyQualification.subjectDigest,
    outputDigest: snapshot.topologyQualification.outputDigest,
  });
  const planId = managedInferenceHexDigest({
    adapterId: DUAL_SPARK_VLLM_ADAPTER_ID,
    catalogDigest: snapshot.catalogDigest,
    preset: snapshot.preset,
    recipe: snapshot.recipe,
    topology: snapshot.topologyQualification,
  });
  return {
    schemaVersion: 1,
    adapterId: DUAL_SPARK_VLLM_ADAPTER_ID,
    catalogDigest: snapshot.catalogDigest,
    presetId: DUAL_SPARK_PRESET_ID,
    recipeId: DUAL_SPARK_RECIPE_ID,
    topologyId: DUAL_SPARK_TOPOLOGY_ID,
    topologySchemaVersion: DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
    topologySubjectDigest: snapshot.topologyQualification.subjectDigest,
    topologyOutputDigest: snapshot.topologyQualification.outputDigest,
    clusterId,
    planId,
    model: {
      id: snapshot.recipe.spec.model.id,
      revision: snapshot.recipe.spec.model.revision,
      servedName: snapshot.recipe.spec.model.servedName,
    },
    apiPort: DUAL_SPARK_VLLM_API_PORT,
    masterAddress: output.masterAddress,
    masterPort: DUAL_SPARK_VLLM_MASTER_PORT,
    readiness: {
      timeoutMs: snapshot.recipe.spec.readiness.timeoutSeconds * 1000,
      expectedModel: snapshot.recipe.spec.readiness.expectedModel,
    },
    roles: {
      worker: rolePlan(snapshot, "worker", clusterId, planId),
      head: rolePlan(snapshot, "head", clusterId, planId),
    },
  };
}
