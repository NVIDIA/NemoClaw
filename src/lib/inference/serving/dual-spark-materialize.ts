// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  DUAL_SPARK_VLLM_MASTER_PORT,
  DUAL_SPARK_VLLM_MATERIALIZER_REF,
  getManagedInferenceLifecycleDescriptor,
  getManagedInferenceMaterializerDescriptor,
  getManagedInferenceRecipeRegistrationError,
  getManagedInferenceTopologyQualificationDescriptor,
  isDualSparkMaterializerOwnedEnvironment,
} from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog.js";
import {
  immutableManagedInferenceCopy,
  managedInferenceDigest,
  managedInferenceHexDigest,
} from "./catalog-integrity.js";
import {
  isManagedInferenceMaterializerOwnedArgument,
  type CompiledManagedInferenceCatalog,
  type CompiledManagedInferenceDefinition,
  type ManagedInferenceServingPreset,
  type ManagedInferenceServingRecipe,
  type ResolvedManagedInferenceSelection,
} from "./catalog-types.js";
import {
  materializeDualSparkVllmPreparation,
  type DualSparkVllmPreparationPlan,
} from "./dual-spark-preparation.js";
import {
  DUAL_SPARK_TOPOLOGY_ID,
  DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
  type DualSparkTopologyOutput,
  type DualSparkTopologyRailEndpoint,
} from "./dual-spark-topology.js";

/** Stable adapter identity; profile identities and values come from the selected catalog entries. */
export const DUAL_SPARK_VLLM_ADAPTER_ID = DUAL_SPARK_VLLM_MATERIALIZER_REF;
export { DUAL_SPARK_VLLM_MASTER_PORT };
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

const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const SAFE_ABSOLUTE_PATH_PATTERN = /^\/(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+/-]+$/u;
const SAFE_GPU_REQUEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._,:=-]{0,255}$/u;
const SAFE_ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SAFE_MODEL_ID_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const SAFE_MODEL_REVISION_PATTERN = /^[0-9a-f]{40,64}$/u;
const SAFE_STABLE_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,159}$/u;
const PINNED_IMAGE_PATTERN = /^[a-z0-9.-]+(?::[0-9]+)?(?:\/[a-z0-9._-]+)+@sha256:[0-9a-f]{64}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TMPFS_OPTIONS = new Set([
  "rw",
  "ro",
  "nosuid",
  "nodev",
  "noexec",
  "exec",
  "noatime",
  "relatime",
]);
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
    readonly architecture: string;
    readonly networkMode: string;
    readonly ipcMode: string;
    readonly sharedMemoryBytes: number;
    readonly gpuRequest: string;
    readonly devices: readonly string[];
    readonly imageDownloadSizeBytes: number;
    readonly pullTimeoutSeconds: number;
    readonly ulimits: {
      readonly memlock: number | string;
      readonly stack: number;
    };
    readonly modelCache: {
      readonly source: string;
      readonly target: string;
    };
    readonly temporaryFilesystems: readonly {
      readonly target: string;
      readonly sizeBytes: number;
      readonly mode: string;
      readonly options: readonly string[];
    }[];
  };
  readonly preparation: DualSparkVllmPreparationPlan;
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
    readonly executable: string;
    readonly arguments: readonly string[];
  };
  readonly endpoint: string | null;
  readonly baseLabels: Readonly<Record<string, string>>;
}

export interface DualSparkVllmPlan {
  readonly schemaVersion: 1;
  readonly adapterId: typeof DUAL_SPARK_VLLM_ADAPTER_ID;
  readonly catalogDigest: string;
  readonly presetId: string;
  readonly presetDigest: string;
  readonly recipeId: string;
  readonly recipeDigest: string;
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
  readonly authentication: string;
  readonly apiPort: number;
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

export interface DualSparkVllmMaterializeOptions {
  /** Explicit catalog input keeps the materializer testable with additional YAML-compiled profiles. */
  readonly catalog?: CompiledManagedInferenceCatalog;
}

interface CatalogSelection {
  readonly preset: ManagedInferenceServingPreset;
  readonly recipe: ManagedInferenceServingRecipe;
}

interface ParsedServingArguments {
  readonly apiPort: number;
  readonly arguments: readonly string[];
}

function fail(message: string): never {
  throw new Error(`Cannot materialize dual-DGX-Spark vLLM: ${message}`);
}

function positiveSafeInteger(value: number, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function safeAbsolutePath(value: string): boolean {
  return (
    value.length <= 4_096 &&
    SAFE_ABSOLUTE_PATH_PATTERN.test(value) &&
    path.posix.normalize(value) === value
  );
}

function selectedDefinition<TDefinition extends { readonly metadata: { readonly id: string } }>(
  definitions: readonly CompiledManagedInferenceDefinition<TDefinition>[],
  selected: TDefinition,
  selectedDigest: string,
  label: string,
): TDefinition {
  const matches = definitions.filter(
    ({ definition }) => definition.metadata.id === selected.metadata.id,
  );
  if (matches.length !== 1) {
    fail(`selected ${label} ${selected.metadata.id} is not unique in the compiled catalog`);
  }
  const compiled = matches[0]!;
  if (
    !SHA256_PATTERN.test(selectedDigest) ||
    compiled.definitionDigest !== selectedDigest ||
    managedInferenceDigest(compiled.definition) !== selectedDigest ||
    managedInferenceDigest(selected) !== selectedDigest
  ) {
    fail(`selected ${label} ${selected.metadata.id} does not match its definition digest`);
  }
  return compiled.definition;
}

function assertCatalogSelection(
  selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
  catalog: CompiledManagedInferenceCatalog,
): CatalogSelection {
  const { catalogDigest, ...catalogContents } = catalog;
  if (
    selection.catalogDigest !== catalogDigest ||
    !SHA256_PATTERN.test(catalogDigest) ||
    managedInferenceDigest(catalogContents) !== catalogDigest
  ) {
    fail("the resolved selection does not match the compiled catalog digest");
  }
  if (
    !SHA256_PATTERN.test(catalog.sourceRevision) ||
    managedInferenceDigest(catalog.sourceFiles) !== catalog.sourceRevision
  ) {
    fail("the compiled catalog provenance is invalid");
  }

  const preset = selectedDefinition(
    catalog.presets,
    selection.preset,
    selection.presetDigest,
    "preset",
  );
  const recipe = selectedDefinition(
    catalog.recipes,
    selection.recipe,
    selection.recipeDigest,
    "recipe",
  );
  const bindingName = recipe.spec.execution.topologyBinding;
  const recipeBinding = recipe.spec.bindings[bindingName];
  const presetBinding = preset.spec.plan.bindings[bindingName]?.valueFromTopologyQualification;
  const topologyDescriptor = recipeBinding
    ? getManagedInferenceTopologyQualificationDescriptor(
        recipeBinding.qualificationId,
        recipeBinding.schemaVersion,
      )
    : undefined;

  if (
    preset.spec.plan.recipeRef !== recipe.metadata.id ||
    preset.spec.plan.backend !== recipe.spec.backend
  ) {
    fail("the selected preset does not reference the selected recipe and backend");
  }
  if (
    !recipeBinding ||
    !presetBinding ||
    !topologyDescriptor ||
    presetBinding.output !== topologyDescriptor.bindingOutput ||
    presetBinding.id !== recipeBinding.qualificationId ||
    presetBinding.schemaVersion !== recipeBinding.schemaVersion
  ) {
    fail(`preset and recipe topology binding ${bindingName} is incompatible`);
  }

  const materializer = getManagedInferenceMaterializerDescriptor(
    recipe.spec.execution.materializerRef,
  );
  if (!materializer || materializer.ref !== DUAL_SPARK_VLLM_MATERIALIZER_REF) {
    fail(`recipe selects unsupported materializer ${recipe.spec.execution.materializerRef}`);
  }
  const lifecycle = getManagedInferenceLifecycleDescriptor(recipe.spec.execution.lifecycleRef);
  if (
    !lifecycle ||
    lifecycle.backend !== recipe.spec.backend ||
    !lifecycle.acceptedMaterializerRefs.includes(materializer.ref) ||
    !lifecycle.acceptedPlanSchemas.includes(materializer.outputPlanSchema)
  ) {
    fail(`recipe selects incompatible lifecycle ${recipe.spec.execution.lifecycleRef}`);
  }
  const registrationError = getManagedInferenceRecipeRegistrationError(recipe);
  if (registrationError) fail(registrationError);

  const topology = selection.topologyQualification;
  if (
    topology.status !== "qualified" ||
    topology.id !== recipeBinding.qualificationId ||
    topology.schemaVersion !== recipeBinding.schemaVersion ||
    topology.id !== materializer.topology.qualificationId ||
    topology.schemaVersion !== materializer.topology.schemaVersion ||
    recipeBinding.outputSchema !== materializer.topology.outputSchema
  ) {
    fail("topology artifact is incompatible with the selected recipe binding");
  }
  if (topologyDescriptor.outputSchema !== recipeBinding.outputSchema) {
    fail("topology artifact has no compatible registered validator");
  }
  const topologyError = topologyDescriptor.validateArtifact(topology);
  if (topologyError) fail(topologyError);

  return { preset, recipe };
}

function assertRecipeValues(recipe: ManagedInferenceServingRecipe): void {
  const { model, readiness, runtime, serve } = recipe.spec;
  if (
    runtime.architecture !== "arm64" ||
    runtime.networkMode !== "host" ||
    runtime.ipcMode !== "host" ||
    serve.authentication !== "bearer"
  ) {
    fail("recipe runtime and authentication do not match adapter v1");
  }
  if (
    !PINNED_IMAGE_PATTERN.test(runtime.image) ||
    !positiveSafeInteger(runtime.imageDownloadSizeBytes) ||
    !positiveSafeInteger(runtime.pullTimeoutSeconds, 86_400) ||
    !positiveSafeInteger(runtime.sharedMemoryBytes) ||
    !SAFE_GPU_REQUEST_PATTERN.test(runtime.gpuRequest) ||
    !safeAbsolutePath(serve.executable)
  ) {
    fail("recipe runtime contains an invalid executable or resource value");
  }
  if (
    runtime.devices.length > 32 ||
    new Set(runtime.devices).size !== runtime.devices.length ||
    runtime.devices.some((device) => !safeAbsolutePath(device))
  ) {
    fail("recipe runtime device bindings are invalid");
  }
  const { memlock, stackBytes } = runtime.ulimits;
  if (
    !(
      (typeof memlock === "number" && Number.isSafeInteger(memlock) && memlock >= -1) ||
      memlock === "unlimited"
    ) ||
    !positiveSafeInteger(stackBytes)
  ) {
    fail("recipe runtime ulimits are invalid");
  }
  if (
    !SAFE_STABLE_ID_PATTERN.test(runtime.modelCache.source) ||
    !safeAbsolutePath(runtime.modelCache.target)
  ) {
    fail("recipe model-cache binding is invalid");
  }
  const temporaryTargets = new Set<string>();
  for (const temporaryFilesystem of runtime.temporaryFilesystems) {
    if (
      temporaryTargets.has(temporaryFilesystem.target) ||
      !safeAbsolutePath(temporaryFilesystem.target) ||
      !positiveSafeInteger(temporaryFilesystem.sizeBytes) ||
      !/^[0-7]{4}$/u.test(temporaryFilesystem.mode) ||
      temporaryFilesystem.options.length > 8 ||
      new Set(temporaryFilesystem.options).size !== temporaryFilesystem.options.length ||
      temporaryFilesystem.options.some((option) => !TMPFS_OPTIONS.has(option))
    ) {
      fail("recipe temporary-filesystem configuration is invalid");
    }
    temporaryTargets.add(temporaryFilesystem.target);
  }
  const environmentEntries = Object.entries(runtime.environment);
  if (
    environmentEntries.length > 128 ||
    environmentEntries.some(
      ([name, value]) =>
        !SAFE_ENVIRONMENT_NAME_PATTERN.test(name) ||
        isDualSparkMaterializerOwnedEnvironment(name) ||
        Buffer.byteLength(value, "utf8") > 4_096 ||
        value.includes("\0"),
    )
  ) {
    fail("recipe runtime environment is invalid or overrides adapter-owned values");
  }
  if (
    !SAFE_MODEL_ID_PATTERN.test(model.id) ||
    !SAFE_MODEL_REVISION_PATTERN.test(model.revision) ||
    !SAFE_STABLE_ID_PATTERN.test(model.servedName) ||
    !positiveSafeInteger(model.downloadSizeBytes) ||
    !positiveSafeInteger(readiness.timeoutSeconds, 86_400) ||
    readiness.expectedModel !== model.servedName
  ) {
    fail("recipe model identity or readiness contract is invalid");
  }
}

function servingArguments(recipe: ManagedInferenceServingRecipe): ParsedServingArguments {
  const seen = new Set<string>();
  const staticArguments: string[] = [];
  let apiPort: number | undefined;
  for (const argument of recipe.spec.serve.arguments) {
    if (!/^--[a-z0-9][a-z0-9-]*$/u.test(argument.name)) fail("a serve argument is invalid");
    if (seen.has(argument.name)) fail(`serve argument ${argument.name} is duplicated`);
    if (isManagedInferenceMaterializerOwnedArgument(argument.name)) {
      fail(`serve argument ${argument.name} is owned by the materializer`);
    }
    seen.add(argument.name);
    staticArguments.push(argument.name);
    if (argument.value !== undefined) {
      const value = String(argument.value);
      if (Buffer.byteLength(value, "utf8") > 16_384 || value.includes("\0")) {
        fail(`serve argument ${argument.name} has an invalid value`);
      }
      staticArguments.push(value);
    }
    if (argument.name === "--port") {
      const parsed =
        typeof argument.value === "number"
          ? argument.value
          : typeof argument.value === "string" && /^\d{1,5}$/u.test(argument.value)
            ? Number(argument.value)
            : Number.NaN;
      if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
        fail("serve argument --port must contain a valid TCP port");
      }
      apiPort = parsed;
    }
  }
  if (apiPort === undefined) fail("recipe must define one --port serve argument");
  return { apiPort, arguments: staticArguments };
}

function commandArguments(
  recipe: ManagedInferenceServingRecipe,
  topology: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>["topologyQualification"],
  staticArguments: readonly string[],
  rank: 0 | 1,
  hostAddress: string,
): string[] {
  return [
    "serve",
    recipe.spec.model.id,
    "--revision",
    recipe.spec.model.revision,
    "--served-model-name",
    recipe.spec.model.servedName,
    "--host",
    hostAddress,
    ...staticArguments,
    "--tensor-parallel-size",
    String(recipe.spec.execution.tensorParallelSize),
    "--pipeline-parallel-size",
    String(recipe.spec.execution.pipelineParallelSize),
    "--distributed-executor-backend",
    recipe.spec.execution.distributedExecutorBackend,
    "--nnodes",
    String(recipe.spec.execution.nodeCount),
    "--node-rank",
    String(rank),
    "--master-addr",
    topology.output.masterAddress,
    "--master-port",
    String(DUAL_SPARK_VLLM_MASTER_PORT),
    ...(rank === 1 ? ["--headless"] : []),
  ];
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

interface RolePlanInput {
  readonly selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>;
  readonly preset: ManagedInferenceServingPreset;
  readonly recipe: ManagedInferenceServingRecipe;
  readonly serving: ParsedServingArguments;
  readonly preparation: DualSparkVllmPreparationPlan;
  readonly role: DualSparkVllmRole;
  readonly clusterId: string;
  readonly planId: string;
}

function rolePlan(input: RolePlanInput): DualSparkVllmRolePlan {
  const { clusterId, planId, preparation, preset, recipe, role, selection, serving } = input;
  const output = selection.topologyQualification.output;
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
    [DUAL_SPARK_PRESET_LABEL]: preset.metadata.id,
    [DUAL_SPARK_RECIPE_LABEL]: recipe.metadata.id,
    [DUAL_SPARK_ROLE_LABEL]: role,
    [DUAL_SPARK_CLUSTER_LABEL]: clusterId,
    [DUAL_SPARK_PLAN_LABEL]: planId,
    [DUAL_SPARK_GPU_LABEL]: node.gpuId,
    [DUAL_SPARK_IMAGE_LABEL]: recipe.spec.runtime.image,
    [DUAL_SPARK_MODEL_REVISION_LABEL]: recipe.spec.model.revision,
  };
  const environment = {
    ...recipe.spec.runtime.environment,
    HF_HOME: recipe.spec.runtime.modelCache.target,
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
  const runtime = recipe.spec.runtime;

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
    image: runtime.image,
    runtime: {
      architecture: runtime.architecture,
      networkMode: runtime.networkMode,
      ipcMode: runtime.ipcMode,
      sharedMemoryBytes: runtime.sharedMemoryBytes,
      gpuRequest: runtime.gpuRequest,
      devices: runtime.devices,
      imageDownloadSizeBytes: runtime.imageDownloadSizeBytes,
      pullTimeoutSeconds: runtime.pullTimeoutSeconds,
      ulimits: { memlock: runtime.ulimits.memlock, stack: runtime.ulimits.stackBytes },
      modelCache: runtime.modelCache,
      temporaryFilesystems: runtime.temporaryFilesystems,
    },
    preparation,
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
      executable: recipe.spec.serve.executable,
      arguments: commandArguments(
        recipe,
        selection.topologyQualification,
        serving.arguments,
        rank,
        endpoint.address,
      ),
    },
    endpoint: role === "head" ? `http://${output.masterAddress}:${String(serving.apiPort)}` : null,
    baseLabels,
  };
}

/** Compile one resolved, qualified catalog selection into immutable role-local plans. */
export function materializeDualSparkVllmPlan(
  selection: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>,
  options: DualSparkVllmMaterializeOptions = {},
): DualSparkVllmPlan {
  let snapshot: ResolvedManagedInferenceSelection<DualSparkTopologyOutput>;
  let catalog: CompiledManagedInferenceCatalog;
  try {
    snapshot = immutableManagedInferenceCopy(selection);
    catalog = options.catalog
      ? immutableManagedInferenceCopy(options.catalog)
      : loadManagedInferenceCatalog();
  } catch {
    fail("the resolved selection or catalog is not immutable JSON data");
  }

  const selected = assertCatalogSelection(snapshot, catalog);
  const catalogSelection = { ...snapshot, ...selected };
  assertRecipeValues(selected.recipe);
  const serving = servingArguments(selected.recipe);
  let preparation: DualSparkVllmPreparationPlan;
  try {
    preparation = materializeDualSparkVllmPreparation({
      ...selected.recipe.spec.model,
      modelCacheTarget: selected.recipe.spec.runtime.modelCache.target,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : "model preparation is invalid");
  }

  const topologyIdentity = {
    id: snapshot.topologyQualification.id,
    schemaVersion: snapshot.topologyQualification.schemaVersion,
    subjectDigest: snapshot.topologyQualification.subjectDigest,
    outputDigest: snapshot.topologyQualification.outputDigest,
  };
  const clusterId = managedInferenceHexDigest(topologyIdentity);
  const planId = managedInferenceHexDigest({
    adapterId: DUAL_SPARK_VLLM_ADAPTER_ID,
    preset: { id: selected.preset.metadata.id, digest: snapshot.presetDigest },
    recipe: { id: selected.recipe.metadata.id, digest: snapshot.recipeDigest },
    topology: topologyIdentity,
  });
  const output = snapshot.topologyQualification.output;
  return immutableManagedInferenceCopy({
    schemaVersion: 1,
    adapterId: DUAL_SPARK_VLLM_ADAPTER_ID,
    catalogDigest: snapshot.catalogDigest,
    presetId: selected.preset.metadata.id,
    presetDigest: snapshot.presetDigest,
    recipeId: selected.recipe.metadata.id,
    recipeDigest: snapshot.recipeDigest,
    topologyId: DUAL_SPARK_TOPOLOGY_ID,
    topologySchemaVersion: DUAL_SPARK_TOPOLOGY_SCHEMA_VERSION,
    topologySubjectDigest: snapshot.topologyQualification.subjectDigest,
    topologyOutputDigest: snapshot.topologyQualification.outputDigest,
    clusterId,
    planId,
    model: {
      id: selected.recipe.spec.model.id,
      revision: selected.recipe.spec.model.revision,
      servedName: selected.recipe.spec.model.servedName,
    },
    authentication: selected.recipe.spec.serve.authentication,
    apiPort: serving.apiPort,
    masterAddress: output.masterAddress,
    masterPort: DUAL_SPARK_VLLM_MASTER_PORT,
    readiness: {
      timeoutMs: selected.recipe.spec.readiness.timeoutSeconds * 1000,
      expectedModel: selected.recipe.spec.readiness.expectedModel,
    },
    roles: {
      worker: rolePlan({
        selection: catalogSelection,
        preset: selected.preset,
        recipe: selected.recipe,
        serving,
        preparation,
        role: "worker",
        clusterId,
        planId,
      }),
      head: rolePlan({
        selection: catalogSelection,
        preset: selected.preset,
        recipe: selected.recipe,
        serving,
        preparation,
        role: "head",
        clusterId,
        planId,
      }),
    },
  });
}
