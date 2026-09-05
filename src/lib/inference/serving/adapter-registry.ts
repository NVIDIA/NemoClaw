// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getManagedClusterTopologyArtifactError,
  MANAGED_CLUSTER_TOPOLOGY_ID,
  MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
} from "./managed-cluster-topology.js";
import type {
  HostLocalInferenceServingRecipe,
  LlamaCppServingRecipe,
  ManagedInferenceRuntimeServingRecipe,
  ManagedInferenceServingRecipe,
  ManagedInferenceTopologyQualification,
  ServingCatalogRegistries,
  ServingReadinessRegistryValue,
  ServingRecipe,
  VllmDirectInstallPolicy,
} from "./types.js";

export const MANAGED_CLUSTER_VLLM_MATERIALIZER_REF =
  "vllm.managed-cluster/v1" as const;
export const MANAGED_CLUSTER_VLLM_LIFECYCLE_REF =
  "vllm.managed-cluster.lifecycle/v1" as const;
export const HOST_LOCAL_VLLM_MATERIALIZER_REF = "vllm.host-local/v1" as const;
export const HOST_LOCAL_VLLM_LIFECYCLE_REF =
  "vllm.host-local.lifecycle/v1" as const;
export const VLLM_FIXED_AUTHENTICATED_INSTALL_POLICY_REF =
  "vllm.fixed-authenticated/v1" as const;
export const LLAMA_CPP_HOST_LOCAL_RECEIPT_REF =
  "llama-cpp.host-local.receipt/v1" as const;
export const LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF =
  "llama-cpp.host-local/v1" as const;
export const LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF =
  "llama-cpp.host-local.lifecycle/v1" as const;
export const LLAMA_CPP_SERVER_READINESS_REF =
  "llama-cpp.server-readiness/v1" as const;
export const SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF =
  "snapshot-copy-and-exact-text-replacement/v1" as const;
export const NO_PREPARATION_REF = "none/v1" as const;
export const MANAGED_CLUSTER_HUGGING_FACE_CACHE_SOURCE =
  "huggingface-cache" as const;

const VLLM_INSTALL_POLICIES = new Map<string, VllmDirectInstallPolicy>([
  [
    VLLM_FIXED_AUTHENTICATED_INSTALL_POLICY_REF,
    {
      authentication: "bearer",
      fixedArguments: true,
      catalogReceipt: true,
    },
  ],
]);

export function getManagedInferenceVllmInstallPolicy(
  ref: string,
): VllmDirectInstallPolicy | undefined {
  return VLLM_INSTALL_POLICIES.get(ref);
}

export function containerPathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export interface ManagedInferenceTopologyQualificationDescriptor {
  readonly id: string;
  readonly schemaVersion: number;
  readonly outputSchema: string;
  readonly bindingOutput: string;
  validateArtifact(
    artifact: ManagedInferenceTopologyQualification<unknown>,
    expectedSubjectNodeIds?: readonly string[],
  ): string | undefined;
}

export interface ManagedInferenceMaterializerDescriptor {
  readonly ref: string;
  readonly backend: string;
  readonly outputPlanSchema: string;
  readonly topology?: {
    readonly qualificationId: string;
    readonly schemaVersion: number;
    readonly outputSchema: string;
  };
  validateRecipe(
    recipe: ManagedInferenceRuntimeServingRecipe,
  ): string | undefined;
}

export interface ManagedInferenceLifecycleDescriptor {
  readonly ref: string;
  readonly backend: string;
  readonly acceptedMaterializerRefs: readonly string[];
  readonly acceptedPlanSchemas: readonly string[];
  readonly secretHandlePermissions: readonly string[];
  validateRecipe(
    recipe: ManagedInferenceRuntimeServingRecipe,
  ): string | undefined;
}

export interface ManagedInferencePreparationDescriptor {
  readonly ref: string;
  readonly backend: string;
  readonly phase: "container-before-exec";
  validateRecipe(
    recipe: ManagedInferenceRuntimeServingRecipe,
  ): string | undefined;
}

const MANAGED_CLUSTER_TOPOLOGY_OUTPUT_SCHEMA =
  "nemoclaw.nvidia.com/managed-cluster-topology/v1" as const;
const MANAGED_CLUSTER_PLAN_SCHEMA =
  "nemoclaw.nvidia.com/managed-cluster-vllm-plan/v1" as const;
const LOWERCASE_STABLE_ID = /^[a-z0-9][a-z0-9._/-]{0,159}$/u;
const STABLE_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/u;
const PINNED_IMAGE =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
// Structured vLLM flags are passed as individual argv values after shell
// quoting. Keep the allowlist narrow while admitting JSON objects and arrays.
const HOST_LOCAL_SAFE_ARGUMENT_VALUE = /^[A-Za-z0-9_@%+=:,./{}[\]"-]+$/u;
const HOST_LOCAL_SAFE_ENVIRONMENT_VALUE = /^[A-Za-z0-9_@%+=:,./-]+$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VLLM_ENVIRONMENT_VALUE = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const MANAGED_CLUSTER_MATERIALIZER_OWNED_ENVIRONMENT = new Set([
  "GLOO_SOCKET_IFNAME",
  "HEADLESS",
  "HF_HOME",
  "MASTER_ADDR",
  "MASTER_PORT",
  "NCCL_IB_GID_INDEX",
  "NCCL_IB_HCA",
  "NCCL_SOCKET_IFNAME",
  "NODE_RANK",
  "TP_SOCKET_IFNAME",
  "VLLM_API_KEY",
  "VLLM_HOST_IP",
]);
const HOST_LOCAL_MATERIALIZER_OWNED_ENVIRONMENT = new Set([
  "HF_HOME",
  "VLLM_API_KEY",
]);
const HOST_LOCAL_MATERIALIZER_OWNED_ARGUMENTS = new Set([
  "--api-key",
  "--data-parallel-size",
  "--distributed-executor-backend",
  "--headless",
  "--host",
  "--master-addr",
  "--master-port",
  "--nnodes",
  "--node-rank",
  "--pipeline-parallel-size",
  "--port",
  "--revision",
  "--served-model-name",
  "--tensor-parallel-size",
]);

export function isManagedClusterMaterializerOwnedEnvironment(
  name: string,
): boolean {
  return MANAGED_CLUSTER_MATERIALIZER_OWNED_ENVIRONMENT.has(name);
}

export function isManagedClusterInferenceServingRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): recipe is ManagedInferenceServingRecipe {
  return (
    recipe.spec.execution.materializerRef ===
    MANAGED_CLUSTER_VLLM_MATERIALIZER_REF
  );
}

export function isHostLocalInferenceServingRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): recipe is HostLocalInferenceServingRecipe {
  return (
    recipe.spec.execution.materializerRef === HOST_LOCAL_VLLM_MATERIALIZER_REF
  );
}

export function isLlamaCppServingRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): recipe is LlamaCppServingRecipe {
  return (
    recipe.spec.backend === "install-llama-cpp" &&
    recipe.spec.execution.materializerRef ===
      LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF &&
    recipe.spec.execution.lifecycleRef === LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF
  );
}

function managedClusterTopologyBinding(
  recipe: ManagedInferenceServingRecipe,
): ManagedInferenceServingRecipe["spec"]["bindings"][string] | undefined {
  return recipe.spec.bindings[recipe.spec.execution.topologyBinding];
}

function positiveIntegerArgument(
  recipe: ManagedInferenceServingRecipe | HostLocalInferenceServingRecipe,
  name: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number | undefined {
  const matches = recipe.spec.serve.arguments.filter(
    (argument) => argument.name === name,
  );
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.value;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum
    ? parsed
    : undefined;
}

function validateDeclarativeVllmModel(
  recipe: ManagedInferenceServingRecipe | HostLocalInferenceServingRecipe,
): string | undefined {
  const { model, runtime } = recipe.spec;
  if (
    !VLLM_ENVIRONMENT_VALUE.test(model.environmentValue) ||
    typeof model.displayName !== "string" ||
    model.displayName.trim() !== model.displayName ||
    model.displayName.length === 0 ||
    !Number.isSafeInteger(model.menuOrder) ||
    model.menuOrder < 0
  ) {
    return "vLLM recipe requires a model environment value, display name, and non-negative menu order";
  }
  if (
    !Number.isSafeInteger(runtime.minimumComputeCapability) ||
    runtime.minimumComputeCapability < 0 ||
    runtime.minimumComputeCapability > 999
  ) {
    return "vLLM recipe requires a bounded minimum compute capability or zero for no floor";
  }
  if (
    runtime.minimumGpuMemoryBytes !== undefined &&
    (!Number.isSafeInteger(runtime.minimumGpuMemoryBytes) ||
      runtime.minimumGpuMemoryBytes <= 0)
  ) {
    return "vLLM recipe requires a positive GPU memory floor";
  }
  return undefined;
}

function validateManagedClusterMaterializerRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): string | undefined {
  if (recipe.spec.backend !== "vllm")
    return "managed cluster materializer requires backend vllm";
  if (!isManagedClusterInferenceServingRecipe(recipe)) {
    return "recipe does not select the managed cluster materializer";
  }
  const declarativeModelError = validateDeclarativeVllmModel(recipe);
  if (declarativeModelError) return declarativeModelError;
  const { execution } = recipe.spec;
  if (
    !Number.isSafeInteger(execution.nodeCount) ||
    execution.nodeCount < 2 ||
    execution.nodeCount > 1_024 ||
    !Number.isSafeInteger(execution.tensorParallelSize) ||
    execution.tensorParallelSize < 1 ||
    !Number.isSafeInteger(execution.pipelineParallelSize) ||
    execution.pipelineParallelSize < 1 ||
    execution.tensorParallelSize * execution.pipelineParallelSize !==
      execution.nodeCount ||
    execution.distributedExecutorBackend !== "mp"
  ) {
    return "managed cluster materializer requires a bounded node count equal to TP times PP with the mp backend";
  }
  if (Object.keys(recipe.spec.bindings).length !== 1) {
    return "managed cluster materializer requires exactly one topology binding";
  }
  if (
    recipe.spec.runtime.architecture !== "arm64" ||
    recipe.spec.runtime.networkMode !== "host" ||
    recipe.spec.runtime.ipcMode !== "host" ||
    recipe.spec.serve.authentication !== "bearer"
  ) {
    return "managed cluster materializer requires arm64 host networking, host IPC, and bearer authentication";
  }
  const apiPort = positiveIntegerArgument(recipe, "--port", 65_535);
  if (
    apiPort === undefined ||
    positiveIntegerArgument(recipe, "--max-model-len") === undefined
  ) {
    return "managed cluster materializer requires one valid --port and one positive --max-model-len";
  }
  if (
    !Number.isSafeInteger(execution.rendezvousPort) ||
    execution.rendezvousPort < 1 ||
    execution.rendezvousPort > 65_535
  ) {
    return "managed cluster materializer requires a valid rendezvous port";
  }
  if (apiPort === execution.rendezvousPort) {
    return "managed cluster API port conflicts with the materializer rendezvous port";
  }
  if (recipe.spec.readiness.expectedModel !== recipe.spec.model.servedName) {
    return "managed cluster readiness must expect the recipe served model";
  }
  if (!LOWERCASE_STABLE_ID.test(recipe.spec.model.servedName)) {
    return "managed cluster served model name must be a lowercase stable ID";
  }
  if (recipe.spec.model.installFastSafetensors) {
    return "managed cluster immutable-image materializer cannot install fastsafetensors at launch";
  }
  if (
    recipe.spec.runtime.modelCache.source !==
    MANAGED_CLUSTER_HUGGING_FACE_CACHE_SOURCE
  ) {
    return "managed cluster materializer requires the Hugging Face cache source";
  }
  if (
    !safeAbsoluteContainerPath(recipe.spec.serve.executable) ||
    !safeAbsoluteContainerPath(recipe.spec.runtime.modelCache.target) ||
    recipe.spec.runtime.devices.some(
      (device) => !safeAbsoluteContainerPath(device),
    ) ||
    recipe.spec.runtime.temporaryFilesystems.some(
      ({ target }) => !safeAbsoluteContainerPath(target),
    )
  ) {
    return "managed cluster runtime paths must be normalized absolute container paths";
  }
  if (
    recipe.spec.runtime.temporaryFilesystems.some(({ target }) =>
      containerPathContains(target, recipe.spec.runtime.modelCache.target),
    )
  ) {
    return "managed cluster temporary filesystem cannot shadow the model cache";
  }
  const resourceValues = [
    recipe.spec.model.downloadSizeBytes,
    recipe.spec.runtime.imageDownloadSizeBytes,
    recipe.spec.runtime.sharedMemoryBytes,
    recipe.spec.runtime.ulimits.stackBytes,
    ...recipe.spec.runtime.temporaryFilesystems.map(
      ({ sizeBytes }) => sizeBytes,
    ),
  ];
  if (
    resourceValues.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    return "managed cluster recipe resource values must be positive safe integers";
  }
  const memlock = recipe.spec.runtime.ulimits.memlock;
  if (
    typeof memlock === "number" &&
    (!Number.isSafeInteger(memlock) || memlock < -1)
  ) {
    return "managed cluster memlock value must be -1 or a non-negative safe integer";
  }
  if (
    recipe.spec.serve.arguments.some(
      ({ value }) =>
        typeof value === "string" &&
        (Buffer.byteLength(value, "utf8") > 16_384 || value.includes("\0")),
    )
  ) {
    return "managed cluster serving argument values must be bounded text without NUL bytes";
  }
  if (
    Object.values(recipe.spec.runtime.environment).some(
      (value) =>
        Buffer.byteLength(value, "utf8") > 4_096 || value.includes("\0"),
    )
  ) {
    return "managed cluster environment values must be bounded text without NUL bytes";
  }
  if (
    Object.keys(recipe.spec.runtime.environment).some((name) =>
      isManagedClusterMaterializerOwnedEnvironment(name),
    )
  ) {
    return "managed cluster recipe environment overrides a materializer-owned value";
  }
  const binding = managedClusterTopologyBinding(recipe);
  if (
    !binding ||
    binding.type !== "topologyQualificationOutput" ||
    binding.qualificationId !== MANAGED_CLUSTER_TOPOLOGY_ID ||
    binding.schemaVersion !== MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION ||
    binding.outputSchema !== MANAGED_CLUSTER_TOPOLOGY_OUTPUT_SCHEMA
  ) {
    return "managed cluster materializer topology binding is incompatible";
  }
  return undefined;
}

function validateManagedClusterLifecycleRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): string | undefined {
  if (!isManagedClusterInferenceServingRecipe(recipe)) {
    return "recipe does not select the managed cluster lifecycle";
  }
  const materializerError = validateManagedClusterMaterializerRecipe(recipe);
  if (materializerError) return materializerError;
  return recipe.spec.execution.lifecycleRef ===
    MANAGED_CLUSTER_VLLM_LIFECYCLE_REF
    ? undefined
    : "recipe does not select the managed cluster lifecycle";
}

function validateHostLocalVllmMaterializerRecipe(
  recipe: HostLocalInferenceServingRecipe,
): string | undefined {
  if (recipe.spec.backend !== "vllm")
    return "host-local vLLM materializer requires backend vllm";
  if (
    recipe.spec.execution.materializerRef !== HOST_LOCAL_VLLM_MATERIALIZER_REF
  ) {
    return "recipe does not select the host-local vLLM materializer";
  }
  const declarativeModelError = validateDeclarativeVllmModel(recipe);
  if (declarativeModelError) return declarativeModelError;
  const directInstall = recipe.spec.serve.directInstall;
  if (
    !directInstall ||
    (directInstall.authentication !== "none" &&
      directInstall.authentication !== "bearer") ||
    typeof directInstall.fixedArguments !== "boolean" ||
    typeof directInstall.catalogReceipt !== "boolean" ||
    (directInstall.catalogReceipt && directInstall.authentication !== "bearer")
  ) {
    return "host-local vLLM requires a valid declarative direct-install policy";
  }
  const execution = recipe.spec.execution;
  if (
    execution.topologyBinding !== undefined ||
    execution.nodeCount !== undefined ||
    execution.tensorParallelSize !== undefined ||
    execution.pipelineParallelSize !== undefined ||
    execution.distributedExecutorBackend !== undefined ||
    execution.rendezvousPort !== undefined
  ) {
    return "host-local vLLM materializer does not accept distributed execution settings";
  }
  const bindings = recipe.spec.bindings;
  if (bindings !== undefined) {
    return "host-local vLLM materializer does not accept topology bindings";
  }
  const runtime = recipe.spec.runtime;
  if (runtime.architecture !== "arm64" && runtime.architecture !== "amd64") {
    return "host-local vLLM materializer requires an arm64 or amd64 runtime";
  }
  if (
    runtime.networkMode !== "bridge" ||
    runtime.ipcMode !== "host" ||
    runtime.gpuRequest !== "all" ||
    recipe.spec.serve.authentication !== "bearer"
  ) {
    return "host-local vLLM requires bridge networking, host IPC, all GPUs, and bearer authentication";
  }
  if (!PINNED_IMAGE.test(runtime.image)) {
    return "host-local vLLM requires a digest-pinned runtime image";
  }
  if (
    runtime.modelCache.source !== MANAGED_CLUSTER_HUGGING_FACE_CACHE_SOURCE ||
    runtime.modelCache.target !== "/root/.cache/huggingface"
  ) {
    return "host-local vLLM requires the registered Hugging Face cache mount";
  }
  if (
    !safeAbsoluteContainerPath(recipe.spec.serve.executable) ||
    !safeAbsoluteContainerPath(runtime.modelCache.target) ||
    runtime.devices.some((device) => !safeAbsoluteContainerPath(device)) ||
    runtime.temporaryFilesystems.some(
      ({ target }) => !safeAbsoluteContainerPath(target),
    )
  ) {
    return "host-local vLLM runtime paths must be normalized absolute container paths";
  }
  if (
    runtime.temporaryFilesystems.some(({ target }) =>
      containerPathContains(target, runtime.modelCache.target),
    )
  ) {
    return "host-local vLLM temporary filesystem cannot shadow the model cache";
  }
  if (
    recipe.spec.serve.executable !== "/usr/local/bin/vllm" ||
    recipe.spec.model.preparation.ref !== NO_PREPARATION_REF
  ) {
    return "host-local vLLM requires the registered executable without model preparation";
  }
  if (recipe.spec.readiness.expectedModel !== recipe.spec.model.servedName) {
    return "host-local vLLM readiness must expect the served model ID";
  }
  if (
    !STABLE_ID.test(recipe.spec.model.id) ||
    !STABLE_ID.test(recipe.spec.model.servedName)
  ) {
    return "host-local vLLM model identifiers do not match the registered format";
  }
  if (positiveIntegerArgument(recipe, "--max-model-len") === undefined) {
    return "host-local vLLM requires one positive --max-model-len argument";
  }
  if (
    recipe.spec.serve.arguments.some(({ name }) =>
      HOST_LOCAL_MATERIALIZER_OWNED_ARGUMENTS.has(name),
    )
  ) {
    return "host-local vLLM recipe overrides a materializer-owned serving argument";
  }
  if (
    Object.keys(recipe.spec.runtime.environment).some(
      (name) =>
        !SAFE_ENVIRONMENT_NAME.test(name) ||
        HOST_LOCAL_MATERIALIZER_OWNED_ENVIRONMENT.has(name),
    )
  ) {
    return "host-local vLLM recipe overrides a materializer-owned environment value";
  }
  const resourceValues = [
    recipe.spec.model.downloadSizeBytes,
    runtime.imageDownloadSizeBytes,
    runtime.pullTimeoutSeconds,
    runtime.sharedMemoryBytes,
    runtime.ulimits.stackBytes,
    ...runtime.temporaryFilesystems.map(({ sizeBytes }) => sizeBytes),
  ];
  if (
    resourceValues.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    return "host-local vLLM resource values must be positive safe integers";
  }
  if (
    runtime.ulimits.memlock !== -1 &&
    runtime.ulimits.memlock !== "unlimited"
  ) {
    return "host-local vLLM memlock must be unlimited";
  }
  if (
    recipe.spec.serve.arguments.some(
      ({ value }) =>
        typeof value === "string" &&
        (Buffer.byteLength(value, "utf8") > 16_384 ||
          value.includes("\0") ||
          !HOST_LOCAL_SAFE_ARGUMENT_VALUE.test(value)),
    ) ||
    Object.values(recipe.spec.runtime.environment).some(
      (value) =>
        Buffer.byteLength(value, "utf8") > 4_096 ||
        value.includes("\0") ||
        !HOST_LOCAL_SAFE_ENVIRONMENT_VALUE.test(value),
    )
  ) {
    return "host-local vLLM serving values must be bounded safe text";
  }
  return undefined;
}

function validateHostLocalVllmLifecycleRecipe(
  recipe: HostLocalInferenceServingRecipe,
): string | undefined {
  const materializerError = validateHostLocalVllmMaterializerRecipe(recipe);
  if (materializerError) return materializerError;
  return recipe.spec.execution.lifecycleRef === HOST_LOCAL_VLLM_LIFECYCLE_REF
    ? undefined
    : "recipe does not select the host-local vLLM lifecycle";
}
interface SnapshotPreparationInput {
  readonly ref: typeof SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF;
  readonly snapshotCopy: {
    readonly sourcePath: string;
    readonly digest: string;
    readonly targetPath: string;
  };
  readonly exactTextReplacement: {
    readonly targetPath: string;
    readonly expectedText: string;
    readonly replacementText: string;
  };
}

interface NoPreparationInput {
  readonly ref: typeof NO_PREPARATION_REF;
}

type ManagedInferencePreparationInput =
  SnapshotPreparationInput | NoPreparationInput;

function recipePreparation(
  recipe: ManagedInferenceRuntimeServingRecipe,
): ManagedInferencePreparationInput | undefined {
  const preparation = (
    recipe.spec.model as unknown as { readonly preparation?: unknown }
  ).preparation;
  return typeof preparation === "object" && preparation !== null
    ? (preparation as ManagedInferencePreparationInput)
    : undefined;
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function safeRelativeSnapshotPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every(
        (component) => component && component !== "." && component !== "..",
      ) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function safeAbsoluteContainerPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    value.length <= 4096 &&
    value
      .split("/")
      .slice(1)
      .every(
        (component) => component && component !== "." && component !== "..",
      ) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validateSnapshotPreparationRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): string | undefined {
  if (recipe.spec.backend !== "vllm")
    return "snapshot preparation requires backend vllm";
  const preparation = recipePreparation(recipe);
  if (
    preparation?.ref !==
      SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF ||
    !hasExactKeys(preparation, ["exactTextReplacement", "ref", "snapshotCopy"])
  ) {
    return "recipe does not select the snapshot preparation operation";
  }
  if (
    !preparation.snapshotCopy ||
    !hasExactKeys(preparation.snapshotCopy, [
      "digest",
      "sourcePath",
      "targetPath",
    ]) ||
    !safeRelativeSnapshotPath(preparation.snapshotCopy.sourcePath) ||
    !SHA256_DIGEST.test(preparation.snapshotCopy.digest) ||
    !safeAbsoluteContainerPath(preparation.snapshotCopy.targetPath)
  ) {
    return "snapshot preparation copy paths are invalid";
  }
  const replacement = preparation.exactTextReplacement;
  if (
    !replacement ||
    !hasExactKeys(replacement, [
      "expectedText",
      "replacementText",
      "targetPath",
    ]) ||
    !safeAbsoluteContainerPath(replacement.targetPath) ||
    typeof replacement.expectedText !== "string" ||
    typeof replacement.replacementText !== "string" ||
    replacement.expectedText.length === 0 ||
    replacement.expectedText.length > 65_536 ||
    replacement.replacementText.length === 0 ||
    replacement.replacementText.length > 65_536 ||
    replacement.expectedText === replacement.replacementText ||
    replacement.expectedText.includes("\0") ||
    replacement.replacementText.includes("\0")
  ) {
    return "snapshot preparation exact-text replacement is invalid";
  }
  return undefined;
}

function validateNoPreparationRecipe(
  recipe: ManagedInferenceRuntimeServingRecipe,
): string | undefined {
  if (recipe.spec.backend !== "vllm")
    return "empty preparation requires backend vllm";
  const preparation = recipePreparation(recipe);
  return preparation?.ref === NO_PREPARATION_REF &&
    hasExactKeys(preparation, ["ref"])
    ? undefined
    : "recipe does not select the empty preparation operation";
}

const TOPOLOGY_DESCRIPTORS = [
  {
    id: MANAGED_CLUSTER_TOPOLOGY_ID,
    schemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
    outputSchema: MANAGED_CLUSTER_TOPOLOGY_OUTPUT_SCHEMA,
    bindingOutput: "topology",
    validateArtifact: getManagedClusterTopologyArtifactError,
  },
] as const satisfies readonly ManagedInferenceTopologyQualificationDescriptor[];

const MATERIALIZER_DESCRIPTORS = [
  {
    ref: MANAGED_CLUSTER_VLLM_MATERIALIZER_REF,
    backend: "vllm",
    outputPlanSchema: MANAGED_CLUSTER_PLAN_SCHEMA,
    topology: {
      qualificationId: MANAGED_CLUSTER_TOPOLOGY_ID,
      schemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
      outputSchema: MANAGED_CLUSTER_TOPOLOGY_OUTPUT_SCHEMA,
    },
    validateRecipe: validateManagedClusterMaterializerRecipe,
  },
  {
    ref: HOST_LOCAL_VLLM_MATERIALIZER_REF,
    backend: "vllm",
    outputPlanSchema: "nemoclaw.nvidia.com/host-local-vllm-plan/v1",
    validateRecipe: (recipe) =>
      isHostLocalInferenceServingRecipe(recipe)
        ? validateHostLocalVllmMaterializerRecipe(recipe)
        : "recipe does not select the host-local vLLM materializer",
  },
] as const satisfies readonly ManagedInferenceMaterializerDescriptor[];

const LIFECYCLE_DESCRIPTORS = [
  {
    ref: MANAGED_CLUSTER_VLLM_LIFECYCLE_REF,
    backend: "vllm",
    acceptedMaterializerRefs: [MANAGED_CLUSTER_VLLM_MATERIALIZER_REF],
    acceptedPlanSchemas: [MANAGED_CLUSTER_PLAN_SCHEMA],
    secretHandlePermissions: ["sshBinding"],
    validateRecipe: validateManagedClusterLifecycleRecipe,
  },
  {
    ref: HOST_LOCAL_VLLM_LIFECYCLE_REF,
    backend: "vllm",
    acceptedMaterializerRefs: [HOST_LOCAL_VLLM_MATERIALIZER_REF],
    acceptedPlanSchemas: ["nemoclaw.nvidia.com/host-local-vllm-plan/v1"],
    secretHandlePermissions: [],
    validateRecipe: (recipe) =>
      isHostLocalInferenceServingRecipe(recipe)
        ? validateHostLocalVllmLifecycleRecipe(recipe)
        : "recipe does not select the host-local vLLM lifecycle",
  },
] as const satisfies readonly ManagedInferenceLifecycleDescriptor[];

const PREPARATION_DESCRIPTORS = [
  {
    ref: NO_PREPARATION_REF,
    backend: "vllm",
    phase: "container-before-exec",
    validateRecipe: validateNoPreparationRecipe,
  },
  {
    ref: SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
    backend: "vllm",
    phase: "container-before-exec",
    validateRecipe: validateSnapshotPreparationRecipe,
  },
] as const satisfies readonly ManagedInferencePreparationDescriptor[];

function registry<T>(
  entries: readonly T[],
  key: (entry: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const entry of entries) {
    const id = key(entry);
    if (result.has(id))
      throw new Error(
        `duplicate managed inference ${label} registry entry ${id}`,
      );
    result.set(id, entry);
  }
  return result;
}

const TOPOLOGY_REGISTRY = registry(
  TOPOLOGY_DESCRIPTORS,
  ({ id, schemaVersion }) => `${id}@${String(schemaVersion)}`,
  "topology qualification",
);
const MATERIALIZER_REGISTRY = registry(
  MATERIALIZER_DESCRIPTORS,
  ({ ref }) => ref,
  "materializer",
);
const LIFECYCLE_REGISTRY = registry(
  LIFECYCLE_DESCRIPTORS,
  ({ ref }) => ref,
  "lifecycle",
);
const PREPARATION_REGISTRY = registry(
  PREPARATION_DESCRIPTORS,
  ({ ref }) => ref,
  "preparation",
);

export function listManagedInferenceTopologyQualificationDescriptors(): readonly ManagedInferenceTopologyQualificationDescriptor[] {
  return [...TOPOLOGY_DESCRIPTORS];
}

export function getManagedInferenceTopologyQualificationDescriptor(
  id: string,
  schemaVersion: number,
): ManagedInferenceTopologyQualificationDescriptor | undefined {
  return TOPOLOGY_REGISTRY.get(`${id}@${String(schemaVersion)}`);
}

export function listManagedInferenceMaterializerDescriptors(): readonly ManagedInferenceMaterializerDescriptor[] {
  return [...MATERIALIZER_DESCRIPTORS];
}

export function getManagedInferenceMaterializerDescriptor(
  ref: string,
): ManagedInferenceMaterializerDescriptor | undefined {
  return MATERIALIZER_REGISTRY.get(ref);
}

export function listManagedInferenceLifecycleDescriptors(): readonly ManagedInferenceLifecycleDescriptor[] {
  return [...LIFECYCLE_DESCRIPTORS];
}

export function getManagedInferenceLifecycleDescriptor(
  ref: string,
): ManagedInferenceLifecycleDescriptor | undefined {
  return LIFECYCLE_REGISTRY.get(ref);
}

export function listManagedInferencePreparationDescriptors(): readonly ManagedInferencePreparationDescriptor[] {
  return [...PREPARATION_DESCRIPTORS];
}

export function getManagedInferencePreparationDescriptor(
  ref: string,
): ManagedInferencePreparationDescriptor | undefined {
  return PREPARATION_REGISTRY.get(ref);
}

export function getManagedInferenceRecipeRegistrationError(
  recipe: ManagedInferenceRuntimeServingRecipe,
): string | undefined {
  if (isLlamaCppServingRecipe(recipe)) return undefined;
  const materializer = getManagedInferenceMaterializerDescriptor(
    recipe.spec.execution.materializerRef,
  );
  if (!materializer) {
    return `unknown materializer ${recipe.spec.execution.materializerRef}`;
  }
  const lifecycle = getManagedInferenceLifecycleDescriptor(
    recipe.spec.execution.lifecycleRef,
  );
  if (!lifecycle)
    return `unknown lifecycle ${recipe.spec.execution.lifecycleRef}`;
  const preparationRef = recipePreparation(recipe)?.ref ?? "";
  const preparation = getManagedInferencePreparationDescriptor(preparationRef);
  if (!preparation)
    return `unknown preparation ${preparationRef || "(missing)"}`;
  return (
    materializer.validateRecipe(recipe) ??
    lifecycle.validateRecipe(recipe) ??
    preparation.validateRecipe(recipe)
  );
}

const SERVING_READINESS_REGISTRY: ServingCatalogRegistries["readiness"] =
  new Map<string, ServingReadinessRegistryValue>([
    [
      "host.os.platform",
      { kind: "observation", valueType: "string", role: "operating-system" },
    ],
    [
      "host.os.architecture",
      { kind: "observation", valueType: "string", role: "architecture" },
    ],
    ["host.os.wsl", { kind: "observation", valueType: "boolean" }],
    [
      "host.docker.runtime",
      { kind: "observation", valueType: "string", role: "container-runtime" },
    ],
    ["host.docker.memory_bytes", { kind: "observation", valueType: "number" }],
    [
      "host.gpu.count",
      { kind: "observation", valueType: "number", role: "gpu-count" },
    ],
    [
      "host.gpu.driver_version",
      { kind: "observation", valueType: "version", role: "driver-version" },
    ],
    [
      "host.gpu.memory_total_bytes",
      { kind: "observation", valueType: "number" },
    ],
    [
      "host.gpu.memory_available_bytes",
      { kind: "observation", valueType: "number" },
    ],
    [
      "host.gpu.memory_per_device_bytes",
      { kind: "observation", valueType: "number" },
    ],
    ["host.gpu.unified_memory", { kind: "observation", valueType: "boolean" }],
    [
      "host.gpu.compute_constrained",
      { kind: "observation", valueType: "boolean" },
    ],
    [
      "host.platform.dgx_spark",
      new Set(["qualification", "capability"] as const),
    ],
    [
      "host.platform.dgx_station",
      new Set(["qualification", "capability"] as const),
    ],
    ["host.platform.n1x", new Set(["qualification", "capability"] as const)],
    ["host.platform.supported", "capability"],
    ["host.platform.wsl_docker_desktop", "capability"],
    ["host.platform.wsl_gpu_passthrough", "capability"],
    ["host.platform.n1x_wsl", new Set(["qualification", "capability"] as const)],
    ["host.docker.available", "capability"],
    ["host.docker.daemon_reachable", "capability"],
    ["host.docker.runtime_supported", "capability"],
    ["host.docker.storage_compatible", "capability"],
    ["host.gpu.nvidia_available", "capability"],
    ["host.gpu.container_toolkit_available", "capability"],
    ["host.gpu.cdi_healthy", "capability"],
  ] as const);

export function getManagedInferenceServingCatalogRegistries(): ServingCatalogRegistries {
  return {
    receipts: new Set([LLAMA_CPP_HOST_LOCAL_RECEIPT_REF]),
    materializers: new Set([
      ...MATERIALIZER_DESCRIPTORS.map(({ ref }) => ref),
      LLAMA_CPP_HOST_LOCAL_MATERIALIZER_REF,
    ]),
    lifecycles: new Set([
      ...LIFECYCLE_DESCRIPTORS.map(({ ref }) => ref),
      LLAMA_CPP_HOST_LOCAL_LIFECYCLE_REF,
    ]),
    readinessContracts: new Set([LLAMA_CPP_SERVER_READINESS_REF]),
    installPolicies: new Set(VLLM_INSTALL_POLICIES.keys()),
    probePolicies: new Set([
      "nvidia.endpoint-validation.standard/v1",
      "nvidia.endpoint-validation.extended/v1",
    ]),
    orchestrations: new Set([
      "vllm.host-local.standard/v1",
      "vllm.station-pair-optional/v1",
    ]),
    readiness: SERVING_READINESS_REGISTRY,
    facts: new Set(["cluster.nodeCount"]),
    topologyQualifications: new Map(
      TOPOLOGY_DESCRIPTORS.map((descriptor) => [
        `${descriptor.id}@${String(descriptor.schemaVersion)}`,
        {
          bindingOutput: descriptor.bindingOutput,
          outputSchema: descriptor.outputSchema,
        },
      ]),
    ),
    validateRecipe: (recipe: ServingRecipe) => {
      if (
        recipe.spec.execution.materializerRef !==
          MANAGED_CLUSTER_VLLM_MATERIALIZER_REF &&
        recipe.spec.execution.lifecycleRef !==
          MANAGED_CLUSTER_VLLM_LIFECYCLE_REF &&
        recipe.spec.execution.materializerRef !==
          HOST_LOCAL_VLLM_MATERIALIZER_REF &&
        recipe.spec.execution.lifecycleRef !== HOST_LOCAL_VLLM_LIFECYCLE_REF
      ) {
        return undefined;
      }
      return getManagedInferenceRecipeRegistrationError(
        recipe as ManagedInferenceRuntimeServingRecipe,
      );
    },
  };
}
