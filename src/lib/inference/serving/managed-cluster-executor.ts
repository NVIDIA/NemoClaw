// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { dockerForceRm, dockerRunDetached } from "../../adapters/docker/container.js";
import { dockerCapture } from "../../adapters/docker/run.js";
import { createBearerAuthConfig } from "../../adapters/http/auth-config.js";
import { runCurlProbe } from "../../adapters/http/probe.js";
import {
  buildLocalManagedVllmDockerEnv,
  buildRemoteVllmDockerEnv,
  captureManagedVllmTcpListeners,
} from "../vllm-docker-env.js";
import { withHostGlobalVllmLifecycleLock } from "../vllm-station-lifecycle-lock.js";
import {
  NO_PREPARATION_REF,
  SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF,
} from "./adapter-registry.js";
import { managedInferenceDigest, managedInferenceHexDigest } from "./catalog-integrity.js";
import {
  getManagedInferenceCompiledPreset,
  getManagedInferenceCompiledRecipe,
} from "./catalog-loader.js";
import {
  isRelatedManagedVllmContainer,
  type ManagedClusterApiProbeRequest,
  type ManagedClusterContainerStartRequest,
  type ManagedClusterContainerWaitRequest,
  type ManagedClusterNodeSnapshot,
  type ManagedClusterObservedContainer,
  type ManagedClusterStageRequest,
  type ManagedClusterVllmLifecycleDeps,
} from "./managed-cluster-lifecycle.js";
import {
  MANAGED_CLUSTER_ADAPTER_LABEL,
  MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL,
  MANAGED_CLUSTER_CLUSTER_LABEL,
  MANAGED_CLUSTER_GPU_LABEL,
  MANAGED_CLUSTER_IMAGE_LABEL,
  MANAGED_CLUSTER_MANAGED_LABEL,
  MANAGED_CLUSTER_MODEL_REVISION_LABEL,
  MANAGED_CLUSTER_PLAN_LABEL,
  MANAGED_CLUSTER_PRESET_LABEL,
  MANAGED_CLUSTER_RECIPE_LABEL,
  MANAGED_CLUSTER_ROLE_LABEL,
  MANAGED_CLUSTER_TRANSACTION_LABEL,
  MANAGED_CLUSTER_VLLM_ADAPTER_ID,
  type ManagedClusterVllmPlan,
  type ManagedClusterVllmRolePlan,
  managedClusterHeadRole,
} from "./managed-cluster-materialize.js";
import { materializeManagedClusterVllmPreparation } from "./managed-cluster-preparation.js";
import {
  encodeManagedVllmSshBindingHandoff,
  type ManagedVllmSshBinding,
} from "./managed-cluster-ssh-binding.js";
import {
  MANAGED_CLUSTER_TOPOLOGY_ID,
  MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
} from "./managed-cluster-topology.js";
import type { ManagedInferenceServingRecipe } from "./types.js";

const API_KEY_PATTERN = /^[a-f0-9]{64}$/;
const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const HEX64_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
const LABEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,255}$/;
const SAFE_DEVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const MAX_CONTAINERS = 256;
const DOCKER_INSPECTION_TIMEOUT_MS = 20_000;
const DOCKER_MUTATION_TIMEOUT_MS = 120_000;
const PROCESS_PROBE_TIMEOUT_MS = 10_000;
const PROCESS_PROBE_INTERVAL_MS = 1_000;
const MAX_PROCESS_WAIT_MS = 120_000;
const API_PROBE_INTERVAL_MS = 2_000;
const MAX_MODELS_PROBE_MS = 86_400_000;
const MAX_CHAT_PROBE_MS = 120_000;

const CONTAINER_INSPECTION_FORMAT =
  "[{{json .Id}},{{json .Name}},{{json .Config.Image}},{{json .State.Running}},{{json .Config.Labels}}]";

const PROCESS_PROBE_SCRIPT = String.raw`
import base64, glob, json, sys
expected = json.loads(base64.urlsafe_b64decode(sys.argv[1] + "=="))
for item in glob.glob("/proc/[0-9]*/cmdline"):
    try:
        raw = open(item, "rb").read(1024 * 1024)
        argv = [part.decode("utf-8") for part in raw.split(b"\0") if part]
    except (OSError, UnicodeDecodeError):
        continue
    for index, value in enumerate(argv):
        if value == expected[0] and argv[index:] == expected:
            print("ready")
            raise SystemExit(0)
raise SystemExit(1)
`.trim();

const EXACT_TEXT_REPLACEMENT_SCRIPT = String.raw`
import base64, pathlib, sys
target = pathlib.Path(sys.argv[1])
existing = base64.urlsafe_b64decode(sys.argv[2] + "==").decode("utf-8")
replacement = base64.urlsafe_b64decode(sys.argv[3] + "==").decode("utf-8")
content = target.read_text(encoding="utf-8")
if content.count(existing) != 1:
    raise SystemExit("preparation source text did not match exactly once")
target.write_text(content.replace(existing, replacement), encoding="utf-8")
`.trim();

const VERIFY_FILE_SHA256_SCRIPT = String.raw`
import hashlib, pathlib, sys
target = pathlib.Path(sys.argv[1])
expected = sys.argv[2]
actual = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
if actual != expected:
    raise SystemExit("snapshot copy source digest mismatch")
`.trim();

export interface ManagedClusterExecutorStageTarget {
  readonly nodeId: string;
  readonly dockerEnv: Readonly<Record<string, string>>;
  readonly modelCacheRoot: string;
  readonly sshBinding?: ManagedVllmSshBinding;
}

export type ManagedClusterExecutorStageNode = (
  request: ManagedClusterStageRequest,
  target: ManagedClusterExecutorStageTarget,
) => Promise<{ ok: boolean; reason?: string }>;

export interface CreateManagedClusterVllmExecutorOptions {
  readonly plan: ManagedClusterVllmPlan;
  readonly nodes: readonly ManagedClusterExecutorNodeTarget[];
  readonly stageNode?: ManagedClusterExecutorStageNode;
}

export interface ManagedClusterExecutorNodeTarget {
  readonly nodeId: string;
  readonly modelCacheRoot: string;
  readonly sshBinding?: ManagedVllmSshBinding;
}

export interface ManagedClusterVllmExecutorRuntimeDeps {
  dockerCapture: typeof dockerCapture;
  dockerForceRm: typeof dockerForceRm;
  dockerRunDetached: typeof dockerRunDetached;
  captureListeners(rolePlan: ManagedClusterVllmRolePlan, binding?: ManagedVllmSshBinding): string;
  createBearerAuthConfig: typeof createBearerAuthConfig;
  createTransactionId(): string;
  now(): number;
  runCurlProbe: typeof runCurlProbe;
  sleep(ms: number): Promise<void>;
  withLifecycleLock<T>(operation: () => Promise<T>): Promise<T>;
}

type SelectedRecipe = ManagedInferenceServingRecipe["spec"];

const DEFAULT_DEPS: ManagedClusterVllmExecutorRuntimeDeps = {
  dockerCapture,
  dockerForceRm,
  dockerRunDetached,
  captureListeners: (rolePlan, binding) => {
    if (rolePlan.execution.kind === "ssh" && !binding) {
      throw new Error("Managed cluster worker listener probe has no SSH binding");
    }
    return captureManagedVllmTcpListeners(
      rolePlan.role,
      binding ?? ({} as ManagedVllmSshBinding),
      DOCKER_INSPECTION_TIMEOUT_MS,
    );
  },
  createBearerAuthConfig,
  createTransactionId: () => randomBytes(16).toString("hex"),
  now: () => Date.now(),
  runCurlProbe,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  withLifecycleLock: (operation) => withHostGlobalVllmLifecycleLock(operation),
};

function normalizedAbsoluteHostPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4096 ||
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.includes(path.posix.delimiter) ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a normalized absolute POSIX path`);
  }
  return value;
}

function exactKeys(actual: object, expected: readonly string[], label: string): void {
  const keys = Object.keys(actual).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} does not match the managed cluster adapter contract`);
  }
}

function recipeCommandArguments(
  rolePlan: ManagedClusterVllmRolePlan,
  plan: ManagedClusterVllmPlan,
  recipe: SelectedRecipe,
): string[] {
  const staticArguments = recipe.serve.arguments.flatMap(({ name, value }) =>
    value === undefined ? [name] : [name, String(value)],
  );
  return [
    "serve",
    recipe.model.id,
    "--revision",
    recipe.model.revision,
    "--served-model-name",
    recipe.model.servedName,
    "--host",
    rolePlan.fabric.address,
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
    String(rolePlan.rank),
    "--master-addr",
    plan.masterAddress,
    "--master-port",
    String(plan.masterPort),
    ...(rolePlan.role === "worker" ? ["--headless"] : []),
  ];
}

function assertRolePlan(
  rolePlan: ManagedClusterVllmRolePlan,
  plan: ManagedClusterVllmPlan,
  recipe: SelectedRecipe,
): void {
  const isHead = rolePlan.role === "head";
  const environment = {
    ...recipe.runtime.environment,
    HF_HOME: recipe.runtime.modelCache.target,
    VLLM_HOST_IP: rolePlan.fabric.address,
    NCCL_IB_HCA: `${rolePlan.fabric.hcaDevice}:${String(rolePlan.fabric.hcaPort)}`,
    NCCL_SOCKET_IFNAME: rolePlan.fabric.netdev,
    TP_SOCKET_IFNAME: rolePlan.fabric.netdev,
    GLOO_SOCKET_IFNAME: rolePlan.fabric.netdev,
    NCCL_IB_GID_INDEX: String(rolePlan.fabric.roceGidIndex),
    MASTER_ADDR: plan.masterAddress,
    MASTER_PORT: String(plan.masterPort),
    NODE_RANK: String(rolePlan.rank),
    HEADLESS: isHead ? "" : "1",
  };
  const baseLabels = {
    [MANAGED_CLUSTER_MANAGED_LABEL]: "true",
    [MANAGED_CLUSTER_ADAPTER_LABEL]: MANAGED_CLUSTER_VLLM_ADAPTER_ID,
    [MANAGED_CLUSTER_PRESET_LABEL]: plan.presetId,
    [MANAGED_CLUSTER_RECIPE_LABEL]: plan.recipeId,
    [MANAGED_CLUSTER_ROLE_LABEL]: rolePlan.role,
    [MANAGED_CLUSTER_CLUSTER_LABEL]: plan.clusterId,
    [MANAGED_CLUSTER_PLAN_LABEL]: plan.planId,
    [MANAGED_CLUSTER_GPU_LABEL]: rolePlan.gpuId,
    [MANAGED_CLUSTER_IMAGE_LABEL]: recipe.runtime.image,
    [MANAGED_CLUSTER_MODEL_REVISION_LABEL]: recipe.model.revision,
  };
  const preparation = materializeManagedClusterVllmPreparation({
    ...recipe.model,
    modelCacheTarget: recipe.runtime.modelCache.target,
  });
  const fabric = {
    primaryRailIndex: rolePlan.fabric.primaryRailIndex,
    netdev: rolePlan.fabric.netdev,
    hcaDevice: rolePlan.fabric.hcaDevice,
    hcaPort: rolePlan.fabric.hcaPort,
    address: rolePlan.fabric.address,
    roceGidIndex: rolePlan.fabric.roceGidIndex,
    roceGidValue: rolePlan.fabric.roceGidValue,
  };
  const expected = {
    role: rolePlan.role,
    rank: rolePlan.rank,
    nodeId: rolePlan.nodeId,
    gpuId: rolePlan.gpuId,
    containerName: `nemoclaw-vllm-cluster-rank-${String(rolePlan.rank)}`,
    execution: rolePlan.execution,
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
    preparation,
    fabric,
    environment,
    command: {
      executable: recipe.serve.executable,
      arguments: recipeCommandArguments(rolePlan, plan, recipe),
    },
    endpoint: isHead ? `http://${plan.masterAddress}:${String(plan.apiPort)}` : null,
    baseLabels,
  };
  if (
    !isDeepStrictEqual(rolePlan, expected) ||
    !rolePlan.nodeId ||
    rolePlan.nodeId.length > 256 ||
    !/^GPU-[A-Za-z0-9-]+$/.test(rolePlan.gpuId) ||
    !Number.isSafeInteger(rolePlan.fabric.primaryRailIndex) ||
    rolePlan.fabric.primaryRailIndex < 0 ||
    !SAFE_DEVICE_PATTERN.test(rolePlan.fabric.netdev) ||
    !SAFE_DEVICE_PATTERN.test(rolePlan.fabric.hcaDevice) ||
    net.isIP(rolePlan.fabric.address) !== 4 ||
    net.isIP(rolePlan.fabric.roceGidValue) !== 6 ||
    !Number.isInteger(rolePlan.fabric.hcaPort) ||
    !Number.isInteger(rolePlan.fabric.roceGidIndex)
  ) {
    throw new Error(`${rolePlan.role} role does not match the catalog-derived adapter contract`);
  }
}

function recipeApiPort(recipe: SelectedRecipe): number | undefined {
  const ports = recipe.serve.arguments
    .filter(({ name }) => name === "--port")
    .map(({ value }) =>
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{1,5}$/u.test(value)
          ? Number(value)
          : Number.NaN,
    );
  return ports.length === 1 && Number.isInteger(ports[0]) ? ports[0] : undefined;
}

/** Read-only validation shared by installer, receipt, recovery, and cleanup. */
export function assertManagedClusterVllmExecutorConfig(
  config: CreateManagedClusterVllmExecutorOptions,
): void {
  exactKeys(
    config,
    ["nodes", "plan", ...(Object.hasOwn(config, "stageNode") ? ["stageNode"] : [])],
    "Managed cluster executor configuration",
  );
  const { plan } = config;
  if (
    config.nodes.length !== plan.roles.length ||
    new Set(config.nodes.map(({ nodeId }) => nodeId)).size !== config.nodes.length ||
    config.nodes.some(({ nodeId }) => !plan.roles.some((role) => role.nodeId === nodeId))
  ) {
    throw new Error("Managed cluster executor node targets do not match the plan");
  }
  for (const target of config.nodes) {
    normalizedAbsoluteHostPath(target.modelCacheRoot, `${target.nodeId} model cache root`);
    const rolePlan = plan.roles.find(({ nodeId }) => nodeId === target.nodeId)!;
    if (
      (rolePlan.execution.kind === "local" && target.sshBinding !== undefined) ||
      (rolePlan.execution.kind === "ssh" &&
        (!target.sshBinding ||
          rolePlan.execution.expectedTarget !== target.sshBinding.peerTarget ||
          rolePlan.execution.bindingHandle !==
            encodeManagedVllmSshBindingHandoff(target.sshBinding)))
    ) {
      throw new Error(`Managed cluster executor target ${target.nodeId} is invalid`);
    }
  }
  const compiledPreset = getManagedInferenceCompiledPreset(plan.presetId);
  const compiledRecipe = getManagedInferenceCompiledRecipe(plan.recipeId);
  if (
    !compiledPreset ||
    !compiledRecipe ||
    managedInferenceDigest(compiledPreset) !== plan.presetDigest ||
    managedInferenceDigest(compiledRecipe) !== plan.recipeDigest ||
    compiledPreset.spec.plan.recipeRef !== compiledRecipe.metadata.id ||
    compiledPreset.spec.plan.backend !== compiledRecipe.spec.backend
  ) {
    throw new Error(
      "Managed cluster executor input does not match its selected definition digests",
    );
  }
  const recipe = compiledRecipe.spec;
  const topologyIdentity = {
    id: plan.topologyId,
    schemaVersion: plan.topologySchemaVersion,
    subjectDigest: plan.topologySubjectDigest,
    outputDigest: plan.topologyOutputDigest,
  };
  const expectedClusterId = managedInferenceHexDigest(topologyIdentity);
  const expectedPlanId = managedInferenceHexDigest({
    adapterId: MANAGED_CLUSTER_VLLM_ADAPTER_ID,
    preset: { id: plan.presetId, digest: plan.presetDigest },
    recipe: { id: plan.recipeId, digest: plan.recipeDigest },
    topology: topologyIdentity,
  });
  const expectedPlan = {
    schemaVersion: 1,
    adapterId: MANAGED_CLUSTER_VLLM_ADAPTER_ID,
    catalogDigest: plan.catalogDigest,
    presetId: compiledPreset.metadata.id,
    presetDigest: managedInferenceDigest(compiledPreset),
    recipeId: compiledRecipe.metadata.id,
    recipeDigest: managedInferenceDigest(compiledRecipe),
    topologyId: MANAGED_CLUSTER_TOPOLOGY_ID,
    topologySchemaVersion: MANAGED_CLUSTER_TOPOLOGY_SCHEMA_VERSION,
    topologySubjectDigest: plan.topologySubjectDigest,
    topologyOutputDigest: plan.topologyOutputDigest,
    clusterId: expectedClusterId,
    planId: expectedPlanId,
    model: {
      id: recipe.model.id,
      revision: recipe.model.revision,
      servedName: recipe.model.servedName,
    },
    authentication: recipe.serve.authentication,
    apiPort: recipeApiPort(recipe),
    masterAddress: plan.masterAddress,
    masterPort: recipe.execution.rendezvousPort,
    readiness: {
      timeoutMs: recipe.readiness.timeoutSeconds * 1000,
      expectedModel: recipe.readiness.expectedModel,
    },
    roles: plan.roles,
  };
  if (
    !isDeepStrictEqual(plan, expectedPlan) ||
    !SHA256_PATTERN.test(plan.catalogDigest) ||
    !SHA256_PATTERN.test(plan.presetDigest) ||
    !SHA256_PATTERN.test(plan.recipeDigest) ||
    plan.masterAddress !== managedClusterHeadRole(plan).fabric.address ||
    !HEX64_PATTERN.test(plan.clusterId) ||
    !HEX64_PATTERN.test(plan.planId) ||
    !SHA256_PATTERN.test(plan.topologySubjectDigest) ||
    !SHA256_PATTERN.test(plan.topologyOutputDigest) ||
    plan.roles.length !== recipe.execution.nodeCount ||
    !isDeepStrictEqual(managedClusterHeadRole(plan).execution, { kind: "local" }) ||
    plan.roles.some(
      (rolePlan, index) =>
        rolePlan.rank !== index ||
        (index === 0 ? rolePlan.role !== "head" : rolePlan.role !== "worker"),
    )
  ) {
    throw new Error("Managed cluster executor input does not match its qualified binding and plan");
  }
  for (const rolePlan of plan.roles) assertRolePlan(rolePlan, plan, recipe);
}

function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("Managed cluster command value contains a NUL byte");
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function preparationCommand(rolePlan: ManagedClusterVllmRolePlan): string {
  const preparation = rolePlan.preparation;
  const command = ["set -Eeuo pipefail"];
  if (preparation.ref === SNAPSHOT_COPY_AND_EXACT_TEXT_REPLACEMENT_PREPARATION_REF) {
    command.push(
      `test -f ${shellQuote(preparation.snapshotCopy.sourcePath)}`,
      [
        "python3",
        "-c",
        shellQuote(VERIFY_FILE_SHA256_SCRIPT),
        shellQuote(preparation.snapshotCopy.sourcePath),
        shellQuote(preparation.snapshotCopy.digest),
      ].join(" "),
      `install -m 0644 -- ${shellQuote(preparation.snapshotCopy.sourcePath)} ${shellQuote(preparation.snapshotCopy.targetPath)}`,
      [
        "python3",
        "-c",
        shellQuote(EXACT_TEXT_REPLACEMENT_SCRIPT),
        shellQuote(preparation.exactTextReplacement.targetPath),
        shellQuote(base64url(preparation.exactTextReplacement.expectedText)),
        shellQuote(base64url(preparation.exactTextReplacement.replacementText)),
      ].join(" "),
    );
  } else if (preparation.ref !== NO_PREPARATION_REF) {
    throw new Error("Unsupported managed cluster preparation");
  }
  const executable = shellQuote(rolePlan.command.executable);
  const commandArguments = rolePlan.command.arguments.map(shellQuote).join(" ");
  command.push(`exec ${executable} ${commandArguments}`);
  return command.join(" && ");
}

function validateLaunchLabels(
  rolePlan: ManagedClusterVllmRolePlan,
  labels: Readonly<Record<string, string>>,
): void {
  const expectedKeys = [
    ...Object.keys(rolePlan.baseLabels),
    MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL,
    MANAGED_CLUSTER_TRANSACTION_LABEL,
  ].sort();
  exactKeys(labels, expectedKeys, `${rolePlan.role} launch labels`);
  for (const [name, value] of Object.entries(labels)) {
    if (
      !LABEL_NAME_PATTERN.test(name) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4096 ||
      /[\u0000\r\n]/.test(value)
    ) {
      throw new Error(`${rolePlan.role} launch labels are unsafe`);
    }
  }
  if (
    !Object.entries(rolePlan.baseLabels).every(([name, value]) => labels[name] === value) ||
    !HEX64_PATTERN.test(labels[MANAGED_CLUSTER_API_KEY_FINGERPRINT_LABEL] ?? "") ||
    !TRANSACTION_ID_PATTERN.test(labels[MANAGED_CLUSTER_TRANSACTION_LABEL] ?? "")
  ) {
    throw new Error(`${rolePlan.role} launch labels do not match its plan`);
  }
}

/** Build the exact, non-secret Docker run argv for one materialized role. */
export function buildManagedClusterVllmRunArgs(
  rolePlan: ManagedClusterVllmRolePlan,
  modelCacheRoot: string,
  labels: Readonly<Record<string, string>>,
): string[] {
  const cacheRoot = normalizedAbsoluteHostPath(modelCacheRoot, `${rolePlan.role} model cache root`);
  validateLaunchLabels(rolePlan, labels);
  const args = [
    "--pull=never",
    "--init",
    "--network",
    rolePlan.runtime.networkMode,
    "--ipc",
    rolePlan.runtime.ipcMode,
    "--shm-size",
    String(rolePlan.runtime.sharedMemoryBytes),
    "--gpus",
    rolePlan.runtime.gpuRequest,
    "--ulimit",
    `memlock=${rolePlan.runtime.ulimits.memlock === "unlimited" ? "-1" : String(rolePlan.runtime.ulimits.memlock)}`,
    "--ulimit",
    `stack=${String(rolePlan.runtime.ulimits.stack)}`,
  ];
  for (const device of rolePlan.runtime.devices) args.push("--device", device);
  for (const temporaryFilesystem of rolePlan.runtime.temporaryFilesystems) {
    args.push(
      "--tmpfs",
      `${temporaryFilesystem.target}:${[
        ...temporaryFilesystem.options,
        `size=${String(temporaryFilesystem.sizeBytes)}`,
        `mode=${temporaryFilesystem.mode}`,
      ].join(",")}`,
    );
  }
  args.push("--volume", `${cacheRoot}/hub:${rolePlan.runtime.modelCache.target}/hub:ro`);
  for (const [name, value] of Object.entries(rolePlan.environment).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    args.push("--env", `${name}=${value}`);
  }
  if (rolePlan.role === "head") args.push("--env", "VLLM_API_KEY");
  for (const [name, value] of Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    args.push("--label", `${name}=${value}`);
  }
  args.push(
    "--name",
    rolePlan.containerName,
    "--entrypoint",
    "/bin/bash",
    rolePlan.image,
    "-lc",
    preparationCommand(rolePlan),
  );
  return args;
}

function parseJsonField<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} returned malformed JSON`);
  }
}

function parseLabels(value: unknown): Readonly<Record<string, string>> {
  if (value === null) return {};
  if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 128) {
    throw new Error("Docker container labels are malformed");
  }
  const labels: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (
      !LABEL_NAME_PATTERN.test(name) ||
      typeof item !== "string" ||
      item.length > 4096 ||
      /[\u0000\r\n]/.test(item)
    ) {
      throw new Error("Docker container labels are malformed");
    }
    labels[name] = item;
  }
  return labels;
}

interface InspectedContainer {
  id: string;
  name: string;
  image: string;
  running: boolean;
  labels: Readonly<Record<string, string>>;
}

function parseContainerRows(output: string, expectedIds: readonly string[]): InspectedContainer[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length !== expectedIds.length) {
    throw new Error("Docker container inspection was incomplete or ambiguous");
  }
  const containers = lines.map((line, index) => {
    const fields = parseJsonField<unknown>(line, "Docker container inspection");
    if (!Array.isArray(fields) || fields.length !== 5) {
      throw new Error("Docker container inspection was malformed");
    }
    const [id, rawName, image, running, rawLabels] = fields;
    const labels = parseLabels(rawLabels);
    const name =
      typeof rawName === "string" && rawName.startsWith("/") ? rawName.slice(1) : rawName;
    if (
      typeof id !== "string" ||
      !CONTAINER_ID_PATTERN.test(id) ||
      id !== expectedIds[index] ||
      typeof name !== "string" ||
      name.length === 0 ||
      name.length > 256 ||
      typeof image !== "string" ||
      image.length === 0 ||
      image.length > 1024 ||
      typeof running !== "boolean"
    ) {
      throw new Error("Docker container inspection was malformed");
    }
    return { id, name, image, running, labels };
  });
  if (new Set(containers.map(({ id }) => id)).size !== containers.length) {
    throw new Error("Docker container inspection returned duplicate IDs");
  }
  return containers;
}

function parseListeningPorts(output: string): number[] {
  if (!output.trim()) return [];
  const ports = output
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const local = fields[3];
      const match = local?.match(/:([0-9]{1,5})$/);
      const port = match ? Number(match[1]) : Number.NaN;
      if (fields[0] !== "LISTEN" || !Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("Host listener inspection was malformed");
      }
      return port;
    });
  return [...new Set(ports)].sort((left, right) => left - right);
}

function labelsMatch(
  actual: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, value]) => actual[name] === value);
}

function mutationSucceeded(result: ReturnType<typeof dockerRunDetached>): boolean {
  return result.status === 0 && !result.error && !result.signal;
}

function targetFor(
  rolePlan: ManagedClusterVllmRolePlan,
  config: CreateManagedClusterVllmExecutorOptions,
): ManagedClusterExecutorNodeTarget {
  const target = config.nodes.find(({ nodeId }) => nodeId === rolePlan.nodeId);
  if (!target) throw new Error(`Managed cluster node ${rolePlan.nodeId} has no executor target`);
  return target;
}

function roleDockerEnv(
  rolePlan: ManagedClusterVllmRolePlan,
  config: CreateManagedClusterVllmExecutorOptions,
): Record<string, string> {
  const target = targetFor(rolePlan, config);
  const env =
    rolePlan.execution.kind === "local"
      ? buildLocalManagedVllmDockerEnv()
      : buildRemoteVllmDockerEnv(target.sshBinding!);
  delete env.VLLM_API_KEY;
  return env;
}

function processMatchesRole(
  rolePlan: ManagedClusterVllmRolePlan,
  containerId: string,
  env: Record<string, string>,
  deps: ManagedClusterVllmExecutorRuntimeDeps,
): boolean {
  const expected = base64url(
    JSON.stringify([rolePlan.command.executable, ...rolePlan.command.arguments]),
  );
  try {
    return (
      deps
        .dockerCapture(["exec", containerId, "python3", "-c", PROCESS_PROBE_SCRIPT, expected], {
          env,
          timeout: PROCESS_PROBE_TIMEOUT_MS,
        })
        .trim() === "ready"
    );
  } catch {
    return false;
  }
}

function inspectRoleNode(
  rolePlan: ManagedClusterVllmRolePlan,
  config: CreateManagedClusterVllmExecutorOptions,
  deps: ManagedClusterVllmExecutorRuntimeDeps,
): ManagedClusterNodeSnapshot {
  const env = roleDockerEnv(rolePlan, config);
  const rawIds = deps.dockerCapture(["container", "ls", "--all", "--no-trunc", "--quiet"], {
    env,
    timeout: DOCKER_INSPECTION_TIMEOUT_MS,
  });
  const ids = rawIds.split(/\r?\n/).filter(Boolean);
  if (
    ids.length > MAX_CONTAINERS ||
    ids.some((id) => !CONTAINER_ID_PATTERN.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    throw new Error(`${rolePlan.role} Docker container inventory is malformed or too large`);
  }
  const inspected = ids.length
    ? parseContainerRows(
        deps.dockerCapture(
          ["container", "inspect", "--format", CONTAINER_INSPECTION_FORMAT, ...ids],
          { env, timeout: DOCKER_INSPECTION_TIMEOUT_MS },
        ),
        ids,
      )
    : [];
  const containers: ManagedClusterObservedContainer[] = inspected.map((container) => ({
    ...container,
    healthy:
      container.running &&
      container.name === rolePlan.containerName &&
      container.image === rolePlan.image &&
      labelsMatch(container.labels, rolePlan.baseLabels) &&
      processMatchesRole(rolePlan, container.id, env, deps),
  }));
  const listeningPorts = parseListeningPorts(
    deps.captureListeners(rolePlan, targetFor(rolePlan, config).sshBinding),
  );
  return { containers, listeningPorts };
}

export interface ManagedClusterVllmNodeSnapshots {
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly snapshot: ManagedClusterNodeSnapshot;
  }[];
}

/** Synchronous read-only recovery seam backed by the production inspector. */
export function inspectManagedClusterVllmNodesSync(
  config: CreateManagedClusterVllmExecutorOptions,
  overrides: Partial<ManagedClusterVllmExecutorRuntimeDeps> = {},
): ManagedClusterVllmNodeSnapshots {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  assertManagedClusterVllmExecutorConfig(config);
  return {
    nodes: config.plan.roles.map((rolePlan) => ({
      nodeId: rolePlan.nodeId,
      snapshot: inspectRoleNode(rolePlan, config, deps),
    })),
  };
}

function exactWaitObservation(
  snapshot: ManagedClusterNodeSnapshot,
  request: ManagedClusterContainerWaitRequest,
): ManagedClusterObservedContainer | null {
  const matches = snapshot.containers.filter(({ id }) => id === request.containerId);
  if (matches.length !== 1) return null;
  const observed = matches[0]!;
  return observed.name === request.rolePlan.containerName &&
    observed.image === request.rolePlan.image &&
    labelsMatch(observed.labels, request.expectedLabels)
    ? observed
    : null;
}

function workerFirstBoundaryIsClear(
  snapshot: ManagedClusterNodeSnapshot,
  plan: ManagedClusterVllmPlan,
): boolean {
  return (
    !snapshot.listeningPorts.some((port) => port === plan.apiPort || port === plan.masterPort) &&
    !snapshot.containers.some(isRelatedManagedVllmContainer)
  );
}

async function waitForRoleProcess(
  request: ManagedClusterContainerWaitRequest,
  config: CreateManagedClusterVllmExecutorOptions,
  deps: ManagedClusterVllmExecutorRuntimeDeps,
  stableChecks: number,
  requireHeadAbsent = false,
): Promise<boolean> {
  const deadline = deps.now() + Math.min(Math.max(1, request.timeoutMs), MAX_PROCESS_WAIT_MS);
  let consecutive = 0;
  do {
    try {
      const observed = exactWaitObservation(
        inspectRoleNode(request.rolePlan, config, deps),
        request,
      );
      const headAbsent =
        !requireHeadAbsent ||
        workerFirstBoundaryIsClear(
          inspectRoleNode(managedClusterHeadRole(config.plan), config, deps),
          config.plan,
        );
      consecutive = observed?.running && observed.healthy && headAbsent ? consecutive + 1 : 0;
      if (consecutive >= stableChecks) return true;
    } catch {
      consecutive = 0;
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return false;
    await deps.sleep(Math.min(PROCESS_PROBE_INTERVAL_MS, remaining));
  } while (deps.now() <= deadline);
  return false;
}

function validApiBody(body: string, expectedModel: string, kind: "models" | "chat"): boolean {
  try {
    const parsed = JSON.parse(body) as { data?: unknown; model?: unknown; choices?: unknown };
    if (kind === "models") {
      const item = Array.isArray(parsed.data) && parsed.data.length === 1 ? parsed.data[0] : null;
      return (
        !!item &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as { id?: unknown }).id === expectedModel
      );
    }
    return (
      parsed.model === expectedModel &&
      Array.isArray(parsed.choices) &&
      parsed.choices.length === 1 &&
      typeof parsed.choices[0] === "object" &&
      parsed.choices[0] !== null
    );
  } catch {
    return false;
  }
}

async function probeAuthenticatedApi(
  request: ManagedClusterApiProbeRequest,
  kind: "models" | "chat",
  deps: ManagedClusterVllmExecutorRuntimeDeps,
): Promise<boolean> {
  if (!API_KEY_PATTERN.test(request.apiKey)) return false;
  const maximum = kind === "models" ? MAX_MODELS_PROBE_MS : MAX_CHAT_PROBE_MS;
  const deadline = deps.now() + Math.min(Math.max(1, request.timeoutMs), maximum);
  do {
    const remaining = Math.max(1, deadline - deps.now());
    const maxTimeSeconds = Math.max(1, Math.min(30, Math.ceil(remaining / 1000)));
    let authConfig: ReturnType<typeof createBearerAuthConfig> | undefined;
    try {
      authConfig = deps.createBearerAuthConfig(request.apiKey, {
        prefix: "nemoclaw-managed-cluster-vllm-probe",
      });
      const baseUrl = request.baseUrl.replace(/\/+$/, "");
      const body =
        kind === "chat"
          ? JSON.stringify({
              model: request.expectedModel,
              messages: [{ role: "user", content: "Reply with OK." }],
              max_tokens: 1,
              temperature: 0,
            })
          : null;
      const result = deps.runCurlProbe(
        [
          "-sS",
          "--connect-timeout",
          "3",
          "--max-time",
          String(maxTimeSeconds),
          ...(body ? ["-H", "Content-Type: application/json", "-d", body] : []),
          ...authConfig.args,
          `${baseUrl}/v1/${kind === "models" ? "models" : "chat/completions"}`,
        ],
        {
          trustedConfigFiles: authConfig.trustedConfigFiles,
          pinnedAddresses: [],
          timeoutMs: (maxTimeSeconds + 5) * 1000,
        },
      );
      if (result.ok && validApiBody(result.body, request.expectedModel, kind)) {
        return true;
      }
    } catch {
      // Retry until the caller-owned, bounded readiness deadline.
    } finally {
      authConfig?.cleanup();
    }
    const retryRemaining = deadline - deps.now();
    if (retryRemaining <= 0) return false;
    await deps.sleep(Math.min(API_PROBE_INTERVAL_MS, retryRemaining));
  } while (deps.now() <= deadline);
  return false;
}

/**
 * Bind the code-owned lifecycle to every exact Docker daemon and each qualified,
 * owner-only SSH handoff. Staging stays caller-injected so this module does not
 * depend on installer/model-download orchestration.
 */
export function createManagedClusterVllmExecutor(
  config: CreateManagedClusterVllmExecutorOptions,
  overrides: Partial<ManagedClusterVllmExecutorRuntimeDeps> = {},
): ManagedClusterVllmLifecycleDeps {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  assertManagedClusterVllmExecutorConfig(config);
  const capturedPlan = structuredClone(config.plan);
  const assertPlan = (plan: ManagedClusterVllmPlan): void => {
    if (!isDeepStrictEqual(plan, capturedPlan)) {
      throw new Error("Managed cluster executor refused a changed materialized plan");
    }
    assertManagedClusterVllmExecutorConfig(config);
  };
  const assertRole = (rolePlan: ManagedClusterVllmRolePlan): void => {
    assertPlan(config.plan);
    if (
      !isDeepStrictEqual(
        rolePlan,
        config.plan.roles.find(({ nodeId }) => nodeId === rolePlan.nodeId),
      )
    ) {
      throw new Error("Managed cluster executor refused a role outside its materialized plan");
    }
  };

  return {
    async inspectNode(rolePlan) {
      assertRole(rolePlan);
      return inspectRoleNode(rolePlan, config, deps);
    },
    async stageNode(request) {
      assertRole(request.rolePlan);
      if (!isDeepStrictEqual(request.preparation, request.rolePlan.preparation)) {
        return { ok: false, reason: `${request.rolePlan.role} preparation contract changed` };
      }
      if (!config.stageNode) {
        return { ok: false, reason: "managed cluster model and image staging is not configured" };
      }
      const dockerEnv = roleDockerEnv(request.rolePlan, config);
      const target = targetFor(request.rolePlan, config);
      return await config.stageNode(request, {
        nodeId: request.rolePlan.nodeId,
        dockerEnv,
        modelCacheRoot: target.modelCacheRoot,
        ...(target.sshBinding ? { sshBinding: target.sshBinding } : {}),
      });
    },
    async startContainer(request: ManagedClusterContainerStartRequest) {
      assertRole(request.rolePlan);
      if (!isDeepStrictEqual(request.preparation, request.rolePlan.preparation)) {
        return { ok: false, reason: `${request.rolePlan.role} preparation contract changed` };
      }
      const isHead = request.rolePlan.role === "head";
      if (
        (isHead && !API_KEY_PATTERN.test(request.bearerApiKey ?? "")) ||
        (!isHead && request.bearerApiKey !== undefined) ||
        (request.bearerApiKey && Object.values(request.labels).includes(request.bearerApiKey))
      ) {
        return { ok: false, reason: `${request.rolePlan.role} bearer-key boundary is invalid` };
      }
      let args: string[];
      try {
        args = buildManagedClusterVllmRunArgs(
          request.rolePlan,
          targetFor(request.rolePlan, config).modelCacheRoot,
          request.labels,
        );
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      if (request.bearerApiKey && JSON.stringify(args).includes(request.bearerApiKey)) {
        return { ok: false, reason: "managed cluster bearer key entered Docker argv" };
      }
      const env = roleDockerEnv(request.rolePlan, config);
      if (isHead) env.VLLM_API_KEY = request.bearerApiKey!;
      let result: ReturnType<typeof dockerRunDetached> | null = null;
      try {
        result = deps.dockerRunDetached(args, {
          env,
          ignoreError: true,
          suppressOutput: true,
          timeout: DOCKER_MUTATION_TIMEOUT_MS,
        });
      } catch {
        // Reconcile an exact transaction-owned create below.
      }
      let observed: ManagedClusterObservedContainer | null = null;
      try {
        const snapshot = inspectRoleNode(request.rolePlan, config, deps);
        const candidates = snapshot.containers.filter(
          (container) =>
            container.name === request.rolePlan.containerName &&
            container.image === request.rolePlan.image &&
            labelsMatch(container.labels, request.labels),
        );
        if (candidates.length === 1) observed = candidates[0]!;
      } catch {
        // A missing exact observation leaves the mutation uncommitted here.
      }
      const capturedId = String(result?.stdout ?? "").trim();
      const exactId = CONTAINER_ID_PATTERN.test(capturedId) ? capturedId : observed?.id;
      if (
        exactId &&
        observed?.id === exactId &&
        observed.running &&
        (result === null || mutationSucceeded(result))
      ) {
        return { ok: true, containerId: exactId };
      }
      return {
        ok: false,
        ...(exactId ? { containerId: exactId } : {}),
        reason: `${request.rolePlan.role} Docker create did not commit one exact running container`,
      };
    },
    async waitForContainerReady(request) {
      assertRole(request.rolePlan);
      return await waitForRoleProcess(request, config, deps, 1);
    },
    async waitForWorkerDistributedReady(request) {
      assertRole(request.rolePlan);
      if (request.rolePlan.role !== "worker") return false;
      // Two spaced exact-process observations prove the worker remained alive
      // while rank 0 was still absent, the worker-first rendezvous boundary.
      return await waitForRoleProcess(request, config, deps, 2, true);
    },
    async removeContainer(rolePlan, exactContainerId) {
      assertRole(rolePlan);
      if (!CONTAINER_ID_PATTERN.test(exactContainerId)) {
        return { ok: false, reason: `${rolePlan.role} cleanup container ID is invalid` };
      }
      const before = inspectRoleNode(rolePlan, config, deps);
      const matches = before.containers.filter(({ id }) => id === exactContainerId);
      if (
        matches.length !== 1 ||
        matches[0]!.name !== rolePlan.containerName ||
        matches[0]!.image !== rolePlan.image ||
        !labelsMatch(matches[0]!.labels, rolePlan.baseLabels)
      ) {
        return { ok: false, reason: `${rolePlan.role} exact cleanup ownership changed` };
      }
      const env = roleDockerEnv(rolePlan, config);
      let removed = false;
      try {
        removed = mutationSucceeded(
          deps.dockerForceRm(exactContainerId, {
            env,
            ignoreError: true,
            suppressOutput: true,
            timeout: DOCKER_MUTATION_TIMEOUT_MS,
          }),
        );
      } catch {
        // Reconcile the exact ID below.
      }
      if (!removed) {
        try {
          const after = inspectRoleNode(rolePlan, config, deps);
          removed = !after.containers.some(({ id }) => id === exactContainerId);
        } catch {
          removed = false;
        }
      }
      return removed
        ? { ok: true }
        : { ok: false, reason: `${rolePlan.role} exact container removal failed` };
    },
    async probeModels(request) {
      assertPlan(config.plan);
      if (
        request.baseUrl !== managedClusterHeadRole(config.plan).endpoint ||
        request.expectedModel !== config.plan.readiness.expectedModel
      ) {
        return false;
      }
      return await probeAuthenticatedApi(request, "models", deps);
    },
    async probeChat(request) {
      assertPlan(config.plan);
      if (
        request.baseUrl !== managedClusterHeadRole(config.plan).endpoint ||
        request.expectedModel !== config.plan.readiness.expectedModel
      ) {
        return false;
      }
      return await probeAuthenticatedApi(request, "chat", deps);
    },
    createTransactionId: deps.createTransactionId,
    async withLifecycleLock(plan, operation) {
      assertPlan(plan);
      return await deps.withLifecycleLock(operation);
    },
  };
}
