// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import {
  containerPathContains,
  getManagedInferenceLifecycleDescriptor,
  getManagedInferenceMaterializerDescriptor,
  getManagedInferenceRecipeRegistrationError,
  getManagedInferenceTopologyQualificationDescriptor,
  isManagedClusterMaterializerOwnedEnvironment,
  MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
} from "./adapter-registry.js";
import { loadManagedInferenceCatalog } from "./catalog-loader.js";
import {
  immutableManagedInferenceCopy,
  managedInferenceDigest,
  managedInferenceHexDigest,
} from "./catalog-integrity.js";
import {
  type CompiledManagedInferenceCatalog,
  isManagedInferenceMaterializerOwnedArgument,
  type ManagedInferenceServingPreset,
  type ManagedInferenceServingRecipe,
  type ResolvedManagedInferenceSelection,
} from "./types.js";
import {
  type ManagedClusterVllmPreparationPlan,
  materializeManagedClusterVllmPreparation,
} from "./managed-cluster-preparation.js";
import {
  MANAGED_CLUSTER_TOPOLOGY_ID,
  MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
  type ManagedClusterTopologyOutput,
  type ManagedClusterTopologyRailEndpoint,
} from "./managed-cluster-topology.js";

/** Stable adapter identity; profile identities and values come from the selected catalog entries. */
export const MANAGED_CLUSTER_VLLM_ADAPTER_ID = MANAGED_CLUSTER_VLLM_MATERIALIZER_REF;
export const MANAGED_CLUSTER_VLLM_PROJECT_ID = "nemoclaw-vllm-cluster";

export const MANAGED_CLUSTER_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm";
export const MANAGED_CLUSTER_ADAPTER_LABEL = "com.nvidia.nemoclaw.serving-adapter";
export const MANAGED_CLUSTER_PRESET_LABEL = "com.nvidia.nemoclaw.serving-preset";
export const MANAGED_CLUSTER_RECIPE_LABEL = "com.nvidia.nemoclaw.serving-recipe";
export const MANAGED_CLUSTER_ROLE_LABEL = "com.nvidia.nemoclaw.serving-role";
export const MANAGED_CLUSTER_CLUSTER_LABEL = "com.nvidia.nemoclaw.serving-cluster";
export const MANAGED_CLUSTER_PLAN_LABEL = "com.nvidia.nemoclaw.serving-plan";
export const MANAGED_CLUSTER_GPU_LABEL = "com.nvidia.nemoclaw.serving-gpu";
export const MANAGED_CLUSTER_IMAGE_LABEL = "com.nvidia.nemoclaw.serving-image";
export const MANAGED_CLUSTER_MODEL_REVISION_LABEL = "com.nvidia.nemoclaw.serving-model-revision";
export const MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL =
  "com.nvidia.nemoclaw.serving-api-key-fingerprint";
export const MANAGED_CLUSTER_TRANSACTION_LABEL = "com.nvidia.nemoclaw.serving-transaction";

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
export type ManagedClusterVllmRole = "head" | "worker";

export interface ManagedClusterVllmRolePlan {
  readonly role: ManagedClusterVllmRole;
  readonly rank: number;
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
  readonly preparation: ManagedClusterVllmPreparationPlan;
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

export interface ManagedClusterVllmPlan {
  readonly schemaVersion: 1;
  readonly adapterId: typeof MANAGED_CLUSTER_VLLM_ADAPTER_ID;
  readonly catalogDigest: string;
  readonly presetId: string;
  readonly presetDigest: string;
  readonly recipeId: string;
  readonly recipeDigest: string;
  readonly topologyId: typeof MANAGED_CLUSTER_TOPOLOGY_ID;
  readonly topologySchemaVersion: typeof MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION;
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
  readonly masterPort: number;
  readonly readiness: {
    readonly timeoutMs: number;
    readonly expectedModel: string;
  };
  readonly roles: readonly ManagedClusterVllmRolePlan[];
}

export interface ManagedClusterVllmMaterializeOptions {
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
  throw new Error(`Cannot materialize managed-cluster vLLM: ${message}`);
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
  definitions: readonly TDefinition[],
  selected: TDefinition,
  selectedDigest: string,
  label: string,
): TDefinition {
  const matches = definitions.filter(({ metadata }) => metadata.id === selected.metadata.id);
  if (matches.length !== 1) {
    fail(`selected ${label} ${selected.metadata.id} is not unique in the compiled catalog`);
  }
  const compiled = matches[0]!;
  if (
    !SHA256_PATTERN.test(selectedDigest) ||
    managedInferenceDigest(compiled) !== selectedDigest ||
    managedInferenceDigest(selected) !== selectedDigest
  ) {
    fail(`selected ${label} ${selected.metadata.id} does not match its definition digest`);
  }
  return compiled;
}

function assertCatalogSelection(
  selection: ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>,
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
  if (!/^[0-9a-f]{40,64}$/u.test(catalog.sourceRevision)) {
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
  if (!materializer || materializer.ref !== MANAGED_CLUSTER_VLLM_MATERIALIZER_REF) {
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
  if (topology.output.nodes.length !== recipe.spec.execution.nodeCount) {
    fail("topology node count does not match the recipe execution shape");
  }

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
      containerPathContains(temporaryFilesystem.target, runtime.modelCache.target) ||
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
        isManagedClusterMaterializerOwnedEnvironment(name) ||
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
  topology: ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>["topologyQualification"],
  staticArguments: readonly string[],
  rank: number,
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
    String(recipe.spec.execution.rendezvousPort),
    ...(rank > 0 ? ["--headless"] : []),
  ];
}

function endpointsForNode(
  output: ManagedClusterTopologyOutput,
  nodeId: string,
): readonly (ManagedClusterTopologyRailEndpoint & { readonly railIndex: number })[] {
  const endpoints = output.rails
    .flatMap((rail) =>
      rail.endpoints
        .filter((endpoint) => endpoint.nodeId === nodeId)
        .map((endpoint) => ({ ...endpoint, railIndex: rail.index })),
    )
    .sort((left, right) => left.railIndex - right.railIndex);
  if (
    endpoints.length === 0 ||
    endpoints.some(
      (endpoint) =>
        !SAFE_DEVICE_PATTERN.test(endpoint.hcaDevice) || !SAFE_DEVICE_PATTERN.test(endpoint.netdev),
    )
  ) {
    fail(`node ${nodeId} has no valid fabric endpoints`);
  }
  return endpoints;
}

interface RolePlanInput {
  readonly selection: ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>;
  readonly preset: ManagedInferenceServingPreset;
  readonly recipe: ManagedInferenceServingRecipe;
  readonly serving: ParsedServingArguments;
  readonly preparation: ManagedClusterVllmPreparationPlan;
  readonly node: ManagedClusterTopologyOutput["nodes"][number];
  readonly clusterId: string;
  readonly planId: string;
}

function rolePlan(input: RolePlanInput): ManagedClusterVllmRolePlan {
  const { clusterId, node, planId, preparation, preset, recipe, selection, serving } = input;
  const output = selection.topologyQualification.output;
  const { nodeId, rank, role } = node;
  const fabricEndpoints = endpointsForNode(output, nodeId);
  const primaryEndpoint = fabricEndpoints.find((endpoint) =>
    role === "head"
      ? endpoint.address === output.masterAddress
      : endpoint.peerAddress === output.masterAddress,
  );
  if (!primaryEndpoint) {
    fail(`node ${nodeId} has no direct fabric endpoint to master address ${output.masterAddress}`);
  }
  const peer = output.peers.find((candidate) => candidate.nodeId === nodeId);
  if (rank > 0 && !peer) fail(`worker rank ${String(rank)} is missing its SSH binding`);
  const baseLabels = {
    [MANAGED_CLUSTER_MANAGED_LABEL]: "true",
    [MANAGED_CLUSTER_ADAPTER_LABEL]: MANAGED_CLUSTER_VLLM_ADAPTER_ID,
    [MANAGED_CLUSTER_PRESET_LABEL]: preset.metadata.id,
    [MANAGED_CLUSTER_RECIPE_LABEL]: recipe.metadata.id,
    [MANAGED_CLUSTER_ROLE_LABEL]: role,
    [MANAGED_CLUSTER_CLUSTER_LABEL]: clusterId,
    [MANAGED_CLUSTER_PLAN_LABEL]: planId,
    [MANAGED_CLUSTER_GPU_LABEL]: node.gpuId,
    [MANAGED_CLUSTER_IMAGE_LABEL]: recipe.spec.runtime.image,
    [MANAGED_CLUSTER_MODEL_REVISION_LABEL]: recipe.spec.model.revision,
  };
  const environment = {
    ...recipe.spec.runtime.environment,
    HF_HOME: recipe.spec.runtime.modelCache.target,
    VLLM_HOST_IP: primaryEndpoint.address,
    NCCL_IB_HCA: `${primaryEndpoint.hcaDevice}:${String(primaryEndpoint.hcaPort)}`,
    NCCL_SOCKET_IFNAME: primaryEndpoint.netdev,
    TP_SOCKET_IFNAME: primaryEndpoint.netdev,
    GLOO_SOCKET_IFNAME: primaryEndpoint.netdev,
    NCCL_IB_GID_INDEX: String(primaryEndpoint.roceGid.index),
    MASTER_ADDR: output.masterAddress,
    MASTER_PORT: String(recipe.spec.execution.rendezvousPort),
    NODE_RANK: String(rank),
    HEADLESS: role === "worker" ? "1" : "",
  };
  const runtime = recipe.spec.runtime;

  return {
    role,
    rank,
    nodeId,
    gpuId: node.gpuId,
    containerName: `${MANAGED_CLUSTER_VLLM_PROJECT_ID}-rank-${String(rank)}`,
    execution:
      role === "head"
        ? { kind: "local" }
        : {
            kind: "ssh",
            expectedTarget: peer!.target,
            bindingHandle: peer!.sshBindingHandle,
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
      primaryRailIndex: primaryEndpoint.railIndex,
      netdev: primaryEndpoint.netdev,
      hcaDevice: primaryEndpoint.hcaDevice,
      hcaPort: primaryEndpoint.hcaPort,
      address: primaryEndpoint.address,
      roceGidIndex: primaryEndpoint.roceGid.index,
      roceGidValue: primaryEndpoint.roceGid.value,
    },
    environment,
    command: {
      executable: recipe.spec.serve.executable,
      arguments: commandArguments(
        recipe,
        selection.topologyQualification,
        serving.arguments,
        rank,
        primaryEndpoint.address,
      ),
    },
    endpoint: role === "head" ? `http://${output.masterAddress}:${String(serving.apiPort)}` : null,
    baseLabels,
  };
}

/** Compile one resolved, qualified catalog selection into immutable role-local plans. */
export function materializeManagedClusterVllmPlan(
  selection: ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>,
  options: ManagedClusterVllmMaterializeOptions = {},
): ManagedClusterVllmPlan {
  let snapshot: ResolvedManagedInferenceSelection<ManagedClusterTopologyOutput>;
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
  let preparation: ManagedClusterVllmPreparationPlan;
  try {
    preparation = materializeManagedClusterVllmPreparation({
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
    adapterId: MANAGED_CLUSTER_VLLM_ADAPTER_ID,
    preset: { id: selected.preset.metadata.id, digest: snapshot.presetDigest },
    recipe: { id: selected.recipe.metadata.id, digest: snapshot.recipeDigest },
    topology: topologyIdentity,
  });
  const output = snapshot.topologyQualification.output;
  return immutableManagedInferenceCopy({
    schemaVersion: 1,
    adapterId: MANAGED_CLUSTER_VLLM_ADAPTER_ID,
    catalogDigest: snapshot.catalogDigest,
    presetId: selected.preset.metadata.id,
    presetDigest: snapshot.presetDigest,
    recipeId: selected.recipe.metadata.id,
    recipeDigest: snapshot.recipeDigest,
    topologyId: MANAGED_CLUSTER_TOPOLOGY_ID,
    topologySchemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
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
    masterPort: selected.recipe.spec.execution.rendezvousPort,
    readiness: {
      timeoutMs: selected.recipe.spec.readiness.timeoutSeconds * 1000,
      expectedModel: selected.recipe.spec.readiness.expectedModel,
    },
    roles: output.nodes.map((node) =>
      rolePlan({
        selection: catalogSelection,
        preset: selected.preset,
        recipe: selected.recipe,
        serving,
        preparation,
        node,
        clusterId,
        planId,
      }),
    ),
  });
}

export function managedClusterHeadRole(plan: ManagedClusterVllmPlan): ManagedClusterVllmRolePlan {
  const head = plan.roles.find((role) => role.rank === 0 && role.role === "head");
  if (!head) fail("plan has no rank-zero head role");
  return head;
}

export function managedClusterWorkerRoles(
  plan: ManagedClusterVllmPlan,
): readonly ManagedClusterVllmRolePlan[] {
  return plan.roles.filter((role) => role.rank > 0 && role.role === "worker");
}
