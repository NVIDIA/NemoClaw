// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { dockerCapture, dockerForceRm, dockerRunDetached } from "../adapters/docker";
import { DUAL_STATION_VLLM_API_KEY_PATTERN, loadDualStationVllmApiKey } from "./vllm-api-key";
import { buildLocalDualStationDockerEnv, buildRemoteVllmDockerEnv } from "./vllm-docker-env";
import { buildNemotronUltraDistributedServeCommand } from "./vllm-models";
import { DUAL_STATION_VLLM_RUNTIME, type DualStationVllmPlan } from "./vllm-station-cluster";
import {
  assertDualStationControllerAccount,
  readDualStationControllerUid,
  withDualStationVllmLifecycleLock,
} from "./vllm-station-lifecycle-lock";
import {
  assertDualStationSshBindingFiles,
  type DualStationSshBinding,
} from "./vllm-station-ssh-binding";

export const DUAL_STATION_VLLM_HEAD_CONTAINER_NAME = "nemoclaw-vllm";
export const DUAL_STATION_VLLM_WORKER_CONTAINER_NAME = "nemoclaw-vllm-worker";
export const DUAL_STATION_VLLM_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm";
export const DUAL_STATION_VLLM_ROLE_LABEL = "com.nvidia.nemoclaw.vllm-role";
export const DUAL_STATION_VLLM_ENDPOINT_LABEL = "com.nvidia.nemoclaw.vllm-endpoint";
export const DUAL_STATION_VLLM_CLUSTER_LABEL = "com.nvidia.nemoclaw.vllm-cluster";
export const DUAL_STATION_VLLM_GPU_LABEL = "com.nvidia.nemoclaw.vllm-gpu";
export const DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL = "com.nvidia.nemoclaw.vllm-launch-schema";
export const DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL = "com.nvidia.nemoclaw.vllm-launch-contract";
export const DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL =
  "com.nvidia.nemoclaw.vllm-api-key-fingerprint";
export const DUAL_STATION_VLLM_TRANSACTION_LABEL = "com.nvidia.nemoclaw.vllm-transaction";
export const DUAL_STATION_VLLM_GPU_SMOKE_LABEL = "com.nvidia.nemoclaw.gpu-smoke";
export const DUAL_STATION_VLLM_MASTER_PORT = 6379;

const HEAD_API_PORT = 8000;
// The pinned Station vLLM images ship a non-root-ready /home/vllm. Each Station
// mounts an owner-only tmpfs there and runs as the probed model-cache owner.
const VLLM_RUNTIME_HOME = "/home/vllm";
const HF_CACHE_CONTAINER_DIR = `${VLLM_RUNTIME_HOME}/.cache/huggingface`;
const HF_HUB_CACHE_CONTAINER_DIR = "/model-cache";
const FLASHINFER_CUBIN_RUNTIME_DIR =
  "/usr/local/lib/python3.12/dist-packages/flashinfer_cubin/cubins/flashinfer";
const DOCKER_INSPECT_TIMEOUT_MS = 10_000;
const DOCKER_MUTATION_TIMEOUT_MS = 60_000;
const DOCKER_GPU_SMOKE_TIMEOUT_MS = 30_000;
const DOCKER_LATE_CREATE_RECONCILE_ATTEMPTS = 5;
const DOCKER_LATE_CREATE_RECONCILE_INTERVAL_MS = 250;
const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const CLUSTER_ID_PATTERN = /^[a-f0-9]{64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const IMMUTABLE_IMAGE_PATTERN = /^(?:[^\s/@]+\/)+[^\s/@]+@sha256:[a-f0-9]{64}$/;
const IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_DEVICE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SAFE_UVERBS_DEVICE_PATTERN = /^\/dev\/infiniband\/uverbs[0-9]+$/;
const SAFE_GPU_UUID_PATTERN = /^GPU-[A-Za-z0-9-]{8,123}$/;
const GPU_SMOKE_NONCE_PATTERN = /^[a-f0-9]{32}$/;
const TRANSACTION_ID_PATTERN = /^[a-f0-9]{32}$/;
const GPU_SMOKE_CONTAINER_PREFIX = "nemoclaw-vllm-gpu-smoke";
export const DUAL_STATION_VLLM_LAUNCH_SCHEMA = "2";
const VLLM_FINGERPRINT_CONTEXT = "nemoclaw-dual-station-vllm-api-key\0";
// Compatibility bridge for schema-less single-Station Ultra containers from
// the v0.0.86 rollback window before dual launch schema 1.
// Do not add future image digests; retire this branch when v0.0.86 support ends.
const LEGACY_SINGLE_STATION_MIGRATION_IMAGE =
  "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416";

export type DualStationVllmRole = "head" | "worker";

export interface DualStationDockerOptions {
  env?: NodeJS.ProcessEnv;
  ignoreError?: boolean;
  suppressOutput?: boolean;
  timeout?: number;
}

export interface DualStationDockerResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
  signal?: NodeJS.Signals | null;
}

export interface DualStationVllmLifecycleDeps {
  dockerCapture(args: readonly string[], options?: DualStationDockerOptions): string;
  dockerForceRm(containerId: string, options?: DualStationDockerOptions): DualStationDockerResult;
  dockerRunDetached(
    args: readonly string[],
    options?: DualStationDockerOptions,
  ): DualStationDockerResult;
  buildLocalDockerEnv(): Record<string, string>;
  buildRemoteDockerEnv(binding: DualStationSshBinding): Record<string, string>;
  createProbeNonce(): string;
  createTransactionId(): string;
  effectiveControllerUid(): number | null;
  readControllerUid(): number;
  onManagedHeadObserved?(): void;
  waitBeforeReconcile(ms: number): Promise<void>;
  withLifecycleLock<T>(operation: () => Promise<T> | T): Promise<T>;
  loadApiKey(): string | null;
  localInterfaceAddresses(): readonly string[];
}

export interface DualStationVllmStartConfig {
  /** A caller-owned 256-bit API key. It is never persisted by the lifecycle. */
  apiKey: string;
}

export interface DualStationLegacyMigration {
  backupContainerName: string;
  legacyContainerId: string;
  transactionId: string;
  headContainerId: string;
  workerContainerId: string;
}

export type StartDualStationVllmResult =
  | {
      ok: true;
      baseUrl: string;
      headContainerId: string;
      workerContainerId: string;
      /** True when an already-running exact owned pair was left untouched. */
      reusedExisting: boolean;
      /** Present until the caller commits or rolls back external validation. */
      legacyMigration?: DualStationLegacyMigration;
    }
  | { ok: false; reason: string; rollbackErrors: string[] };

export type CleanupDualStationVllmResult =
  | { ok: true; removedContainerIds: string[] }
  | { ok: false; reason: string };

export type PreflightDualStationVllmResult = { ok: true } | { ok: false; reason: string };

export type CommitDualStationLegacyMigrationResult =
  | { ok: true; cleanupWarnings: string[] }
  | { ok: false; reason: string };

export type RollbackDualStationLegacyMigrationResult =
  | { ok: true }
  | { ok: false; rollbackErrors: string[] };

type ManagedContainerSpec = {
  role: DualStationVllmRole;
  name: string;
  endpoint: string;
  clusterId: string;
  gpuUuid: string;
  image: string;
  launchContract: string;
  apiKeyFingerprint: string | null;
  env: Record<string, string>;
};

type ManagedContainerInspection =
  | { kind: "absent" }
  | {
      kind: "managed";
      containerId: string;
      running: boolean;
      transactionId: string;
      reusable: boolean;
    }
  | { kind: "legacy-managed"; containerId: string; running: boolean }
  | { kind: "foreign" | "ambiguous" | "unknown" };

type LegacyHeadCutover = {
  originalSpec: ManagedContainerSpec;
  backupSpec: ManagedContainerSpec;
  containerId: string;
};

type GpuSmokeSpec = {
  role: DualStationVllmRole;
  containerName: string;
  nonce: string;
  image: string;
  expectedGpuUuid: string;
  env: Record<string, string>;
};

type GpuSmokeInspection =
  | { kind: "absent" }
  | { kind: "owned"; containerId: string }
  | { kind: "foreign" | "ambiguous" | "unknown" };

const DEFAULT_DEPS: DualStationVllmLifecycleDeps = {
  dockerCapture,
  dockerForceRm,
  dockerRunDetached,
  buildLocalDockerEnv: buildLocalDualStationDockerEnv,
  buildRemoteDockerEnv: buildRemoteVllmDockerEnv,
  createProbeNonce: () => randomBytes(16).toString("hex"),
  createTransactionId: () => randomBytes(16).toString("hex"),
  effectiveControllerUid: () => process.getuid?.() ?? null,
  readControllerUid: readDualStationControllerUid,
  onManagedHeadObserved: () => undefined,
  waitBeforeReconcile: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  withLifecycleLock: withDualStationVllmLifecycleLock,
  loadApiKey: loadDualStationVllmApiKey,
  localInterfaceAddresses: () =>
    Object.values(os.networkInterfaces()).flatMap((addresses) =>
      (addresses ?? []).flatMap((address) =>
        address.family === "IPv4" && !address.internal ? [address.address] : [],
      ),
    ),
};

function depsWith(
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): DualStationVllmLifecycleDeps {
  return { ...DEFAULT_DEPS, ...overrides };
}

function isRfc1918Ipv4(address: string): boolean {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split(".").map(Number);
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
  );
}

function assertSafePlan(plan: DualStationVllmPlan): void {
  assertDualStationSshBindingFiles(plan.peerSshBinding);
  if (
    !IMMUTABLE_IMAGE_PATTERN.test(plan.runtime.image) ||
    plan.runtime.image !== DUAL_STATION_VLLM_RUNTIME.image ||
    plan.runtime.modelId !== DUAL_STATION_VLLM_RUNTIME.modelId ||
    plan.runtime.modelRevision !== DUAL_STATION_VLLM_RUNTIME.modelRevision ||
    plan.runtime.servedModelId !== DUAL_STATION_VLLM_RUNTIME.servedModelId ||
    plan.runtime.tensorParallelSize !== DUAL_STATION_VLLM_RUNTIME.tensorParallelSize ||
    plan.runtime.pipelineParallelSize !== DUAL_STATION_VLLM_RUNTIME.pipelineParallelSize ||
    plan.runtime.nodeCount !== DUAL_STATION_VLLM_RUNTIME.nodeCount
  ) {
    throw new Error("Dual-Station vLLM requires the exact pinned runtime contract.");
  }
  if (plan.rails.length !== 2 || plan.masterAddress !== plan.rails[0]?.local.address) {
    throw new Error("Dual-Station vLLM requires exactly two ordered rails and a rail-0 master.");
  }
  if (!Number.isInteger(plan.roceGidIndex) || plan.roceGidIndex < 0 || plan.roceGidIndex > 4095) {
    throw new Error("Dual-Station vLLM requires a valid shared RoCE GID index.");
  }
  for (const [role, node] of [
    ["local", plan.local],
    ["peer", plan.peer],
  ] as const) {
    if (
      !path.posix.isAbsolute(node.home) ||
      path.posix.normalize(node.home) !== node.home ||
      node.home.includes(":")
    ) {
      throw new Error(`Dual-Station ${role} home must be a normalized absolute POSIX path.`);
    }
    if (
      !Number.isInteger(node.uid) ||
      node.uid <= 0 ||
      node.uid > 2_147_483_647 ||
      !Number.isInteger(node.gid) ||
      node.gid <= 0 ||
      node.gid > 2_147_483_647
    ) {
      throw new Error(
        `Dual-Station ${role} runtime identity must use non-root UID and GID values.`,
      );
    }
    if (!SAFE_GPU_UUID_PATTERN.test(node.gpu.uuid)) {
      throw new Error(`Dual-Station ${role} GB300 UUID is invalid.`);
    }
  }
  for (const side of ["local", "peer"] as const) {
    const endpoints = plan.rails.map((rail) => rail[side]);
    if (
      new Set(endpoints.map((endpoint) => endpoint.rdmaDevice)).size !== 2 ||
      new Set(endpoints.map((endpoint) => endpoint.netdev)).size !== 2 ||
      new Set(endpoints.map((endpoint) => endpoint.uverbsDevice)).size !== 2
    ) {
      throw new Error(`Dual-Station ${side} rails must use two distinct devices.`);
    }
    for (const endpoint of endpoints) {
      if (
        !SAFE_DEVICE_NAME_PATTERN.test(endpoint.rdmaDevice) ||
        !SAFE_DEVICE_NAME_PATTERN.test(endpoint.netdev) ||
        !SAFE_UVERBS_DEVICE_PATTERN.test(endpoint.uverbsDevice) ||
        !isRfc1918Ipv4(endpoint.address)
      ) {
        throw new Error(`Dual-Station ${side} rail endpoint is invalid.`);
      }
    }
  }
}

function clusterIdForPlan(plan: DualStationVllmPlan): string {
  const identity = {
    runtime: plan.runtime,
    local: {
      hostname: plan.local.hostname,
      gpuUuid: plan.local.gpu.uuid,
    },
    peer: {
      hostname: plan.peer.hostname,
      gpuUuid: plan.peer.gpu.uuid,
    },
    rails: plan.rails.map((rail) => ({
      index: rail.index,
      subnet: rail.subnet,
      local: rail.local,
      peer: rail.peer,
    })),
    masterAddress: plan.masterAddress,
    roceGidIndex: plan.roceGidIndex,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Stable identity binding both managed containers to one exact physical plan. */
export function dualStationVllmClusterId(plan: DualStationVllmPlan): string {
  assertSafePlan(plan);
  return clusterIdForPlan(plan);
}

function assertSafeStartConfig(config: DualStationVllmStartConfig): void {
  if (!DUAL_STATION_VLLM_API_KEY_PATTERN.test(config.apiKey)) {
    throw new Error(
      "Dual-Station vLLM API key must be exactly 64 lowercase hexadecimal characters.",
    );
  }
}

/** Domain-separated, non-secret binding for the host-persisted high-entropy service key. */
export function dualStationVllmApiKeyFingerprint(apiKey: string): string {
  if (!DUAL_STATION_VLLM_API_KEY_PATTERN.test(apiKey)) {
    throw new Error(
      "Dual-Station vLLM API key must be exactly 64 lowercase hexadecimal characters.",
    );
  }
  return createHmac("sha256", Buffer.from(apiKey, "hex"))
    .update(VLLM_FINGERPRINT_CONTEXT)
    .digest("hex");
}

function withoutVllmApiKey(env: Record<string, string>): Record<string, string> {
  const sanitized = { ...env };
  delete sanitized.VLLM_API_KEY;
  return sanitized;
}

function endpointFor(plan: DualStationVllmPlan, role: DualStationVllmRole): string {
  return role === "head" ? `http://${plan.masterAddress}:${String(HEAD_API_PORT)}` : "headless";
}

function nameFor(role: DualStationVllmRole): string {
  return role === "head"
    ? DUAL_STATION_VLLM_HEAD_CONTAINER_NAME
    : DUAL_STATION_VLLM_WORKER_CONTAINER_NAME;
}

function appendEnv(args: string[], name: string, value: string): void {
  args.push("--env", `${name}=${value}`);
}

function runtimeUser(node: DualStationVllmPlan["local"]): string {
  return `${String(node.uid)}:${String(node.gid)}`;
}

function runtimeHomeTmpfs(
  node: DualStationVllmPlan["local"],
  execution: "exec" | "noexec",
): string {
  return `${VLLM_RUNTIME_HOME}:rw,nosuid,nodev,${execution},uid=${String(node.uid)},gid=${String(node.gid)},mode=0700,size=68719476736`;
}

function flashinferCubinTmpfs(node: DualStationVllmPlan["local"]): string {
  return `${FLASHINFER_CUBIN_RUNTIME_DIR}:rw,nosuid,nodev,noexec,uid=${String(node.uid)},gid=${String(node.gid)},mode=0700,size=16777216`;
}

function appendRuntimeHomeEnv(args: string[]): void {
  appendEnv(args, "HOME", VLLM_RUNTIME_HOME);
  appendEnv(args, "USER", "vllm");
  appendEnv(args, "LOGNAME", "vllm");
}

/** Build the deterministic shell-free launch argv before per-operation labels. */
function buildDualStationVllmBaseRunArgs(
  plan: DualStationVllmPlan,
  role: DualStationVllmRole,
): string[] {
  assertSafePlan(plan);
  const node = role === "head" ? plan.local : plan.peer;
  const endpoints = plan.rails.map((rail) => (role === "head" ? rail.local : rail.peer));
  const endpoint = endpointFor(plan, role);
  const clusterId = clusterIdForPlan(plan);
  const args = [
    "--pull=never",
    "--init",
    "--restart",
    "unless-stopped",
    "--network",
    "host",
    "--shm-size",
    "16g",
    "--read-only",
    "--workdir",
    VLLM_RUNTIME_HOME,
    "--user",
    runtimeUser(node),
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=17179869184",
    "--tmpfs",
    // FlashInfer links generated-kernel headers beneath its installed cubin
    // package. Keep only that empty subtree writable; packaged cubins and the
    // rest of the image remain read-only.
    flashinferCubinTmpfs(node),
    "--tmpfs",
    // Ray is installed under this home and loads its native _raylet module.
    // Docker tmpfs mounts default to noexec, so managed serving opts in.
    runtimeHomeTmpfs(node, "exec"),
    "--cap-drop",
    "ALL",
    // Non-root GPU/RDMA memory registration is bounded by this explicit rlimit;
    // no Linux capabilities remain in the effective or permitted set.
    "--ulimit",
    "memlock=-1",
    "--ulimit",
    "stack=67108864",
    "--ulimit",
    "nofile=1048576:1048576",
    "--gpus",
    `device=${node.gpu.uuid}`,
    ...endpoints.map((endpoint) => `--device=${endpoint.uverbsDevice}`),
    "--volume",
    `${node.home}/.cache/huggingface/hub:${HF_HUB_CACHE_CONTAINER_DIR}:ro`,
    "--label",
    `${DUAL_STATION_VLLM_MANAGED_LABEL}=true`,
    "--label",
    `${DUAL_STATION_VLLM_ROLE_LABEL}=${role}`,
    "--label",
    `${DUAL_STATION_VLLM_ENDPOINT_LABEL}=${endpoint}`,
    "--label",
    `${DUAL_STATION_VLLM_CLUSTER_LABEL}=${clusterId}`,
    "--label",
    `${DUAL_STATION_VLLM_GPU_LABEL}=${node.gpu.uuid}`,
    "--name",
    nameFor(role),
  ];

  appendEnv(args, "HF_HOME", HF_CACHE_CONTAINER_DIR);
  appendEnv(args, "HF_HUB_CACHE", HF_HUB_CACHE_CONTAINER_DIR);
  appendEnv(args, "HUGGINGFACE_HUB_CACHE", HF_HUB_CACHE_CONTAINER_DIR);
  appendRuntimeHomeEnv(args);
  appendEnv(args, "HF_HUB_OFFLINE", "1");
  appendEnv(args, "TRANSFORMERS_OFFLINE", "1");
  appendEnv(args, "VLLM_HOST_IP", endpoints[0].address);
  appendEnv(args, "VLLM_EXECUTE_MODEL_TIMEOUT_SECONDS", role === "head" ? "7200" : "3600");
  appendEnv(args, "VLLM_ALLOW_LONG_MAX_MODEL_LEN", "1");
  appendEnv(args, "NCCL_IB_HCA", endpoints.map((item) => item.rdmaDevice).join(","));
  appendEnv(args, "NCCL_IB_DISABLE", "0");
  appendEnv(args, "NCCL_IB_ADDR_FAMILY", "AF_INET");
  appendEnv(args, "NCCL_IB_ROCE_VERSION_NUM", "2");
  appendEnv(args, "NCCL_IB_GID_INDEX", String(plan.roceGidIndex));
  appendEnv(args, "NCCL_IB_TC", "106");
  appendEnv(args, "NCCL_IB_QPS_PER_CONNECTION", "4");
  appendEnv(args, "NCCL_NET_GDR_LEVEL", "PHB");
  appendEnv(args, "NCCL_IB_PCI_RELAXED_ORDERING", "1");
  appendEnv(args, "NCCL_SOCKET_IFNAME", endpoints[0].netdev);
  appendEnv(args, "GLOO_SOCKET_IFNAME", endpoints[0].netdev);
  appendEnv(args, "TP_SOCKET_IFNAME", endpoints[0].netdev);
  appendEnv(args, "OMPI_MCA_btl_tcp_if_include", endpoints[0].netdev);
  appendEnv(args, "MN_IF_NAME", endpoints[0].netdev);
  appendEnv(args, "NCCL_IGNORE_CPU_AFFINITY", "1");
  appendEnv(args, "UCX_NET_DEVICES", endpoints.map((item) => `${item.rdmaDevice}:1`).join(","));
  appendEnv(args, "UCX_TLS", "rc_x,cuda_copy,cuda_ipc,gdr_copy");
  appendEnv(args, "UCX_IB_GID_INDEX", String(plan.roceGidIndex));
  appendEnv(args, "UCX_RNDV_THRESH", "8192");

  if (role === "head") {
    // Docker resolves this bare name from the head docker-run subprocess. The
    // secret value must never enter argv, labels, or the worker environment.
    args.push("--env", "VLLM_API_KEY");
  }

  args.push(
    "--entrypoint",
    "/bin/bash",
    plan.runtime.image,
    "-lc",
    buildNemotronUltraDistributedServeCommand({
      nodeRank: role === "head" ? 0 : 1,
      masterAddr: plan.masterAddress,
      masterPort: DUAL_STATION_VLLM_MASTER_PORT,
      nodeAddr: endpoints[0].address,
    }),
  );
  return args;
}

/** Stable digest of the exact role-local launch argv and its schema. */
export function dualStationVllmLaunchContract(
  plan: DualStationVllmPlan,
  role: DualStationVllmRole,
): string {
  const contract = {
    schema: DUAL_STATION_VLLM_LAUNCH_SCHEMA,
    role,
    args: buildDualStationVllmBaseRunArgs(plan, role),
  };
  return createHash("sha256").update(JSON.stringify(contract)).digest("hex");
}

/** Build the complete launch argv with non-secret transaction/config bindings. */
export function buildDualStationVllmRunArgs(
  plan: DualStationVllmPlan,
  role: DualStationVllmRole,
  transactionId: string,
  apiKeyFingerprint: string,
): string[] {
  if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw new Error("Dual-Station vLLM transaction ID is invalid.");
  }
  if (!SHA256_HEX_PATTERN.test(apiKeyFingerprint)) {
    throw new Error("Dual-Station vLLM API key fingerprint is invalid.");
  }
  const args = buildDualStationVllmBaseRunArgs(plan, role);
  const nameIndex = args.indexOf("--name");
  args.splice(
    nameIndex,
    0,
    "--label",
    `${DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL}=${DUAL_STATION_VLLM_LAUNCH_SCHEMA}`,
    "--label",
    `${DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL}=${dualStationVllmLaunchContract(plan, role)}`,
    "--label",
    `${DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL}=${apiKeyFingerprint}`,
    "--label",
    `${DUAL_STATION_VLLM_TRANSACTION_LABEL}=${transactionId}`,
  );
  return args;
}

/** Build a no-network, no-pull GPU/RDMA runtime probe that finishes with nvidia-smi. */
export function buildDualStationGpuSmokeRunArgs(
  plan: DualStationVllmPlan,
  role: DualStationVllmRole,
  nonce: string,
): { containerName: string; args: string[] } {
  assertSafePlan(plan);
  if (!GPU_SMOKE_NONCE_PATTERN.test(nonce)) {
    throw new Error("Dual-Station GPU smoke nonce is invalid.");
  }
  const node = role === "head" ? plan.local : plan.peer;
  const endpoints = plan.rails.map((rail) => (role === "head" ? rail.local : rail.peer));
  const containerName = `${GPU_SMOKE_CONTAINER_PREFIX}-${role}-${nonce}`;
  const command = [
    "set -euo pipefail",
    `test \"$(id -u)\" = \"${String(node.uid)}\"`,
    `test \"$(id -g)\" = \"${String(node.gid)}\"`,
    "grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status",
    "! grep -Eq '^Cap(Inh|Prm|Eff|Bnd|Amb):[[:space:]]+[0-9a-fA-F]*[1-9a-fA-F][0-9a-fA-F]*$' /proc/self/status",
    'test "$(ulimit -l)" = "unlimited"',
    `for device in ${endpoints.map((endpoint) => endpoint.uverbsDevice).join(" ")}; do test -c "$device"; test -r "$device"; test -w "$device"; exec 3<>"$device"; exec 3>&-; done`,
    'mkdir -p "$HOME/.cache/torch" "$HF_HOME"',
    'probe="$HOME/.cache/torch/.nemoclaw-write-probe"; : > "$probe"; rm -f "$probe"',
    'probe="$HF_HOME/.nemoclaw-write-probe"; : > "$probe"; rm -f "$probe"',
    "exec nvidia-smi --query-gpu=uuid --format=csv,noheader",
  ].join("; ");
  const args = [
    "--pull=never",
    "--network",
    "none",
    "--read-only",
    "--workdir",
    VLLM_RUNTIME_HOME,
    "--user",
    runtimeUser(node),
    "--security-opt",
    "no-new-privileges:true",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=17179869184",
    "--tmpfs",
    runtimeHomeTmpfs(node, "noexec"),
    "--cap-drop",
    "ALL",
    "--ulimit",
    "memlock=-1",
    "--gpus",
    `device=${node.gpu.uuid}`,
    ...endpoints.flatMap((endpoint) => ["--device", endpoint.uverbsDevice]),
    "--label",
    `${DUAL_STATION_VLLM_GPU_SMOKE_LABEL}=${nonce}`,
    "--label",
    `${DUAL_STATION_VLLM_ROLE_LABEL}=${role}`,
    "--name",
    containerName,
  ];
  appendEnv(args, "HF_HOME", HF_CACHE_CONTAINER_DIR);
  appendRuntimeHomeEnv(args);
  args.push("--entrypoint", "/bin/bash", plan.runtime.image, "-c", command);
  return {
    containerName,
    args,
  };
}

function specsForPlan(
  plan: DualStationVllmPlan,
  deps: DualStationVllmLifecycleDeps,
  config?: DualStationVllmStartConfig,
): { head: ManagedContainerSpec; worker: ManagedContainerSpec } {
  assertSafePlan(plan);
  const controllerUid = assertDualStationControllerAccount(
    deps.readControllerUid,
    deps.effectiveControllerUid,
  );
  if (controllerUid !== plan.local.uid) {
    throw new Error(
      `Dual-Station lifecycle controller UID must match probed local UID ${String(plan.local.uid)}`,
    );
  }
  const clusterId = clusterIdForPlan(plan);
  const apiKeyFingerprint = config ? dualStationVllmApiKeyFingerprint(config.apiKey) : null;
  return {
    head: {
      role: "head",
      name: DUAL_STATION_VLLM_HEAD_CONTAINER_NAME,
      endpoint: endpointFor(plan, "head"),
      clusterId,
      gpuUuid: plan.local.gpu.uuid,
      image: plan.runtime.image,
      launchContract: dualStationVllmLaunchContract(plan, "head"),
      apiKeyFingerprint,
      env: withoutVllmApiKey(deps.buildLocalDockerEnv()),
    },
    worker: {
      role: "worker",
      name: DUAL_STATION_VLLM_WORKER_CONTAINER_NAME,
      endpoint: endpointFor(plan, "worker"),
      clusterId,
      gpuUuid: plan.peer.gpu.uuid,
      image: plan.runtime.image,
      launchContract: dualStationVllmLaunchContract(plan, "worker"),
      apiKeyFingerprint,
      env: withoutVllmApiKey(deps.buildRemoteDockerEnv(plan.peerSshBinding)),
    },
  };
}

const INSPECTION_FORMAT = [
  "{{.ID}}",
  "{{.Names}}",
  "{{.State}}",
  "{{.Image}}",
  `{{.Label \"${DUAL_STATION_VLLM_MANAGED_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_ROLE_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_ENDPOINT_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_CLUSTER_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_GPU_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_LAUNCH_SCHEMA_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_LAUNCH_CONTRACT_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_API_KEY_FINGERPRINT_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_TRANSACTION_LABEL}\"}}`,
].join("\t");

function inspectRows(
  containerName: string,
  env: Record<string, string>,
  deps: DualStationVllmLifecycleDeps,
): string[][] | null {
  try {
    const output = deps.dockerCapture(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${containerName}$`,
        "--format",
        INSPECTION_FORMAT,
      ],
      { env, timeout: DOCKER_INSPECT_TIMEOUT_MS },
    );
    if (!output.trim()) return [];
    return output
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split("\t"));
  } catch {
    return null;
  }
}

function inspectManagedContainer(
  spec: ManagedContainerSpec,
  deps: DualStationVllmLifecycleDeps,
  options: { allowStoppedLegacy?: boolean } = {},
): ManagedContainerInspection {
  const rows = inspectRows(spec.name, spec.env, deps);
  if (rows === null) return { kind: "unknown" };
  if (rows.length === 0) return { kind: "absent" };
  if (rows.length !== 1) return { kind: "ambiguous" };
  const [
    containerId,
    name,
    state,
    image,
    managed,
    role,
    endpoint,
    clusterId,
    gpuUuid,
    launchSchema,
    launchContract,
    apiKeyFingerprint,
    transactionId,
  ] = rows[0];
  if (!containerId || rows[0].length !== 13 || !DOCKER_CONTAINER_ID_PATTERN.test(containerId)) {
    return { kind: "unknown" };
  }
  if (
    spec.role === "head" &&
    name === spec.name &&
    image === LEGACY_SINGLE_STATION_MIGRATION_IMAGE &&
    (state === "running" || (options.allowStoppedLegacy && state === "exited")) &&
    managed === "true" &&
    !role &&
    !endpoint &&
    !clusterId &&
    !gpuUuid &&
    !launchSchema &&
    !launchContract &&
    !apiKeyFingerprint &&
    !transactionId
  ) {
    return { kind: "legacy-managed", containerId, running: state === "running" };
  }
  if (
    name !== spec.name ||
    image !== spec.image ||
    managed !== "true" ||
    role !== spec.role ||
    endpoint !== spec.endpoint ||
    clusterId !== spec.clusterId ||
    gpuUuid !== spec.gpuUuid ||
    launchSchema !== DUAL_STATION_VLLM_LAUNCH_SCHEMA ||
    !SHA256_HEX_PATTERN.test(launchContract) ||
    !SHA256_HEX_PATTERN.test(apiKeyFingerprint) ||
    !TRANSACTION_ID_PATTERN.test(transactionId)
  ) {
    return { kind: "foreign" };
  }
  const reusable =
    launchContract === spec.launchContract &&
    (spec.apiKeyFingerprint === null || apiKeyFingerprint === spec.apiKeyFingerprint);
  return { kind: "managed", containerId, running: state === "running", transactionId, reusable };
}

const GPU_SMOKE_INSPECTION_FORMAT = [
  "{{.ID}}",
  "{{.Names}}",
  "{{.Image}}",
  `{{.Label \"${DUAL_STATION_VLLM_GPU_SMOKE_LABEL}\"}}`,
  `{{.Label \"${DUAL_STATION_VLLM_ROLE_LABEL}\"}}`,
].join("\t");

function inspectGpuSmokeContainer(
  spec: GpuSmokeSpec,
  deps: DualStationVllmLifecycleDeps,
): GpuSmokeInspection {
  let output: string;
  try {
    output = deps.dockerCapture(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${spec.containerName}$`,
        "--format",
        GPU_SMOKE_INSPECTION_FORMAT,
      ],
      { env: spec.env, timeout: DOCKER_INSPECT_TIMEOUT_MS },
    );
  } catch {
    return { kind: "unknown" };
  }
  if (!output.trim()) return { kind: "absent" };
  const rows = output
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("\t"));
  if (rows.length !== 1) return { kind: "ambiguous" };
  const [containerId, name, image, nonce, role] = rows[0];
  if (!containerId || rows[0].length !== 5 || !DOCKER_CONTAINER_ID_PATTERN.test(containerId)) {
    return { kind: "unknown" };
  }
  if (
    name !== spec.containerName ||
    image !== spec.image ||
    nonce !== spec.nonce ||
    role !== spec.role
  ) {
    return { kind: "foreign" };
  }
  return { kind: "owned", containerId };
}

function pinnedImageIsPresent(
  spec: ManagedContainerSpec,
  deps: DualStationVllmLifecycleDeps,
): boolean {
  try {
    const output = deps.dockerCapture(["image", "inspect", "--format", "{{.Id}}", spec.image], {
      env: spec.env,
      timeout: DOCKER_INSPECT_TIMEOUT_MS,
    });
    const ids = output.trim().split(/\r?\n/).filter(Boolean);
    return ids.length === 1 && IMAGE_ID_PATTERN.test(ids[0]);
  } catch {
    return false;
  }
}

function mutationSucceeded(result: DualStationDockerResult): boolean {
  return result.status === 0 && !result.error && !result.signal;
}

function resultContainerId(result: DualStationDockerResult): string | null {
  const value = String(result.stdout ?? "").trim();
  return DOCKER_CONTAINER_ID_PATTERN.test(value) ? value : null;
}

function removeGpuSmokeExact(
  spec: GpuSmokeSpec,
  containerId: string,
  deps: DualStationVllmLifecycleDeps,
): boolean {
  try {
    return mutationSucceeded(
      deps.dockerForceRm(containerId, {
        env: spec.env,
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_MUTATION_TIMEOUT_MS,
      }),
    );
  } catch {
    return false;
  }
}

function runGpuSmoke(
  plan: DualStationVllmPlan,
  managedSpec: ManagedContainerSpec,
  expectedGpuUuid: string,
  deps: DualStationVllmLifecycleDeps,
): PreflightDualStationVllmResult {
  let nonce: string;
  try {
    nonce = deps.createProbeNonce();
  } catch {
    return { ok: false, reason: `${managedSpec.role} GPU smoke nonce generation failed` };
  }
  let built: ReturnType<typeof buildDualStationGpuSmokeRunArgs>;
  try {
    built = buildDualStationGpuSmokeRunArgs(plan, managedSpec.role, nonce);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const spec: GpuSmokeSpec = {
    role: managedSpec.role,
    containerName: built.containerName,
    nonce,
    image: managedSpec.image,
    expectedGpuUuid,
    env: managedSpec.env,
  };
  const before = inspectGpuSmokeContainer(spec, deps);
  if (before.kind !== "absent") {
    return {
      ok: false,
      reason: `${spec.role} GPU smoke name ownership is ${before.kind}; refusing mutation`,
    };
  }

  let failureReason: string | null = null;
  let runResult: DualStationDockerResult | null = null;
  try {
    runResult = deps.dockerRunDetached(built.args, {
      env: spec.env,
      ignoreError: true,
      suppressOutput: true,
      timeout: DOCKER_GPU_SMOKE_TIMEOUT_MS,
    });
  } catch {
    failureReason = `${spec.role} GPU smoke container failed to launch`;
  }

  const capturedId = runResult ? resultContainerId(runResult) : null;
  let cleanupId = capturedId;
  const observed = inspectGpuSmokeContainer(spec, deps);
  if (!cleanupId && observed.kind === "owned") cleanupId = observed.containerId;

  if (!failureReason && (!runResult || !mutationSucceeded(runResult))) {
    failureReason = `${spec.role} GPU smoke container failed to launch`;
  }
  if (!failureReason && !capturedId) {
    failureReason = `${spec.role} GPU smoke returned an invalid container ID`;
  }
  if (!failureReason && observed.kind !== "owned") {
    failureReason = `${spec.role} GPU smoke ownership is ${observed.kind}`;
  }
  if (
    !failureReason &&
    observed.kind === "owned" &&
    capturedId &&
    observed.containerId !== capturedId
  ) {
    failureReason = `${spec.role} GPU smoke container ID did not match exact-name inspection`;
  }

  if (!failureReason && capturedId) {
    try {
      const exitCode = deps.dockerCapture(["wait", capturedId], {
        env: spec.env,
        timeout: DOCKER_GPU_SMOKE_TIMEOUT_MS,
      });
      if (exitCode.trim() !== "0") {
        failureReason = `${spec.role} GPU smoke exited unsuccessfully`;
      }
    } catch {
      failureReason = `${spec.role} GPU smoke did not finish within the bounded wait`;
    }
  }

  if (!failureReason && capturedId) {
    try {
      const visibleGpuUuids = deps
        .dockerCapture(["logs", capturedId], {
          env: spec.env,
          timeout: DOCKER_INSPECT_TIMEOUT_MS,
        })
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (visibleGpuUuids.length !== 1 || visibleGpuUuids[0] !== spec.expectedGpuUuid) {
        failureReason = `${spec.role} GPU smoke did not expose exactly the discovered GPU`;
      }
    } catch {
      failureReason = `${spec.role} GPU smoke output could not be validated`;
    }
  }

  if (cleanupId && !removeGpuSmokeExact(spec, cleanupId, deps)) {
    const cleanupReason = `failed to remove exact ${spec.role} GPU smoke container ${cleanupId}`;
    failureReason = failureReason ? `${failureReason}; ${cleanupReason}` : cleanupReason;
  }
  if (!cleanupId && observed.kind !== "absent") {
    const cleanupReason = `${spec.role} GPU smoke could not identify an exact owned ID for cleanup`;
    failureReason = failureReason ? `${failureReason}; ${cleanupReason}` : cleanupReason;
  }
  return failureReason ? { ok: false, reason: failureReason } : { ok: true };
}

function removeExact(
  spec: ManagedContainerSpec,
  containerId: string,
  deps: DualStationVllmLifecycleDeps,
): boolean {
  try {
    return mutationSucceeded(
      deps.dockerForceRm(containerId, {
        env: spec.env,
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_MUTATION_TIMEOUT_MS,
      }),
    );
  } catch {
    return false;
  }
}

function runExactContainerMutation(
  spec: ManagedContainerSpec,
  args: readonly string[],
  deps: DualStationVllmLifecycleDeps,
): void {
  deps.dockerCapture(["container", ...args], {
    env: spec.env,
    timeout: DOCKER_MUTATION_TIMEOUT_MS,
  });
}

function exactLegacyGeneration(
  spec: ManagedContainerSpec,
  containerId: string,
  deps: DualStationVllmLifecycleDeps,
): Extract<ManagedContainerInspection, { kind: "legacy-managed" }> | null {
  const inspection = inspectManagedContainer(spec, deps, { allowStoppedLegacy: true });
  return inspection.kind === "legacy-managed" && inspection.containerId === containerId
    ? inspection
    : null;
}

function restoreLegacyHead(
  cutover: LegacyHeadCutover,
  deps: DualStationVllmLifecycleDeps,
): string | null {
  let original = exactLegacyGeneration(cutover.originalSpec, cutover.containerId, deps);
  let backup = exactLegacyGeneration(cutover.backupSpec, cutover.containerId, deps);

  if (original && backup) {
    return "legacy head restoration found the exact container ID under two names";
  }
  if (!original) {
    if (!backup) return "legacy head restoration could not find the exact owned container ID";
    if (inspectManagedContainer(cutover.originalSpec, deps).kind !== "absent") {
      return "legacy head restoration found the original name occupied";
    }
    try {
      runExactContainerMutation(
        cutover.backupSpec,
        ["rename", cutover.containerId, cutover.originalSpec.name],
        deps,
      );
    } catch {
      // Docker may commit a rename before its client reports failure. Reconcile
      // the exact generation below instead of trusting the command response.
    }
    original = exactLegacyGeneration(cutover.originalSpec, cutover.containerId, deps);
    backup = exactLegacyGeneration(cutover.backupSpec, cutover.containerId, deps);
    if (!original || backup) {
      return "legacy head restoration could not restore the exact original container name";
    }
  }

  if (!original.running) {
    try {
      runExactContainerMutation(cutover.originalSpec, ["start", cutover.containerId], deps);
    } catch {
      // As with rename, validate the exact postcondition rather than the Docker
      // client's response so a committed start is not reported as lost.
    }
    original = exactLegacyGeneration(cutover.originalSpec, cutover.containerId, deps);
  }
  return original?.running
    ? null
    : "legacy head restoration could not restart the exact owned container ID";
}

function prepareLegacyHeadCutover(
  spec: ManagedContainerSpec,
  containerId: string,
  transactionId: string,
  deps: DualStationVllmLifecycleDeps,
):
  | { ok: true; cutover: LegacyHeadCutover }
  | { ok: false; reason: string; rollbackErrors: string[] } {
  const cutover: LegacyHeadCutover = {
    originalSpec: spec,
    backupSpec: { ...spec, name: `${spec.name}-legacy-${transactionId}` },
    containerId,
  };
  const fail = (reason: string) => {
    const restoreError = restoreLegacyHead(cutover, deps);
    return {
      ok: false as const,
      reason,
      rollbackErrors: restoreError ? [restoreError] : [],
    };
  };

  const original = exactLegacyGeneration(spec, containerId, deps);
  if (!original?.running) {
    return {
      ok: false,
      reason: "legacy head changed before transactional cutover",
      rollbackErrors: [],
    };
  }
  if (inspectManagedContainer(cutover.backupSpec, deps).kind !== "absent") {
    return {
      ok: false,
      reason: "legacy head backup name is not absent",
      rollbackErrors: [],
    };
  }

  try {
    runExactContainerMutation(spec, ["rename", containerId, cutover.backupSpec.name], deps);
  } catch {
    // Reconcile below: rename can succeed even when the client times out.
  }
  const renamed = exactLegacyGeneration(cutover.backupSpec, containerId, deps);
  if (!renamed?.running || inspectManagedContainer(cutover.originalSpec, deps).kind !== "absent") {
    return fail("failed to preserve the exact legacy head under its transaction backup name");
  }

  try {
    runExactContainerMutation(cutover.backupSpec, ["stop", "--time", "30", containerId], deps);
  } catch {
    // Reconcile and restore below if the exact generation is not stopped.
  }
  const stopped = exactLegacyGeneration(cutover.backupSpec, containerId, deps);
  if (!stopped || stopped.running) {
    return fail("failed to stop the preserved exact legacy head for cutover");
  }
  return { ok: true, cutover };
}

function rollbackNewPairAndRestoreLegacy(
  entries: readonly { spec: ManagedContainerSpec; containerId: string }[],
  transactionId: string,
  cutover: LegacyHeadCutover,
  deps: DualStationVllmLifecycleDeps,
): string[] {
  const errors = rollbackExact(entries, transactionId, deps);
  const restoreError = restoreLegacyHead(cutover, deps);
  if (restoreError) errors.push(restoreError);
  return errors;
}

function finalizeLegacyHeadCutover(
  cutover: LegacyHeadCutover,
  deps: DualStationVllmLifecycleDeps,
): string | null {
  const initial = inspectManagedContainer(cutover.backupSpec, deps, {
    allowStoppedLegacy: true,
  });
  if (initial.kind === "absent") return null;
  const backup = exactLegacyGeneration(cutover.backupSpec, cutover.containerId, deps);
  if (!backup || backup.running) {
    return "could not verify the stopped exact legacy backup for post-commit cleanup";
  }
  const removed = removeExact(cutover.backupSpec, cutover.containerId, deps);
  const after = inspectManagedContainer(cutover.backupSpec, deps);
  // A Docker client error can race a committed removal. Accept either the
  // successful exact-ID mutation or an exact-name absence on reconciliation.
  return removed || after.kind === "absent"
    ? null
    : "could not remove the stopped exact legacy backup after the new pair committed";
}

function legacyCutoverFromMigration(
  specs: ReturnType<typeof specsForPlan>,
  migration: DualStationLegacyMigration,
): LegacyHeadCutover | null {
  if (
    !TRANSACTION_ID_PATTERN.test(migration.transactionId) ||
    !DOCKER_CONTAINER_ID_PATTERN.test(migration.legacyContainerId) ||
    !DOCKER_CONTAINER_ID_PATTERN.test(migration.headContainerId) ||
    !DOCKER_CONTAINER_ID_PATTERN.test(migration.workerContainerId) ||
    new Set([migration.legacyContainerId, migration.headContainerId, migration.workerContainerId])
      .size !== 3 ||
    migration.backupContainerName !== `${specs.head.name}-legacy-${migration.transactionId}`
  ) {
    return null;
  }
  return {
    originalSpec: specs.head,
    backupSpec: { ...specs.head, name: migration.backupContainerName },
    containerId: migration.legacyContainerId,
  };
}

function removeTransactionExact(
  spec: ManagedContainerSpec,
  containerId: string,
  transactionId: string,
  deps: DualStationVllmLifecycleDeps,
): boolean {
  const inspection = inspectManagedContainer(spec, deps);
  if (inspection.kind === "absent") return true;
  if (
    inspection.kind !== "managed" ||
    !inspection.reusable ||
    inspection.containerId !== containerId ||
    inspection.transactionId !== transactionId
  ) {
    return false;
  }
  return removeExact(spec, containerId, deps);
}

function rollbackExact(
  entries: readonly { spec: ManagedContainerSpec; containerId: string }[],
  transactionId: string,
  deps: DualStationVllmLifecycleDeps,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { spec, containerId } of entries) {
    const key = `${spec.role}:${containerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!removeTransactionExact(spec, containerId, transactionId, deps)) {
      errors.push(`failed to remove ${spec.role} container ${containerId}`);
    }
  }
  return errors;
}

async function recoverManagedId(
  spec: ManagedContainerSpec,
  transactionId: string,
  deps: DualStationVllmLifecycleDeps,
): Promise<ManagedContainerInspection | null> {
  for (let attempt = 0; attempt < DOCKER_LATE_CREATE_RECONCILE_ATTEMPTS; attempt += 1) {
    const inspection = inspectManagedContainer(spec, deps);
    if (
      inspection.kind === "managed" &&
      inspection.reusable &&
      inspection.transactionId === transactionId
    ) {
      return inspection;
    }
    if (inspection.kind !== "absent" && inspection.kind !== "unknown") return null;
    if (attempt < DOCKER_LATE_CREATE_RECONCILE_ATTEMPTS - 1) {
      await deps.waitBeforeReconcile(DOCKER_LATE_CREATE_RECONCILE_INTERVAL_MS);
    }
  }
  return null;
}

async function startOne(
  plan: DualStationVllmPlan,
  spec: ManagedContainerSpec,
  config: DualStationVllmStartConfig,
  transactionId: string,
  deps: DualStationVllmLifecycleDeps,
): Promise<{ ok: true; containerId: string } | { ok: false; containerId: string | null }> {
  let result: DualStationDockerResult | null = null;
  try {
    const env = spec.role === "head" ? { ...spec.env, VLLM_API_KEY: config.apiKey } : spec.env;
    result = deps.dockerRunDetached(
      buildDualStationVllmRunArgs(plan, spec.role, transactionId, spec.apiKeyFingerprint ?? ""),
      {
        env,
        ignoreError: true,
        suppressOutput: true,
        timeout: DOCKER_MUTATION_TIMEOUT_MS,
      },
    );
  } catch {
    // A timed-out Docker client may still have committed the create. Reconcile
    // only this unguessable transaction before deciding what may be rolled back.
  }
  const capturedId = result ? resultContainerId(result) : null;
  const observed = await recoverManagedId(spec, transactionId, deps);
  if (
    result &&
    mutationSucceeded(result) &&
    capturedId &&
    observed?.kind === "managed" &&
    observed.containerId === capturedId &&
    observed.running
  ) {
    return { ok: true, containerId: capturedId };
  }
  return {
    ok: false,
    containerId: observed?.kind === "managed" ? observed.containerId : null,
  };
}

function unsafeInspectionReason(
  role: DualStationVllmRole,
  inspection: ManagedContainerInspection,
): string | null {
  if (
    inspection.kind === "managed" ||
    inspection.kind === "legacy-managed" ||
    inspection.kind === "absent"
  ) {
    return null;
  }
  return `${role} container ownership is ${inspection.kind}; refusing mutation`;
}

function ownershipTopologyReason(
  head: ManagedContainerInspection,
  worker: ManagedContainerInspection,
): string | null {
  const headReason = unsafeInspectionReason("head", head);
  if (headReason) return headReason;
  const workerReason = unsafeInspectionReason("worker", worker);
  if (workerReason) return workerReason;
  if (head.kind === "legacy-managed" && worker.kind !== "absent") {
    return "legacy single-Station head can only migrate when the peer worker name is absent";
  }
  return null;
}

function ownershipPreflightForSpecs(
  specs: ReturnType<typeof specsForPlan>,
  deps: DualStationVllmLifecycleDeps,
): PreflightDualStationVllmResult {
  const head = inspectManagedContainer(specs.head, deps);
  const worker = inspectManagedContainer(specs.worker, deps);
  const reason = ownershipTopologyReason(head, worker);
  return reason ? { ok: false, reason } : { ok: true };
}

function gpuRuntimePreflightForSpecs(
  plan: DualStationVllmPlan,
  specs: ReturnType<typeof specsForPlan>,
  deps: DualStationVllmLifecycleDeps,
): PreflightDualStationVllmResult {
  const ownershipBefore = ownershipPreflightForSpecs(specs, deps);
  if (!ownershipBefore.ok) return ownershipBefore;

  // Validate both exact digest references before either daemon is mutated.
  for (const spec of [specs.worker, specs.head]) {
    if (!pinnedImageIsPresent(spec, deps)) {
      return {
        ok: false,
        reason: `${spec.role} pinned vLLM image is not present or could not be inspected`,
      };
    }
  }

  for (const [spec, gpuUuid] of [
    [specs.worker, plan.peer.gpu.uuid],
    [specs.head, plan.local.gpu.uuid],
  ] as const) {
    const smoke = runGpuSmoke(plan, spec, gpuUuid, deps);
    if (!smoke.ok) return smoke;
  }

  // Exact names may have changed while the bounded probes ran.
  return ownershipPreflightForSpecs(specs, deps);
}

/** Read-only ownership preflight used before downloads and repeated by start. */
export function preflightDualStationManagedVllm(
  plan: DualStationVllmPlan,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): PreflightDualStationVllmResult {
  const deps = depsWith(overrides);
  let specs: ReturnType<typeof specsForPlan>;
  try {
    specs = specsForPlan(plan, deps);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  return ownershipPreflightForSpecs(specs, deps);
}

/**
 * After both pinned images are installed, prove GPU-container execution on
 * each daemon without pulling an image, starting vLLM, or receiving an API key.
 */
export async function preflightDualStationGpuRuntime(
  plan: DualStationVllmPlan,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): Promise<PreflightDualStationVllmResult> {
  const deps = depsWith(overrides);
  try {
    const specs = specsForPlan(plan, deps);
    return await deps.withLifecycleLock(() => gpuRuntimePreflightForSpecs(plan, specs, deps));
  } catch (error) {
    return { ok: false, reason: `dual-Station lifecycle lock failed: ${(error as Error).message}` };
  }
}

/**
 * Hold the host-global lease across start, readiness/auth validation, and any
 * rollback. The callback's successful return is the lifecycle commit point.
 */
export function withDualStationManagedVllmLifecycle<T>(
  operation: () => Promise<T> | T,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): Promise<T> {
  return depsWith(overrides).withLifecycleLock(operation);
}

/** Start rank 1 first, then rank 0, rolling back only exact newly created IDs. */
export async function startDualStationManagedVllm(
  plan: DualStationVllmPlan,
  config: DualStationVllmStartConfig,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): Promise<StartDualStationVllmResult> {
  const deps = depsWith(overrides);
  let specs: ReturnType<typeof specsForPlan>;
  try {
    assertSafeStartConfig(config);
    specs = specsForPlan(plan, deps, config);
  } catch (error) {
    return { ok: false, reason: (error as Error).message, rollbackErrors: [] };
  }

  try {
    return await deps.withLifecycleLock(async () => {
      // Deliberately repeat the post-pull smoke here: model download can be long,
      // and this closes that TOCTOU window immediately before owned replacement.
      const gpuRuntimePreflight = gpuRuntimePreflightForSpecs(plan, specs, deps);
      if (!gpuRuntimePreflight.ok) {
        return { ...gpuRuntimePreflight, rollbackErrors: [] };
      }

      const existingHead = inspectManagedContainer(specs.head, deps);
      const existingWorker = inspectManagedContainer(specs.worker, deps);
      const topologyReason = ownershipTopologyReason(existingHead, existingWorker);
      if (topologyReason) return { ok: false, reason: topologyReason, rollbackErrors: [] };

      if (
        existingHead.kind === "managed" &&
        existingHead.running &&
        existingHead.reusable &&
        existingWorker.kind === "managed" &&
        existingWorker.running &&
        existingWorker.reusable &&
        existingHead.transactionId === existingWorker.transactionId
      ) {
        return {
          ok: true,
          baseUrl: specs.head.endpoint,
          headContainerId: existingHead.containerId,
          workerContainerId: existingWorker.containerId,
          reusedExisting: true,
        };
      }

      let transactionId: string;
      try {
        transactionId = deps.createTransactionId();
      } catch {
        return {
          ok: false,
          reason: "dual-Station lifecycle transaction generation failed",
          rollbackErrors: [],
        };
      }
      if (!TRANSACTION_ID_PATTERN.test(transactionId)) {
        return {
          ok: false,
          reason: "dual-Station lifecycle transaction ID is invalid",
          rollbackErrors: [],
        };
      }

      for (const [spec, inspection] of [
        [specs.head, existingHead],
        [specs.worker, existingWorker],
      ] as const) {
        // A legacy head remains live until the newly created peer worker is
        // proven running. Its cutover is handled transactionally below.
        if (inspection.kind === "managed" && !removeExact(spec, inspection.containerId, deps)) {
          return {
            ok: false,
            reason: `failed to remove existing owned ${spec.role} container`,
            rollbackErrors: [],
          };
        }
      }

      const worker = await startOne(plan, specs.worker, config, transactionId, deps);
      if (!worker.ok) {
        const rollbackErrors = worker.containerId
          ? rollbackExact(
              [{ spec: specs.worker, containerId: worker.containerId }],
              transactionId,
              deps,
            )
          : [];
        return { ok: false, reason: "worker container failed to start", rollbackErrors };
      }

      let legacyCutover: LegacyHeadCutover | null = null;
      if (existingHead.kind === "legacy-managed") {
        const prepared = prepareLegacyHeadCutover(
          specs.head,
          existingHead.containerId,
          transactionId,
          deps,
        );
        if (!prepared.ok) {
          return {
            ok: false,
            reason: prepared.reason,
            rollbackErrors: [
              ...rollbackExact(
                [{ spec: specs.worker, containerId: worker.containerId }],
                transactionId,
                deps,
              ),
              ...prepared.rollbackErrors,
            ],
          };
        }
        legacyCutover = prepared.cutover;
      }

      const head = await startOne(plan, specs.head, config, transactionId, deps);
      if (!head.ok) {
        const rollback = [
          ...(head.containerId ? [{ spec: specs.head, containerId: head.containerId }] : []),
          { spec: specs.worker, containerId: worker.containerId },
        ];
        return {
          ok: false,
          reason: "head container failed to start",
          rollbackErrors: legacyCutover
            ? rollbackNewPairAndRestoreLegacy(rollback, transactionId, legacyCutover, deps)
            : rollbackExact(rollback, transactionId, deps),
        };
      }

      const finalHead = inspectManagedContainer(specs.head, deps);
      const finalWorker = inspectManagedContainer(specs.worker, deps);
      if (
        finalHead.kind !== "managed" ||
        !finalHead.running ||
        !finalHead.reusable ||
        finalHead.transactionId !== transactionId ||
        finalHead.containerId !== head.containerId ||
        finalWorker.kind !== "managed" ||
        !finalWorker.running ||
        !finalWorker.reusable ||
        finalWorker.transactionId !== transactionId ||
        finalWorker.containerId !== worker.containerId
      ) {
        const rollback = [
          { spec: specs.head, containerId: head.containerId },
          { spec: specs.worker, containerId: worker.containerId },
        ];
        return {
          ok: false,
          reason: "dual-Station containers did not remain running",
          rollbackErrors: legacyCutover
            ? rollbackNewPairAndRestoreLegacy(rollback, transactionId, legacyCutover, deps)
            : rollbackExact(rollback, transactionId, deps),
        };
      }

      return {
        ok: true,
        baseUrl: specs.head.endpoint,
        headContainerId: head.containerId,
        workerContainerId: worker.containerId,
        reusedExisting: false,
        ...(legacyCutover
          ? {
              legacyMigration: {
                backupContainerName: legacyCutover.backupSpec.name,
                legacyContainerId: legacyCutover.containerId,
                transactionId,
                headContainerId: head.containerId,
                workerContainerId: worker.containerId,
              },
            }
          : {}),
      };
    });
  } catch (error) {
    return {
      ok: false,
      reason: `dual-Station lifecycle lock failed: ${(error as Error).message}`,
      rollbackErrors: [],
    };
  }
}

/** Retire the preserved legacy generation only after external readiness/auth commit. */
export async function commitDualStationLegacyMigration(
  plan: DualStationVllmPlan,
  migration: DualStationLegacyMigration,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): Promise<CommitDualStationLegacyMigrationResult> {
  const deps = depsWith(overrides);
  try {
    const specs = specsForPlan(plan, deps);
    const cutover = legacyCutoverFromMigration(specs, migration);
    if (!cutover) return { ok: false, reason: "legacy migration handle is invalid" };
    return await deps.withLifecycleLock(() => {
      const head = inspectManagedContainer(specs.head, deps);
      const worker = inspectManagedContainer(specs.worker, deps);
      if (
        head.kind !== "managed" ||
        !head.running ||
        !head.reusable ||
        head.containerId !== migration.headContainerId ||
        head.transactionId !== migration.transactionId ||
        worker.kind !== "managed" ||
        !worker.running ||
        !worker.reusable ||
        worker.containerId !== migration.workerContainerId ||
        worker.transactionId !== migration.transactionId
      ) {
        return { ok: false, reason: "new dual-Station transaction changed before commit" };
      }
      const warning = finalizeLegacyHeadCutover(cutover, deps);
      return { ok: true, cleanupWarnings: warning ? [warning] : [] };
    });
  } catch (error) {
    return { ok: false, reason: `legacy migration commit failed: ${(error as Error).message}` };
  }
}

/** Remove only the new transaction and restore its exact preserved legacy generation. */
export async function rollbackDualStationLegacyMigration(
  plan: DualStationVllmPlan,
  migration: DualStationLegacyMigration,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): Promise<RollbackDualStationLegacyMigrationResult> {
  const deps = depsWith(overrides);
  try {
    const specs = specsForPlan(plan, deps);
    const cutover = legacyCutoverFromMigration(specs, migration);
    if (!cutover) return { ok: false, rollbackErrors: ["legacy migration handle is invalid"] };
    return await deps.withLifecycleLock(() => {
      const rollbackErrors = rollbackNewPairAndRestoreLegacy(
        [
          { spec: specs.head, containerId: migration.headContainerId },
          { spec: specs.worker, containerId: migration.workerContainerId },
        ],
        migration.transactionId,
        cutover,
        deps,
      );
      return rollbackErrors.length === 0 ? { ok: true } : { ok: false, rollbackErrors };
    });
  } catch (error) {
    return {
      ok: false,
      rollbackErrors: [`legacy migration rollback failed: ${(error as Error).message}`],
    };
  }
}

/** Remove only containers whose complete dual-Station ownership tuple matches. */
function cleanupDualStationManagedVllmUnlocked(
  plan: DualStationVllmPlan,
  deps: DualStationVllmLifecycleDeps,
): CleanupDualStationVllmResult {
  let specs: ReturnType<typeof specsForPlan>;
  try {
    specs = specsForPlan(plan, deps);
  } catch (error) {
    return { ok: false, reason: (error as Error).message };
  }
  const head = inspectManagedContainer(specs.head, deps);
  const worker = inspectManagedContainer(specs.worker, deps);
  if (head.kind === "legacy-managed" || worker.kind === "legacy-managed") {
    return { ok: false, reason: "refusing dual-Station cleanup of a legacy single-host container" };
  }
  for (const [role, inspection] of [
    ["head", head],
    ["worker", worker],
  ] as const) {
    const reason = unsafeInspectionReason(role, inspection);
    if (reason) return { ok: false, reason };
  }

  const removedContainerIds: string[] = [];
  for (const [spec, inspection] of [
    [specs.head, head],
    [specs.worker, worker],
  ] as const) {
    if (inspection.kind !== "managed") continue;
    if (!removeExact(spec, inspection.containerId, deps)) {
      return { ok: false, reason: `failed to remove owned ${spec.role} container` };
    }
    removedContainerIds.push(inspection.containerId);
  }
  return { ok: true, removedContainerIds };
}

/** Serialize cleanup with start so fixed names cannot transfer between owners. */
export async function cleanupDualStationManagedVllm(
  plan: DualStationVllmPlan,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): Promise<CleanupDualStationVllmResult> {
  const deps = depsWith(overrides);
  try {
    return await deps.withLifecycleLock(() => cleanupDualStationManagedVllmUnlocked(plan, deps));
  } catch (error) {
    return { ok: false, reason: `dual-Station lifecycle lock failed: ${(error as Error).message}` };
  }
}

/** Read-only exact-ownership/running check across both Docker daemons. */
export function areDualStationManagedVllmContainersRunning(
  plan: DualStationVllmPlan,
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): boolean {
  const deps = depsWith(overrides);
  try {
    const specs = specsForPlan(plan, deps);
    const head = inspectManagedContainer(specs.head, deps);
    const worker = inspectManagedContainer(specs.worker, deps);
    return (
      head.kind === "managed" &&
      head.running &&
      head.reusable &&
      worker.kind === "managed" &&
      worker.running &&
      worker.reusable &&
      head.transactionId === worker.transactionId
    );
  } catch {
    return false;
  }
}

function validatedManagedBaseUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.port !== String(HEAD_API_PORT) ||
    !isRfc1918Ipv4(parsed.hostname)
  ) {
    return null;
  }
  const canonical = `http://${parsed.hostname}:${String(HEAD_API_PORT)}`;
  return value === canonical ? canonical : null;
}

/** Recover the local managed head endpoint without trusting persisted user input. */
export function getDualStationManagedVllmBaseUrl(
  overrides: Partial<DualStationVllmLifecycleDeps> = {},
): string | null {
  const deps = depsWith(overrides);
  const env = withoutVllmApiKey(deps.buildLocalDockerEnv());
  const rows = inspectRows(DUAL_STATION_VLLM_HEAD_CONTAINER_NAME, env, deps);
  if (!rows || rows.length !== 1 || rows[0].length !== 13) return null;
  const [
    containerId,
    name,
    state,
    image,
    managed,
    role,
    endpoint,
    clusterId,
    gpuUuid,
    launchSchema,
    launchContract,
    apiKeyFingerprint,
    transactionId,
  ] = rows[0];
  if (
    !DOCKER_CONTAINER_ID_PATTERN.test(containerId) ||
    name !== DUAL_STATION_VLLM_HEAD_CONTAINER_NAME ||
    state !== "running" ||
    image !== DUAL_STATION_VLLM_RUNTIME.image ||
    managed !== "true" ||
    role !== "head" ||
    !CLUSTER_ID_PATTERN.test(clusterId) ||
    !SAFE_GPU_UUID_PATTERN.test(gpuUuid) ||
    launchSchema !== DUAL_STATION_VLLM_LAUNCH_SCHEMA ||
    !SHA256_HEX_PATTERN.test(launchContract) ||
    !TRANSACTION_ID_PATTERN.test(transactionId)
  ) {
    return null;
  }
  deps.onManagedHeadObserved?.();
  if (!SHA256_HEX_PATTERN.test(apiKeyFingerprint)) return null;
  let apiKey: string | null;
  try {
    apiKey = deps.loadApiKey();
  } catch {
    return null;
  }
  if (!apiKey || dualStationVllmApiKeyFingerprint(apiKey) !== apiKeyFingerprint) return null;
  const baseUrl = validatedManagedBaseUrl(endpoint);
  if (!baseUrl || !deps.localInterfaceAddresses().includes(new URL(baseUrl).hostname)) return null;
  return baseUrl;
}
