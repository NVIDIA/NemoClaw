// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM container actions invoked from onboard.ts. Detection of "should we
// offer vLLM at all" lives in onboard.ts; this module owns picking the
// right profile per platform and running the install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import {
  dockerCapture,
  dockerForceRm,
  dockerImageInspectFormat,
  dockerPullWithProgressWatchdog,
  dockerRunDetached,
  dockerSpawn,
  dockerStop,
} from "../adapters/docker";
import { createBearerAuthConfig } from "../adapters/http/auth-config";
import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { runCurlProbe } from "../adapters/http/probe";
import { CLI_NAME } from "../cli/branding";
import { warnLine } from "../cli/terminal-style";
import { markPhaseActivity } from "../core/phase-activity";
import { VLLM_PORT } from "../core/vllm-port";
import { shellQuote } from "../core/shell-quote";
import { isAffirmativeAnswer } from "../onboard/prompt-helpers";
import { redact, redactFull, runCapture } from "../runner";
import { isSafeModelId } from "../validation";
import {
  acquireHuggingFaceModel,
  hfDownloadAuthentication,
} from "./model-acquisition/hugging-face";
import { getGpuIndicesByName } from "./nim";
import {
  buildLocalDualStationDockerEnv,
  buildLocalManagedVllmDockerEnv,
  buildRemoteVllmDockerEnv,
  buildVllmDockerEnv,
  captureNvidiaSmi,
  ensureDualStationVllmApiKey,
  loadDualStationVllmApiKey,
  type MaterializedHostLocalVllmSelection,
  NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV,
  NEMOCLAW_SERVING_PRESET_ENV,
  persistHostLocalVllmRuntimeReceipt,
  recoverHostLocalManagedVllmEndpoint,
  recoverInstalledManagedClusterVllmEndpoint,
  resolveHostLocalVllmSelection,
  resolveManagedVllmBridgeHost,
  resolveNvidiaSmiCommand,
  resolveVllmInstallModel,
  runtimeAuthFingerprint,
  tryInstallManagedClusterManagedVllm,
  validateManagedVllmBridgeHost,
} from "./serving/vllm-managed-support";
import {
  assertGatedModelAccess,
  buildVllmServeCommand,
  defaultVllmModelForPlatform,
  defaultVllmRuntimeForPlatform,
  STATION_PAIR_OPTIONAL_ORCHESTRATION,
  NEMOCLAW_VLLM_GPU_DEVICE_ENV,
  normalizeVllmGpuDevice,
  parseVllmExtraServeArgs,
  resolveVllmGpuMemoryUtilization,
  VLLM_EXTRA_ARGS_ENV,
  VLLM_MODELS,
  vllmModelForOrchestration,
  vllmModelUsesOrchestration,
  vllmPlatformSpecificity,
  type VllmModelDef,
  type VllmPlatform,
  type VllmRuntimeOverride,
  type VllmRuntimeVariant,
} from "./vllm-models";
import {
  type DualStationVllmPlan,
  NEMOCLAW_DGX_STATION_PEER_ENV,
  probeDualStationVllmCapability,
} from "./vllm-station-cluster";
import type { ManagedInferenceReadinessSource } from "./serving/types";
import {
  areDualStationManagedVllmContainersRunning,
  cleanupDualStationManagedVllm,
  commitDualStationLegacyMigration,
  DUAL_STATION_VLLM_CLUSTER_LABEL,
  DUAL_STATION_VLLM_ENDPOINT_LABEL,
  DUAL_STATION_VLLM_ROLE_LABEL,
  getDualStationManagedVllmBaseUrl,
  preflightDualStationGpuRuntime,
  preflightDualStationManagedVllm,
  rollbackDualStationLegacyMigration,
  startDualStationManagedVllm,
  withDualStationManagedVllmLifecycle,
} from "./vllm-station-cluster-lifecycle";
import { stageDualStationModelSnapshot } from "./vllm-station-model-staging";
import {
  persistDualStationVllmRuntimeReceipt,
  recoverInstalledDualStationVllmRuntime,
} from "./vllm-station-runtime-receipt";
import {
  findUnwritableModelCachePath,
  formatStorageBytes,
  formatStorageDecimalBytes,
  imageStorageRequirementBytes,
  managedVllmStorageEstimateBytes,
  measureDirectorySizeBytes,
  probeDockerStorage,
  probeHostStorage,
  type StorageCapacity,
  type StorageProbeResult,
} from "./vllm-storage";

export { selectVllmModelFromEnv } from "./vllm-models";

// Per-platform install recipe. Add new platforms by appending an entry to
// the profile table at the bottom of this file. The menu key in onboard.ts
// stays "install-vllm" regardless of platform.
export interface VllmProfile {
  name: string; // human label, e.g. "DGX Spark"
  // Platform key matched against `VllmModelDef.platforms` when the picker
  // filters the registry. Decoupled from `name` so future user-facing label
  // tweaks don't change which models are offered.
  platform: VllmPlatform;
  /** Qualified host architecture for this platform profile. */
  architecture?: NodeJS.Architecture;
  image: string; // platform-specific image pinned by digest
  // Compressed size of that exact platform manifest. The storage preflight
  // adds unpacking and pull-staging headroom.
  imageDownloadSizeBytes: number;
  // Pre-calculated unpacked layer size for this exact digest when available.
  imageUnpackedSizeBytes?: number;
  // Default model when NEMOCLAW_VLLM_MODEL is unset. Per-platform default
  // because Spark/Station can host larger recipes, but generic discrete-GPU
  // Linux falls back to the small Nemotron-Nano-4B that fits on consumer
  // cards.
  defaultModel: VllmModelDef;
  containerName: string;
  // docker run flags excluding the image and the entrypoint command. The
  // caller appends -p / --name / etc. that are not platform-specific.
  dockerRunFlags: string[];
  // Optional dynamic flag builder. When present, its return value replaces
  // dockerRunFlags at install time. Used by Station to pick the GB300 GPU
  // out of a mixed-GPU host instead of using `--gpus all`.
  buildDockerRunFlags?: () => string[];
  // Maximum wall-clock safety budget for image pulls. The Docker adapter uses
  // a shorter progress watchdog for stalls, so slow-but-moving pulls can keep
  // going until this last-ditch cap.
  pullTimeoutSec: number;
  // Wall-clock budget for the load phase (after pull, before ready).
  loadTimeoutSec: number;
  // Optional pinned model snapshot size. Model-specific runtime overrides use
  // this to guard the host Hugging Face cache before a cold download.
  modelDownloadSizeBytes?: number;
  /** GPU floor selected by a compatibility-qualified model runtime. */
  minComputeCapability?: number;
  /** Minimum GPU or unified-memory capacity selected by the runtime recipe. */
  minGpuMemoryBytes?: number;
  /** Fraction of one selected GPU that vLLM reserves during startup. */
  gpuMemoryUtilization?: number;
  servingCatalog?: {
    catalogDigest: string;
    presetId: string;
    presetDigest: string;
    recipeId: string;
    recipeDigest: string;
  };
}

const VLLM_WRITABLE_ALLOWANCE_BYTES = 816_000_000;

// Compatibility export for image-boundary checks. Runtime image identity and
// size are owned by catalog recipes, including optional orchestration images.
export const VLLM_IMAGES = {
  catalog: Object.fromEntries(
    VLLM_MODELS.flatMap((model) =>
      (model.runtimeVariants ?? []).flatMap((runtime, index) => [
        [
          `${model.envValue}-${String(index)}`,
          { ref: runtime.image, downloadSizeBytes: runtime.imageDownloadSizeBytes },
        ],
        ...(runtime.stationPair
          ? [
              [
                `${model.envValue}-${String(index)}-station-pair`,
                {
                  ref: runtime.stationPair.image,
                  downloadSizeBytes: runtime.stationPair.imageDownloadSizeBytes,
                },
              ],
            ]
          : []),
      ]),
    ),
  ),
} as const;

const HF_TOKEN_SETTINGS_URL = "https://huggingface.co/settings/tokens";
const VLLM_LAUNCH_HEARTBEAT_MS = 30_000;
const VLLM_MAX_STARTUP_RESTARTS = 3;
const HF_CACHE_CONTAINER_DIR = "/root/.cache/huggingface";
const HF_CACHE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NEMOCLAW_VLLM_CONTAINER_NAME = "nemoclaw-vllm";
export const NEMOCLAW_VLLM_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm";
export const NEMOCLAW_VLLM_HOST_LOCAL_AUTH_LABEL = "com.nvidia.nemoclaw.managed-vllm-auth";
const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;

function hostHfCacheDir(): string {
  return path.join(os.homedir(), ".cache", "huggingface");
}

function hfCacheMount(): string {
  return `${hostHfCacheDir()}:${HF_CACHE_CONTAINER_DIR}`;
}

function hfModelCacheKey(model: VllmModelDef): string | null {
  const modelParts = model.id.split("/");
  if (modelParts.some((part) => !HF_CACHE_COMPONENT_PATTERN.test(part))) return null;
  return `models--${modelParts.join("--")}`;
}

export function hfModelSnapshotDir(model: VllmModelDef): string | null {
  const revision = model.revision;
  const modelCacheKey = hfModelCacheKey(model);
  if (!revision || !modelCacheKey || !HF_CACHE_COMPONENT_PATTERN.test(revision)) {
    return null;
  }
  return path.join(hostHfCacheDir(), "hub", modelCacheKey, "snapshots", revision);
}

function hfModelCacheDir(model: VllmModelDef): string | null {
  const modelParts = model.id.split("/");
  if (modelParts.some((part) => !HF_CACHE_COMPONENT_PATTERN.test(part))) {
    return null;
  }
  return path.join(hostHfCacheDir(), "hub", `models--${modelParts.join("--")}`);
}

function hostUserIdentity(): string | null {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return null;
  return `${String(process.getuid())}:${String(process.getgid())}`;
}

function vllmDockerRunFlags(gpuFlag = "all"): string[] {
  return [
    "--gpus",
    gpuFlag,
    "--ipc=host",
    "-v",
    hfCacheMount(),
    "-e",
    `HF_HOME=${HF_CACHE_CONTAINER_DIR}`,
  ];
}

function replaceVllmGpuRequest(flags: readonly string[], device: string): string[] {
  const gpuIndex = flags.indexOf("--gpus");
  if (gpuIndex < 0 || gpuIndex === flags.length - 1 || flags.indexOf("--gpus", gpuIndex + 1) >= 0) {
    throw new Error("managed vLLM profile must contain exactly one Docker --gpus request");
  }
  const selected = [...flags];
  selected[gpuIndex + 1] = `device=${device}`;
  return selected;
}

export function selectVllmGpuDevice(profile: VllmProfile, device: string): VllmProfile {
  const normalized = normalizeVllmGpuDevice(device);
  return {
    ...profile,
    dockerRunFlags: replaceVllmGpuRequest(profile.dockerRunFlags, normalized),
    buildDockerRunFlags: profile.buildDockerRunFlags
      ? () => replaceVllmGpuRequest(profile.buildDockerRunFlags!(), normalized)
      : undefined,
  };
}

function printHfDownloadAuthentication(nonInteractive: boolean): void {
  const authentication = hfDownloadAuthentication();
  if (authentication.authenticated) {
    console.log(`    Hugging Face download: authenticated with ${authentication.source}.`);
    console.log(
      "    The token value is not displayed and is passed only to the temporary downloader.",
    );
    return;
  }

  if (nonInteractive) {
    console.log("    Hugging Face download: continuing anonymously for this public model.");
    console.log("    For large downloads, a read token reduces anonymous HTTP 429 rate limiting.");
    console.log(`    Create one at ${HF_TOKEN_SETTINGS_URL}.`);
    console.log("    Before restarting onboarding, run: export HF_TOKEN=<read-token>");
    return;
  }

  console.log("    Hugging Face authentication is optional for this public model but recommended");
  console.log(
    "    for this large download. Anonymous downloads may be rate-limited with HTTP 429.",
  );
  console.log(`    Create a read token at ${HF_TOKEN_SETTINGS_URL}.`);
  console.log("    Before restarting onboarding, run: export HF_TOKEN=<read-token>");
  console.log("    The token is passed only to the temporary model downloader.");
}

function printHfRateLimitRecovery(): void {
  process.stderr.write("  Hugging Face rate limiting was detected.\n");
  process.stderr.write(`  Create a read token at ${HF_TOKEN_SETTINGS_URL}.\n`);
  process.stderr.write("  In your shell, run: export HF_TOKEN=<read-token>\n");
  process.stderr.write(`  Then run: ${CLI_NAME} onboard --resume\n`);
  process.stderr.write(
    "  Existing files in ~/.cache/huggingface are reused when the download resumes.\n",
  );
}

const sparkDefaultRuntime = defaultVllmRuntimeForPlatform("spark", "arm64");
const SPARK_PROFILE: VllmProfile = {
  name: "DGX Spark",
  platform: "spark",
  architecture: "arm64",
  image: sparkDefaultRuntime.image,
  imageDownloadSizeBytes: sparkDefaultRuntime.imageDownloadSizeBytes,
  imageUnpackedSizeBytes: sparkDefaultRuntime.imageUnpackedSizeBytes,
  defaultModel: defaultVllmModelForPlatform("spark", "arm64"),
  containerName: NEMOCLAW_VLLM_CONTAINER_NAME,
  dockerRunFlags: vllmDockerRunFlags(),
  pullTimeoutSec: 12 * 60 * 60,
  loadTimeoutSec: 1800,
};

const n1xDefaultRuntime = defaultVllmRuntimeForPlatform("n1x", "arm64");
const N1X_PROFILE: VllmProfile = {
  name: "N1x",
  platform: "n1x",
  architecture: "arm64",
  image: n1xDefaultRuntime.image,
  imageDownloadSizeBytes: n1xDefaultRuntime.imageDownloadSizeBytes,
  imageUnpackedSizeBytes: n1xDefaultRuntime.imageUnpackedSizeBytes,
  defaultModel: defaultVllmModelForPlatform("n1x", "arm64"),
  containerName: NEMOCLAW_VLLM_CONTAINER_NAME,
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
};

// DGX Station.
const stationDefaultRuntime = defaultVllmRuntimeForPlatform("station", "arm64");
const STATION_PROFILE: VllmProfile = {
  name: "DGX Station",
  platform: "station",
  architecture: "arm64",
  image: stationDefaultRuntime.image,
  imageDownloadSizeBytes: stationDefaultRuntime.imageDownloadSizeBytes,
  imageUnpackedSizeBytes: stationDefaultRuntime.imageUnpackedSizeBytes,
  defaultModel: defaultVllmModelForPlatform("station", "arm64"),
  containerName: NEMOCLAW_VLLM_CONTAINER_NAME,
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  buildDockerRunFlags: () => {
    const indices = getGpuIndicesByName(/GB300/i);
    if (indices.length === 0) {
      throw new Error(
        "DGX Station managed vLLM requires an NVIDIA GB300 GPU, but none was detected",
      );
    }
    // Docker parses --gpus as CSV, so multi-device values must retain
    // double quotes inside the argv token to keep the comma in one field.
    const gpuFlag = indices.length === 1 ? `device=${indices[0]}` : `"device=${indices.join(",")}"`;
    return vllmDockerRunFlags(gpuFlag);
  },
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
};

// Generic discrete-GPU Linux. Uses a small nemotron model that fits on
// most GPUs.
const genericLinuxRuntime =
  process.arch === "arm64" || process.arch === "x64"
    ? defaultVllmRuntimeForPlatform("linux", process.arch)
    : null;

const GENERIC_LINUX_PROFILE: VllmProfile | null = genericLinuxRuntime
  ? {
      name: "Linux + NVIDIA GPU",
      platform: "linux",
      architecture: process.arch,
      image: genericLinuxRuntime.image,
      imageDownloadSizeBytes: genericLinuxRuntime.imageDownloadSizeBytes,
      imageUnpackedSizeBytes: genericLinuxRuntime.imageUnpackedSizeBytes,
      defaultModel: defaultVllmModelForPlatform("linux", process.arch),
      containerName: NEMOCLAW_VLLM_CONTAINER_NAME,
      dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
      pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
      loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
    }
  : null;

export function detectVllmProfile(
  gpu:
    | {
        spark?: boolean;
        type?: string;
        platform?: "spark" | "station" | "n1x" | "linux";
      }
    | null
    | undefined,
): VllmProfile | null {
  if (gpu?.platform === "spark") return SPARK_PROFILE;
  if (gpu?.platform === "station") return STATION_PROFILE;
  if (gpu?.platform === "n1x") return N1X_PROFILE;
  if (gpu?.spark) return SPARK_PROFILE;
  if (gpu?.type === "nvidia") return GENERIC_LINUX_PROFILE;
  return null;
}

function emit(line: string): void {
  process.stdout.write(`  ==> ${line}\n`);
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${String(seconds)}s`;
  return `${String(minutes)}m ${String(seconds)}s`;
}

function dockerPrereqsOk(): { ok: boolean; reason?: string } {
  if (!runCapture(["sh", "-c", "command -v docker"], { ignoreError: true }).trim()) {
    return { ok: false, reason: "docker not found on PATH" };
  }
  if (!resolveNvidiaSmiCommand({ runCaptureImpl: runCapture })) {
    return { ok: false, reason: "nvidia-smi not found — vLLM requires NVIDIA drivers" };
  }
  if (!runCapture(["sh", "-c", "command -v curl"], { ignoreError: true }).trim()) {
    return { ok: false, reason: "curl not found on PATH — vLLM readiness checks require curl" };
  }
  return { ok: true };
}

export function readGpuComputeCapabilities(device?: string): number[] {
  const out = captureNvidiaSmi(
    [
      ...(device ? [`--id=${device}`] : []),
      "--query-gpu=compute_cap",
      "--format=csv,noheader,nounits",
    ],
    { runCaptureImpl: runCapture },
  );
  if (!out) return [];
  const capabilities: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\.(\d+)$/.exec(trimmed);
    if (!match) continue;
    capabilities.push(Number(match[1]) * 10 + Number(match[2]));
  }
  return capabilities;
}

function readProfileGpuComputeCapabilities(profile: VllmProfile): number[] {
  const request = profileGpuRequest(profile);
  if (!request?.startsWith("device=")) return readGpuComputeCapabilities();
  const device = request.slice("device=".length).split(",")[0]?.trim();
  return readGpuComputeCapabilities(device || undefined);
}

export function formatComputeCapability(capability: number): string {
  return `${String(Math.floor(capability / 10))}.${String(capability % 10)}`;
}

export function computeCapabilityPreflight(
  model: VllmModelDef,
  capabilities: number[] = readGpuComputeCapabilities(),
  runtimeMinimum: number | undefined = model.minComputeCapability,
): { ok: true } | { ok: false; reason: string } {
  const required = runtimeMinimum;
  if (required === undefined) return { ok: true };
  if (capabilities.length === 0) return { ok: true };
  const lowest = Math.min(...capabilities);
  if (lowest >= required) return { ok: true };
  return {
    ok: false,
    reason:
      `${model.label} requires GPU compute capability ${formatComputeCapability(required)} or newer, ` +
      `but this host reports ${formatComputeCapability(lowest)}. ` +
      "Serve this model on a newer GPU, or select a compatible model with NEMOCLAW_VLLM_MODEL.",
  };
}

export interface GpuMemoryDevice {
  index: number;
  uuid: string;
  totalBytes: bigint | null;
  freeBytes: bigint | null;
}

type GpuMemoryPreflightResult = { ok: true; warning?: string } | { ok: false; reason: string };

const NVIDIA_GPU_INDEX_PATTERN = /^\d+$/;
const NVIDIA_GPU_MEMORY_MIB_PATTERN = /^\d+$/;
const NVIDIA_GPU_UUID_PATTERN = /^GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function readGpuMemoryDevices(): GpuMemoryDevice[] {
  const out = captureNvidiaSmi(
    ["--query-gpu=index,uuid,memory.total,memory.free", "--format=csv,noheader,nounits"],
    { runCaptureImpl: runCapture },
  );
  if (!out) return [];
  const devices: GpuMemoryDevice[] = [];
  for (const line of out.split("\n")) {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length !== 4) continue;
    const [indexRaw, uuid, totalMiBRaw, freeMiBRaw] = fields;
    if (!NVIDIA_GPU_INDEX_PATTERN.test(indexRaw) || !NVIDIA_GPU_UUID_PATTERN.test(uuid)) {
      continue;
    }
    const index = Number(indexRaw);
    if (!Number.isSafeInteger(index) || index < 0) continue;
    if (totalMiBRaw === "[N/A]" && freeMiBRaw === "[N/A]") {
      devices.push({ index, uuid, totalBytes: null, freeBytes: null });
      continue;
    }
    if (
      !NVIDIA_GPU_MEMORY_MIB_PATTERN.test(totalMiBRaw) ||
      !NVIDIA_GPU_MEMORY_MIB_PATTERN.test(freeMiBRaw)
    ) {
      continue;
    }
    const totalMiB = Number(totalMiBRaw);
    const freeMiB = Number(freeMiBRaw);
    if (
      !Number.isSafeInteger(totalMiB) ||
      totalMiB <= 0 ||
      !Number.isSafeInteger(freeMiB) ||
      freeMiB < 0 ||
      freeMiB > totalMiB
    ) {
      continue;
    }
    devices.push({
      index,
      uuid,
      totalBytes: BigInt(totalMiB) * 1024n * 1024n,
      freeBytes: BigInt(freeMiB) * 1024n * 1024n,
    });
  }
  return devices;
}

function profileGpuRequest(profile: VllmProfile): string | null {
  let flags: readonly string[];
  try {
    flags = profile.buildDockerRunFlags ? profile.buildDockerRunFlags() : profile.dockerRunFlags;
  } catch {
    return null;
  }
  const index = flags.indexOf("--gpus");
  if (index < 0 || index === flags.length - 1) return null;
  const value = flags[index + 1]!;
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

function selectedGpuMemoryDevice(
  request: string,
  devices: readonly GpuMemoryDevice[],
): GpuMemoryDevice | null {
  // Fixed host-local recipes use one tensor-parallel worker, so vLLM starts
  // on the first visible device even when Docker exposes every GPU.
  if (request === "all" || request === "device=all") {
    return devices.find((device) => device.index === 0) ?? null;
  }
  if (!request.startsWith("device=")) return null;
  const selector = request.slice("device=".length).split(",")[0]?.trim();
  if (!selector) return null;
  return (
    devices.find(
      (device) =>
        String(device.index) === selector || device.uuid.toLowerCase() === selector.toLowerCase(),
    ) ?? null
  );
}

export function gpuMemoryPreflight(
  model: VllmModelDef,
  profile: VllmProfile,
  devices: readonly GpuMemoryDevice[] = readGpuMemoryDevices(),
): GpuMemoryPreflightResult {
  const utilization = profile.gpuMemoryUtilization;
  if (utilization === undefined) return { ok: true };
  if (devices.length === 0) {
    return {
      ok: false,
      reason:
        `Could not read valid GPU memory telemetry for ${model.label} with nvidia-smi. ` +
        "Verify NVIDIA driver access and GPU health, then resume onboarding.",
    };
  }
  const request = profileGpuRequest(profile);
  if (!request) {
    return {
      ok: false,
      reason:
        `Could not determine which GPU ${profile.name} will expose to ${model.label}. ` +
        "Verify the managed vLLM GPU configuration, then resume onboarding.",
    };
  }
  const device = selectedGpuMemoryDevice(request, devices);
  if (!device) {
    return {
      ok: false,
      reason:
        `${profile.name} selects GPU '${request}', but nvidia-smi did not report that device. ` +
        "Verify the Docker GPU selection and NVIDIA driver state, then resume onboarding.",
    };
  }
  if (device.totalBytes === null || device.freeBytes === null) {
    if (
      device.totalBytes === null &&
      device.freeBytes === null &&
      (profile.platform === "n1x" || profile.platform === "spark")
    ) {
      return {
        ok: true,
        warning:
          `${profile.name} GPU ${String(device.index)} (${device.uuid}) reports [N/A] for both total and free ` +
          `memory. NemoClaw cannot pre-validate --gpu-memory-utilization=${String(utilization)} on this ` +
          "unified-memory platform and continues without inferring available memory.",
      };
    }
    return {
      ok: false,
      reason:
        `${profile.name} GPU ${String(device.index)} did not report numeric total and free memory. ` +
        "Verify NVIDIA memory telemetry and GPU health, then resume onboarding.",
    };
  }
  const requiredBytes = BigInt(Math.ceil(Number(device.totalBytes) * utilization));
  if (device.freeBytes >= requiredBytes) return { ok: true };
  const missingBytes = requiredBytes - device.freeBytes;
  return {
    ok: false,
    reason:
      `${model.label} sets --gpu-memory-utilization=${String(utilization)}, which requires about ` +
      `${formatStorageBytes(requiredBytes)} free on GPU ${String(device.index)}, but only ` +
      `${formatStorageBytes(device.freeBytes)} of ${formatStorageBytes(device.totalBytes)} is free. ` +
      `Stop other GPU workloads to free at least ${formatStorageBytes(missingBytes)}, then resume onboarding.`,
  };
}

function installGpuMemoryPreflight(
  model: VllmModelDef,
  profile: VllmProfile,
  dualStationPlan: DualStationVllmPlan | null,
): GpuMemoryPreflightResult {
  if (!dualStationPlan) return gpuMemoryPreflight(model, profile);
  const utilization = profile.gpuMemoryUtilization;
  if (utilization === undefined) return { ok: true };
  for (const node of [dualStationPlan.local, dualStationPlan.peer]) {
    const totalBytes = BigInt(node.gpu.totalMemoryMiB) * 1024n * 1024n;
    const freeBytes = BigInt(node.gpu.freeMemoryMiB) * 1024n * 1024n;
    const requiredBytes = BigInt(Math.ceil(Number(totalBytes) * utilization));
    if (freeBytes >= requiredBytes) continue;
    const missingBytes = requiredBytes - freeBytes;
    return {
      ok: false,
      reason:
        `${model.label} sets --gpu-memory-utilization=${String(utilization)}, which requires about ` +
        `${formatStorageBytes(requiredBytes)} free on GPU ${String(node.gpu.index)} ` +
        `(${node.gpu.uuid}) on ${node.hostname}, but only ${formatStorageBytes(freeBytes)} of ` +
        `${formatStorageBytes(totalBytes)} is free. Stop other GPU workloads on ${node.hostname} ` +
        `to free at least ${formatStorageBytes(missingBytes)}, then resume onboarding.`,
    };
  }
  return { ok: true };
}

function sameDualStationTopology(left: DualStationVllmPlan, right: DualStationVllmPlan): boolean {
  const withoutVolatileMemory = (plan: DualStationVllmPlan): DualStationVllmPlan => ({
    ...plan,
    local: {
      ...plan.local,
      gpu: { ...plan.local.gpu, freeMemoryMiB: 0 },
    },
    peer: {
      ...plan.peer,
      gpu: { ...plan.peer.gpu, freeMemoryMiB: 0 },
    },
  });
  return isDeepStrictEqual(withoutVolatileMemory(left), withoutVolatileMemory(right));
}

export async function pullImage(
  profile: VllmProfile,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): Promise<{ ok: boolean; reason?: string }> {
  try {
    assertVllmRegistryDigestRef(profile.image);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  emit(`Pulling vLLM image: ${profile.image}`);
  // Docker can be quiet while finalizing large layers on every supported vLLM
  // profile, so all profiles intentionally share the 15-minute stall default.
  // The profile-specific maximum still bounds the complete pull operation.
  const result = await dockerPullWithProgressWatchdog(profile.image, {
    env: dockerEnv,
    maxTimeoutMs: profile.pullTimeoutSec * 1000,
    logLine: emit,
  });
  if (result.status !== 0) {
    if (result.timeoutKind === "stall") {
      return { ok: false, reason: "docker pull stalled with no progress" };
    }
    if (result.timeoutKind === "max") {
      return {
        ok: false,
        reason: `docker pull exceeded ${String(profile.pullTimeoutSec)}s safety budget`,
      };
    }
    return { ok: false, reason: `docker pull failed (exit ${String(result.status)})` };
  }
  return { ok: true };
}

// Preserve the vLLM downloadModel API while acquireHuggingFaceModel runs `hf download`.
export function downloadModel(
  profile: VllmProfile,
  model: VllmModelDef,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
  target: { hostCacheDir?: string; userIdentity?: string } = {},
): Promise<{ ok: boolean; reason?: string }> {
  return acquireHuggingFaceModel(
    {
      dockerEnv,
      downloaderImage: profile.image,
      hostCacheDir: target.hostCacheDir ?? hostHfCacheDir(),
      repository: model.id,
      revision: model.revision,
      spawnDocker: dockerSpawn,
      userIdentity: target.userIdentity ?? hostUserIdentity(),
    },
    { logLine: emit, onRateLimit: printHfRateLimitRecovery },
  );
}

function validateDockerArg(value: string, label: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new Error(`${label} must not contain NUL bytes`);
  }
  return value;
}

function validateDockerArgs(args: readonly string[], label: string): string[] {
  return args.map((arg, index) => validateDockerArg(String(arg), `${label}[${String(index)}]`));
}

// Build the `docker run` argv for the long-lived vLLM inference container.
// Exported for testing. `--init` forwards signals and reaps child processes so
// Docker can stop and restart the long-lived server cleanly. `--restart
// unless-stopped` brings it back after a host reboot or Docker daemon restart
// (#4886); without a restart policy the container stays down after a reboot and
// `nemoclaw inference get` fails until onboarding recreates it.
export function buildVllmRunArgs(
  profile: VllmProfile,
  model: VllmModelDef,
  runFlags: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  managedBridgeHost?: string,
): string[] {
  assertVllmRegistryDigestRef(profile.image);
  const image = validateDockerArg(profile.image, "vLLM image");
  const containerName = validateDockerArg(profile.containerName, "vLLM container name");
  const safeRunFlags = validateDockerArgs(runFlags, "vLLM docker run flags");
  const managedApiKey = model.managedBearerAuth ? String(env.VLLM_API_KEY ?? "") : "";
  if (model.managedBearerAuth && !/^[a-f0-9]{64}$/.test(managedApiKey)) {
    throw new Error("Managed host-local vLLM requires a valid host-global API key");
  }
  const managedPublishHost = model.managedBearerAuth
    ? validateManagedVllmBridgeHost(managedBridgeHost ?? "")
    : null;
  return [
    "--pull=never",
    "--init",
    "--restart",
    "unless-stopped",
    ...safeRunFlags,
    "--label",
    `${NEMOCLAW_VLLM_MANAGED_LABEL}=true`,
    ...(profile.servingCatalog
      ? [
          "--label",
          `com.nvidia.nemoclaw.serving-catalog-digest=${profile.servingCatalog.catalogDigest}`,
          "--label",
          `com.nvidia.nemoclaw.serving-preset=${profile.servingCatalog.presetId}`,
          "--label",
          `com.nvidia.nemoclaw.serving-preset-digest=${profile.servingCatalog.presetDigest}`,
          "--label",
          `com.nvidia.nemoclaw.serving-recipe=${profile.servingCatalog.recipeId}`,
          "--label",
          `com.nvidia.nemoclaw.serving-recipe-digest=${profile.servingCatalog.recipeDigest}`,
        ]
      : []),
    ...(model.managedBearerAuth
      ? [
          "--label",
          `${NEMOCLAW_VLLM_HOST_LOCAL_AUTH_LABEL}=${runtimeAuthFingerprint(managedApiKey)}`,
          "--env",
          "VLLM_API_KEY",
        ]
      : []),
    "-p",
    `${model.managedBearerAuth ? "127.0.0.1:" : ""}${String(VLLM_PORT)}:8000`,
    ...(model.managedBearerAuth ? ["-p", `${managedPublishHost}:${String(VLLM_PORT)}:8000`] : []),
    "--name",
    containerName,
    "--entrypoint",
    "/bin/bash",
    image,
    "-lc",
    buildVllmServeCommand(model, env),
  ];
}

function selectedVllmRuntime(
  profile: VllmProfile,
  model: VllmModelDef,
  architecture: NodeJS.Architecture = profile.architecture ?? process.arch,
): VllmRuntimeOverride | VllmRuntimeVariant | undefined {
  const matchingVariants = (model.runtimeVariants ?? [])
    .filter(
      (candidate) =>
        vllmPlatformSpecificity(candidate.platforms, profile.platform) >= 0 &&
        (!candidate.architectures || candidate.architectures.includes(architecture)),
    )
    .sort(
      (left, right) =>
        vllmPlatformSpecificity(left.platforms, profile.platform) -
          vllmPlatformSpecificity(right.platforms, profile.platform) ||
        left.priority - right.priority ||
        (left.catalogPresetId ?? "").localeCompare(right.catalogPresetId ?? ""),
    );
  const runtime = matchingVariants.at(-1) ?? model.runtime;
  if (model.requireRuntimeVariant && !runtime) {
    throw new Error(
      `${model.label} has no managed vLLM runtime for ${profile.name} on ${architecture}.`,
    );
  }
  return runtime;
}

function replaceCatalogGpuRequest(
  profile: VllmProfile,
  runtime: VllmRuntimeOverride,
  extraRunArgs: string[],
): string[] {
  if (runtime.dockerRunArgsMode !== "replace" || !profile.buildDockerRunFlags) {
    return extraRunArgs;
  }
  if (!runtime.catalogPresetId) return extraRunArgs;
  const platformFlags = profile.buildDockerRunFlags();
  const platformGpuIndex = platformFlags.indexOf("--gpus");
  const recipeGpuIndex = extraRunArgs.indexOf("--gpus");
  if (
    platformGpuIndex < 0 ||
    platformGpuIndex === platformFlags.length - 1 ||
    recipeGpuIndex < 0 ||
    recipeGpuIndex === extraRunArgs.length - 1
  ) {
    throw new Error(`${profile.name} did not produce one declarative GPU request.`);
  }
  const replaced = [...extraRunArgs];
  replaced[recipeGpuIndex + 1] = platformFlags[platformGpuIndex + 1]!;
  return replaced;
}

function applyVllmRuntimeProfile(
  profile: VllmProfile,
  model: VllmModelDef,
  runtime: VllmRuntimeOverride | VllmRuntimeVariant | undefined,
): VllmProfile {
  let resolved = profile;
  if (runtime) {
    const extraRunArgs = replaceCatalogGpuRequest(profile, runtime, [
      ...(runtime.dockerRunArgs ?? []),
    ]);
    resolved = {
      ...profile,
      image: runtime.image,
      imageDownloadSizeBytes: runtime.imageDownloadSizeBytes,
      imageUnpackedSizeBytes:
        runtime.imageUnpackedSizeBytes ??
        (runtime.image === profile.image ? profile.imageUnpackedSizeBytes : undefined),
      modelDownloadSizeBytes: runtime.modelDownloadSizeBytes ?? profile.modelDownloadSizeBytes,
      loadTimeoutSec: runtime.loadTimeoutSec ?? profile.loadTimeoutSec,
      dockerRunFlags:
        runtime.dockerRunArgsMode === "replace"
          ? extraRunArgs
          : [...profile.dockerRunFlags, ...extraRunArgs],
      buildDockerRunFlags:
        runtime.dockerRunArgsMode === "replace"
          ? undefined
          : profile.buildDockerRunFlags
            ? () => [...profile.buildDockerRunFlags!(), ...extraRunArgs]
            : undefined,
      pullTimeoutSec: runtime.pullTimeoutSec ?? profile.pullTimeoutSec,
      minComputeCapability: runtime.minComputeCapability ?? model.minComputeCapability,
      minGpuMemoryBytes: runtime.minGpuMemoryBytes,
      gpuMemoryUtilization: runtime.gpuMemoryUtilization,
      servingCatalog: runtime.servingCatalog ?? profile.servingCatalog,
    };
  }
  assertVllmRegistryDigestRef(resolved.image);
  return resolved;
}

export function resolveVllmRuntimeProfile(
  profile: VllmProfile,
  model: VllmModelDef,
  architecture: NodeJS.Architecture = profile.architecture ?? process.arch,
): VllmProfile {
  return applyVllmRuntimeProfile(profile, model, selectedVllmRuntime(profile, model, architecture));
}

export function resolveVllmModelRuntime(
  profile: VllmProfile,
  model: VllmModelDef,
  architecture: NodeJS.Architecture = profile.architecture ?? process.arch,
): { profile: VllmProfile; model: VllmModelDef } {
  const runtime = selectedVllmRuntime(profile, model, architecture);
  const resolvedProfile = applyVllmRuntimeProfile(profile, model, runtime);
  if (!runtime || !("modelArgs" in runtime)) return { profile: resolvedProfile, model };
  return {
    profile: resolvedProfile,
    model: {
      ...model,
      maxModelLen: runtime.maxModelLen,
      revision: runtime.revision,
      servedModelId: runtime.servedModelId,
      modelArgs: runtime.modelArgs,
      serveEnv: runtime.serveEnv,
      installFastSafetensors: runtime.installFastSafetensors,
      fixedServeCommand: runtime.fixedServeCommand,
      managedBearerAuth: runtime.managedBearerAuth,
      trustRemoteCode: runtime.trustRemoteCode,
      runtime,
    },
  };
}

const SHA256_IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMAGE_REPOSITORY_COMPONENT_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

/**
 * Managed vLLM is a product install path, so every effective runtime must be
 * downloadable by immutable registry digest. A bare Docker image/config ID
 * only identifies bytes already present in one daemon and is never a valid
 * product dependency.
 */
export function assertVllmRegistryDigestRef(image: string): void {
  const separator = image.lastIndexOf("@");
  const repository = separator > 0 ? image.slice(0, separator) : "";
  const digest = separator > 0 ? image.slice(separator + 1) : "";
  const components = repository.split("/");
  const firstComponent = components[0] ?? "";
  const portSeparator = firstComponent.lastIndexOf(":");
  const registryOrNamespace =
    portSeparator > 0 && /^\d+$/.test(firstComponent.slice(portSeparator + 1))
      ? firstComponent.slice(0, portSeparator)
      : firstComponent;
  const hasInvalidPort = firstComponent.includes(":") && registryOrNamespace === firstComponent;
  const validRepository =
    separator === image.indexOf("@") &&
    components.length >= 2 &&
    !hasInvalidPort &&
    IMAGE_REPOSITORY_COMPONENT_PATTERN.test(registryOrNamespace) &&
    components.slice(1).every((component) => IMAGE_REPOSITORY_COMPONENT_PATTERN.test(component));

  if (!validRepository || !SHA256_IMAGE_DIGEST_PATTERN.test(digest)) {
    throw new Error(
      "vLLM image must be a pullable immutable registry reference in " +
        `repository@sha256:<64 lowercase hex> form; got '${image}'. ` +
        "Local image IDs and mutable tags are not supported.",
    );
  }
}

type VllmContainerOwnership =
  | { kind: "absent" }
  | { kind: "dual-managed"; containerId: string; running: boolean }
  | { kind: "foreign" }
  | { kind: "managed"; containerId: string; running: boolean }
  | { kind: "unknown" };

function inspectVllmContainerOwnershipInDockerEnv(
  containerName: string,
  env: Record<string, string>,
): VllmContainerOwnership {
  const format = [
    "{{.ID}}",
    "{{.Names}}",
    "{{.State}}",
    `{{.Label "${NEMOCLAW_VLLM_MANAGED_LABEL}"}}`,
    `{{.Label "${DUAL_STATION_VLLM_ROLE_LABEL}"}}`,
    `{{.Label "${DUAL_STATION_VLLM_ENDPOINT_LABEL}"}}`,
    `{{.Label "${DUAL_STATION_VLLM_CLUSTER_LABEL}"}}`,
  ].join("|");
  try {
    const output = dockerCapture(
      [
        "container",
        "ls",
        "--all",
        "--no-trunc",
        "--filter",
        `name=^/${containerName}$`,
        "--format",
        format,
      ],
      { env, timeout: 10_000 },
    ).trim();
    if (!output) return { kind: "absent" };

    const rows = output.split(/\r?\n/);
    if (rows.length !== 1) return { kind: "unknown" };
    const fields = rows[0].split("|");
    if (fields.length !== 7) return { kind: "unknown" };
    const [containerId, observedName, state, managedLabel, dualRole, dualEndpoint, dualCluster] =
      fields;
    if (observedName !== containerName || !DOCKER_CONTAINER_ID_PATTERN.test(containerId)) {
      return { kind: "unknown" };
    }
    if (managedLabel !== "true") return { kind: "foreign" };
    const hasAnyDualLabel = Boolean(dualRole || dualEndpoint || dualCluster);
    if (hasAnyDualLabel) {
      const exactDualHead =
        dualRole === "head" &&
        /^http:\/\/192\.168\.|^http:\/\/10\.|^http:\/\/172\.(?:1[6-9]|2[0-9]|3[01])\./.test(
          dualEndpoint,
        ) &&
        /^[a-f0-9]{64}$/.test(dualCluster);
      return exactDualHead
        ? { kind: "dual-managed", containerId, running: state === "running" }
        : { kind: "unknown" };
    }
    return { kind: "managed", containerId, running: state === "running" };
  } catch {
    return { kind: "unknown" };
  }
}

function inspectVllmContainerOwnership(containerName: string): VllmContainerOwnership {
  // A managed dual-Station head always lives on the physical host's default
  // daemon. Inspect it before following ambient single-host Docker routing so
  // DOCKER_HOST, DOCKER_CONTEXT, or Docker's persisted currentContext cannot
  // hide the pair from running-state detection or replacement guards.
  const canonicalOwnership = inspectVllmContainerOwnershipInDockerEnv(
    containerName,
    buildLocalDualStationDockerEnv(),
  );
  if (canonicalOwnership.kind === "dual-managed" || canonicalOwnership.kind === "unknown") {
    return canonicalOwnership;
  }

  return inspectVllmContainerOwnershipInDockerEnv(containerName, buildVllmDockerEnv());
}

function vllmContainerReplacementTarget(
  containerName: string,
  dockerEnv?: Record<string, string>,
  expectedContainerId?: string,
): { ok: true; containerId?: string } | { ok: false; reason: string } {
  const ownership = dockerEnv
    ? inspectVllmContainerOwnershipInDockerEnv(containerName, dockerEnv)
    : inspectVllmContainerOwnership(containerName);
  if (ownership.kind === "foreign") {
    return {
      ok: false,
      reason: `Container "${containerName}" already exists without the NemoClaw ownership label. NemoClaw will not remove it. Remove or rename that container, then retry managed vLLM installation.`,
    };
  }
  if (ownership.kind === "unknown") {
    return {
      ok: false,
      reason: `Could not verify ownership of Docker container "${containerName}". NemoClaw will not remove it. Check Docker access and retry.`,
    };
  }
  if (ownership.kind === "dual-managed") {
    return {
      ok: false,
      reason:
        `Container "${containerName}" is the head of a managed dual-Station deployment. ` +
        `Refusing single-host replacement because it would orphan the peer worker. Restore ${NEMOCLAW_DGX_STATION_PEER_ENV} and select Nemotron Ultra to manage the pair.`,
    };
  }
  if (
    expectedContainerId &&
    (ownership.kind !== "managed" || ownership.containerId !== expectedContainerId)
  ) {
    return {
      ok: false,
      reason: `Managed vLLM container "${containerName}" changed after recovery. NemoClaw will not remove it. Retry onboarding.`,
    };
  }
  return ownership.kind === "managed"
    ? { ok: true, containerId: ownership.containerId }
    : { ok: true };
}

export function isNemoClawManagedVllmRunning(): boolean {
  try {
    if (recoverInstalledManagedClusterVllmEndpoint()) return true;
  } catch {
    return false;
  }
  const ownership = inspectVllmContainerOwnership(NEMOCLAW_VLLM_CONTAINER_NAME);
  return (ownership.kind === "managed" || ownership.kind === "dual-managed") && ownership.running;
}

export type PersistConfiguredManagedVllmRuntimeResult =
  | { ok: true; persisted: boolean }
  | { ok: false; reason: string };

/**
 * Confirm an installer-owned receipt or adopt an already-running Station pair
 * after onboarding has authenticated and validated its endpoint.
 */
export async function persistConfiguredManagedVllmRuntimeReceipt(): Promise<PersistConfiguredManagedVllmRuntimeResult> {
  try {
    if (recoverInstalledManagedClusterVllmEndpoint()) return { ok: true, persisted: true };
  } catch (error) {
    return { ok: false, reason: `managed vLLM recovery failed: ${(error as Error).message}` };
  }

  try {
    if (recoverHostLocalManagedVllmEndpoint()) return { ok: true, persisted: true };
  } catch (error) {
    return {
      ok: false,
      reason: `managed host-local vLLM recovery failed: ${(error as Error).message}`,
    };
  }

  const configuredPeer = String(process.env[NEMOCLAW_DGX_STATION_PEER_ENV] ?? "").trim();
  let configuredPlan: DualStationVllmPlan | null = null;
  if (configuredPeer) {
    const capability = probeDualStationVllmCapability();
    if (capability.kind !== "ready") {
      const reason =
        capability.kind === "unavailable"
          ? capability.reason
          : "the configured dual-Station peer disappeared";
      return { ok: false, reason };
    }
    configuredPlan = capability.plan;
  }

  try {
    return await withDualStationManagedVllmLifecycle(async () => {
      let plan: DualStationVllmPlan;
      let receiptAlreadyPersisted = false;
      if (configuredPlan) {
        plan = configuredPlan;
      } else {
        const recovered = recoverInstalledDualStationVllmRuntime();
        if (recovered.kind === "not-installed") {
          return {
            ok: false,
            reason: "the managed dual-Station peer configuration is missing",
          };
        }
        if (recovered.kind === "unsafe") {
          return {
            ok: false,
            reason: `the managed dual-Station cleanup receipt is unsafe: ${recovered.reason}`,
          };
        }
        plan = recovered.plan;
        receiptAlreadyPersisted = true;
      }
      const preflight = preflightDualStationManagedVllm(plan);
      if (!preflight.ok) return { ok: false, reason: preflight.reason };
      if (!areDualStationManagedVllmContainersRunning(plan)) {
        return {
          ok: false,
          reason: "the managed dual-Station containers changed before cleanup ownership validation",
        };
      }
      if (receiptAlreadyPersisted) return { ok: true, persisted: true };
      try {
        persistDualStationVllmRuntimeReceipt(plan);
      } catch (error) {
        return { ok: false, reason: (error as Error).message };
      }
      return { ok: true, persisted: true };
    });
  } catch (error) {
    return {
      ok: false,
      reason: `dual-Station lifecycle lock failed: ${(error as Error).message}`,
    };
  }
}

function startContainer(
  profile: VllmProfile,
  model: VllmModelDef,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
  resolveBridgeHost: (dockerEnv: Record<string, string>) => string = (env) =>
    resolveManagedVllmBridgeHost(dockerCapture, env),
  expectedReplacementContainerId?: string,
): { ok: true; containerId: string } | { ok: false; reason: string } {
  emit(`Starting vLLM container (${profile.containerName})`);
  // The explicit download completed before this long-lived container starts,
  // so do not retain the host Hugging Face token in the serving process.
  let runArgs: string[];
  try {
    const resolvedFlags = profile.buildDockerRunFlags
      ? profile.buildDockerRunFlags()
      : profile.dockerRunFlags;
    const commandEnv: NodeJS.ProcessEnv = {
      ...dockerEnv,
      ...(process.env[VLLM_EXTRA_ARGS_ENV] === undefined
        ? {}
        : { [VLLM_EXTRA_ARGS_ENV]: process.env[VLLM_EXTRA_ARGS_ENV] }),
    };
    runArgs = buildVllmRunArgs(
      profile,
      model,
      resolvedFlags,
      commandEnv,
      model.managedBearerAuth ? resolveBridgeHost(dockerEnv) : undefined,
    );
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  // Re-check immediately before teardown. Removing the inspected container ID
  // avoids deleting an unrelated same-name container if the name changes hands.
  const replacement = vllmContainerReplacementTarget(
    profile.containerName,
    model.managedBearerAuth ? dockerEnv : undefined,
    expectedReplacementContainerId,
  );
  if (!replacement.ok) return replacement;
  if (replacement.containerId) {
    dockerForceRm(replacement.containerId, {
      env: dockerEnv,
      ignoreError: true,
      suppressOutput: true,
    });
  }
  const result = dockerRunDetached(runArgs, {
    env: dockerEnv,
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status !== 0) {
    return { ok: false, reason: `docker run failed (exit ${String(result.status)})` };
  }
  const launched = inspectVllmContainerOwnershipInDockerEnv(profile.containerName, dockerEnv);
  if (launched.kind !== "managed") {
    return { ok: false, reason: "the launched vLLM container identity could not be verified" };
  }
  return { ok: true, containerId: launched.containerId };
}

function vllmEndpointReady(baseUrl?: string): boolean {
  if (baseUrl) {
    // The dual-Station /v1 surface is bearer-protected. vLLM deliberately
    // leaves /health outside its auth middleware, so readiness can stay
    // secret-free while onboarding separately validates model inventory with
    // the persisted key.
    return runCurlProbe(
      ["-sS", "--connect-timeout", "2", "--max-time", "5", `${baseUrl.replace(/\/+$/, "")}/health`],
      { pinnedAddresses: [] },
    ).ok;
  }
  const response = runCapture(
    [
      "curl",
      ...buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        `http://127.0.0.1:${String(VLLM_PORT)}/v1/models`,
      ]),
    ],
    { ignoreError: true },
  ).trim();
  if (!response) return false;
  try {
    const parsed = JSON.parse(response) as { data?: unknown };
    return Array.isArray(parsed.data);
  } catch {
    return false;
  }
}

function verifyDualStationVllmAuthBoundary(
  baseUrl: string,
  apiKey: string,
  expectedModelId: string,
): { ok: true } | { ok: false; reason: string } {
  const modelsUrl = `${baseUrl.replace(/\/+$/, "")}/v1/models`;
  const unauthenticated = runCurlProbe(
    ["-sS", "--connect-timeout", "3", "--max-time", "5", modelsUrl],
    { pinnedAddresses: [] },
  );
  if (unauthenticated.httpStatus !== 401) {
    return {
      ok: false,
      reason:
        `unauthenticated model inventory returned HTTP ${String(unauthenticated.httpStatus)}; ` +
        "expected vLLM to reject it with HTTP 401",
    };
  }

  let authConfig: ReturnType<typeof createBearerAuthConfig> | undefined;
  try {
    authConfig = createBearerAuthConfig(apiKey, { prefix: "nemoclaw-vllm-install-auth" });
    const authenticated = runCurlProbe(
      ["-sS", "--connect-timeout", "3", "--max-time", "5", ...authConfig.args, modelsUrl],
      {
        trustedConfigFiles: authConfig.trustedConfigFiles,
        pinnedAddresses: [],
      },
    );
    if (!authenticated.ok) {
      return {
        ok: false,
        reason: `authenticated model inventory failed: ${authenticated.message}`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(authenticated.body);
    } catch {
      return { ok: false, reason: "authenticated model inventory returned malformed JSON" };
    }
    const data = (parsed as { data?: unknown } | null)?.data;
    const ids = (Array.isArray(data) ? data : []).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const id = (entry as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    });
    if (ids.length !== 1 || ids[0] !== expectedModelId) {
      return {
        ok: false,
        reason: `authenticated model inventory did not expose exactly '${expectedModelId}'`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `authenticated model inventory failed: ${(error as Error).message}`,
    };
  } finally {
    authConfig?.cleanup();
  }
}

function sanitizeContainerLogOutput(output: string): string {
  const normalizedOutput = stripVTControlCharacters(output.replace(/\r\n?/g, "\n")).replace(
    /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g,
    "",
  );
  return redact(redactFull(normalizedOutput));
}

function readContainerLogTail(
  profile: VllmProfile,
  lineCount = 80,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): string[] {
  const output = dockerCapture(["logs", "--tail", String(lineCount), profile.containerName], {
    env: dockerEnv,
    ignoreError: true,
    includeStderr: true,
  }).trim();
  if (!output) return [];
  const safeOutput = sanitizeContainerLogOutput(output);
  return safeOutput.split(/\r?\n/).slice(-lineCount);
}

function printContainerLogTail(
  profile: VllmProfile,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): void {
  const tail = readContainerLogTail(profile, 80, dockerEnv);
  if (tail.length === 0) return;
  process.stderr.write(`  --- Last ${String(tail.length)} vLLM log lines: ---\n`);
  for (const line of tail) process.stderr.write(`    ${line}\n`);
  process.stderr.write("  ---\n");
}

// Poll the real OpenAI-compatible models endpoint for the legacy local path,
// or the secret-free vLLM health endpoint for authenticated dual-Station
// serving. Logs stay quiet on the happy path and print only on failure.
function waitForVllmReady(
  profile: VllmProfile,
  baseUrl?: string,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    let resolved = false;
    const start = Date.now();
    let lastHeartbeatAt = start;

    let tick: ReturnType<typeof setInterval> | null = null;

    function done(result: { ok: boolean; reason?: string }): void {
      if (resolved) return;
      resolved = true;
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
      resolve(result);
    }

    function poll(): void {
      if (resolved) return;
      if (vllmEndpointReady(baseUrl)) {
        emit(`vLLM is serving on :${String(VLLM_PORT)}`);
        done({ ok: true });
        return;
      }
      const now = Date.now();
      if ((now - start) / 1000 > profile.loadTimeoutSec) {
        done({
          ok: false,
          reason: `model load exceeded ${String(profile.loadTimeoutSec)}s`,
        });
        return;
      }
      if (!containerStillRunning(profile, dockerEnv)) {
        done({ ok: false, reason: "vLLM container exited before readiness" });
        return;
      }
      const restarts = containerRestartCount(profile, dockerEnv);
      if (restarts >= VLLM_MAX_STARTUP_RESTARTS) {
        done({
          ok: false,
          reason: `vLLM container restarted ${String(restarts)} times before readiness`,
        });
        return;
      }
      if (now - lastHeartbeatAt >= VLLM_LAUNCH_HEARTBEAT_MS) {
        lastHeartbeatAt = now;
        emit(`Still waiting for vLLM (${formatElapsed(now - start)} elapsed; API not ready)`);
      }
    }

    tick = setInterval(poll, 5000);
    poll();
  });
}

function containerRestartCount(
  profile: VllmProfile,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): number {
  const out = dockerCapture(["inspect", "--format", "{{.RestartCount}}", profile.containerName], {
    env: dockerEnv,
    ignoreError: true,
  }).trim();
  const restarts = Number(out);
  return Number.isInteger(restarts) && restarts > 0 ? restarts : 0;
}

function containerStillRunning(
  profile: VllmProfile,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): boolean {
  const out = dockerCapture(
    ["ps", "--filter", `name=${profile.containerName}`, "--format", "{{.Names}}"],
    { env: dockerEnv, ignoreError: true },
  ).trim();
  return out === profile.containerName;
}

function printStorageProbeDetails(label: string, probe: StorageProbeResult, indent = "  "): void {
  console.error(`${indent}${label}: ${storageProbeAvailability(probe)}`);
}

function storageProbeAvailability(probe: StorageProbeResult): string {
  if (probe.ok) {
    return `${formatStorageBytes(probe.capacity.availableBytes)} available at ${probe.capacity.source} (${probe.capacity.path})`;
  }
  return `unknown (${probe.reason})`;
}

interface ManagedStorageRequirement {
  label: string;
  probe: StorageProbeResult;
  requiredBytes: bigint;
}

interface ManagedStorageCheck {
  label: string;
  probe: Extract<StorageProbeResult, { ok: true }>;
  requiredBytes: bigint;
  requirements: ManagedStorageRequirement[];
}

type ManagedStorageProblem =
  | { check: ManagedStorageCheck; kind: "insufficient" }
  | { check: ManagedStorageRequirement; kind: "unknown" };

function managedImageUnpackedRequirementBytes(profile: VllmProfile): number {
  if (profile.imageUnpackedSizeBytes !== undefined) return profile.imageUnpackedSizeBytes;
  return Number(
    imageStorageRequirementBytes(profile.imageDownloadSizeBytes) -
      BigInt(profile.imageDownloadSizeBytes),
  );
}

function managedStorageRequirements({
  dockerProbe,
  estimate,
  includeImage,
  modelProbe,
}: {
  dockerProbe: StorageProbeResult | null;
  estimate: ReturnType<typeof managedVllmStorageEstimateBytes>;
  includeImage: boolean;
  modelProbe: StorageProbeResult | null;
}): ManagedStorageRequirement[] {
  const requirements: ManagedStorageRequirement[] = [];
  if (includeImage && dockerProbe) {
    requirements.push({
      label: "Docker image storage",
      probe: dockerProbe,
      requiredBytes: estimate.imageCompressedBytes + estimate.imageUnpackedBytes,
    });
  }
  if (modelProbe) {
    requirements.push({
      label: "Model cache storage",
      probe: modelProbe,
      requiredBytes:
        estimate.modelBytes + estimate.modelStagingBytes + estimate.writableAllowanceBytes,
    });
  }
  return requirements;
}

function storageCapacityKey(capacity: StorageCapacity): string {
  if (capacity.filesystemId) return `filesystem:${capacity.filesystemId}`;
  return `path:${path.resolve(capacity.path)}`;
}

function managedStorageCheckLabel(requirements: readonly ManagedStorageRequirement[]): string {
  return requirements.map((requirement) => requirement.label).join(" + ");
}

function managedStorageChecks(
  requirements: readonly ManagedStorageRequirement[],
): ManagedStorageCheck[] {
  const aggregateSuccessfulRequirements = requirements.some(
    (requirement) => requirement.probe.ok && !requirement.probe.capacity.filesystemId,
  );
  const checks = new Map<string, ManagedStorageCheck>();
  for (const requirement of requirements) {
    if (!requirement.probe.ok) continue;
    const key = aggregateSuccessfulRequirements
      ? "all-successful-requirements"
      : storageCapacityKey(requirement.probe.capacity);
    const existing = checks.get(key);
    if (existing) {
      existing.requiredBytes += requirement.requiredBytes;
      existing.requirements.push(requirement);
      existing.label = managedStorageCheckLabel(existing.requirements);
      if (requirement.probe.capacity.availableBytes < existing.probe.capacity.availableBytes) {
        existing.probe = requirement.probe;
      }
      continue;
    }
    checks.set(key, {
      label: requirement.label,
      probe: requirement.probe,
      requiredBytes: requirement.requiredBytes,
      requirements: [requirement],
    });
  }
  return Array.from(checks.values());
}

function managedStorageProblem(
  requirements: readonly ManagedStorageRequirement[],
): ManagedStorageProblem | null {
  let insufficient: { check: ManagedStorageCheck; availableBytes: bigint } | null = null;
  for (const check of managedStorageChecks(requirements)) {
    const availableBytes = check.probe.capacity.availableBytes;
    if (availableBytes >= check.requiredBytes) continue;
    if (!insufficient || availableBytes < insufficient.availableBytes) {
      insufficient = { check, availableBytes };
    }
  }
  if (insufficient) return { check: insufficient.check, kind: "insufficient" };
  const unknown =
    requirements.find(
      (requirement) => requirement.label === "Model cache storage" && !requirement.probe.ok,
    ) ?? requirements.find((requirement) => !requirement.probe.ok);
  if (unknown) return { check: unknown, kind: "unknown" };
  return null;
}

function printManagedStorageWarning({
  estimate,
  includeImage,
  model,
  problem,
  profile,
  requirements,
}: {
  estimate: ReturnType<typeof managedVllmStorageEstimateBytes>;
  includeImage: boolean;
  model: VllmModelDef;
  problem: ManagedStorageProblem;
  profile: VllmProfile;
  requirements: readonly ManagedStorageRequirement[];
}): void {
  const insufficient = problem.kind === "insufficient";
  const { check } = problem;
  const subject = includeImage ? "managed vLLM cold install" : "managed vLLM model download";
  console.error("");
  console.error(
    warnLine(`${insufficient ? "Insufficient" : "Unable to verify"} storage for ${subject}.`),
  );
  console.error("");
  console.error(`  Image:     ${profile.image}`);
  if (includeImage) {
    console.error(
      `  Image compressed: ${formatStorageDecimalBytes(estimate.imageCompressedBytes)}`,
    );
    console.error(`  Image unpacked:   ${formatStorageDecimalBytes(estimate.imageUnpackedBytes)}`);
  } else {
    console.error("  Image status:      already cached locally");
  }
  console.error(`  Model:     ${model.id}`);
  console.error(`  Model files:       ${formatStorageDecimalBytes(estimate.modelBytes)}`);
  console.error(`  Model staging:     ${formatStorageDecimalBytes(estimate.modelStagingBytes)}`);
  console.error(
    `  Writable allowance: ${formatStorageDecimalBytes(estimate.writableAllowanceBytes)}`,
  );
  console.error(
    `  Required:  approximately ${formatStorageDecimalBytes(check.requiredBytes)} (${formatStorageBytes(check.requiredBytes)}) for ${check.label}`,
  );
  console.error(
    `  Total estimate: approximately ${formatStorageDecimalBytes(estimate.totalBytes)} (${formatStorageBytes(estimate.totalBytes)})`,
  );
  console.error(`  Available: ${storageProbeAvailability(check.probe)}`);
  if (check.probe.ok) {
    console.error(`  Storage:   ${check.probe.capacity.source} (${check.probe.capacity.path})`);
  } else if (check.probe.path) {
    console.error(`  Storage:   ${check.probe.source ?? "filesystem"} (${check.probe.path})`);
  }
  console.error("");
  for (const storageRequirement of requirements) {
    printStorageProbeDetails(storageRequirement.label, storageRequirement.probe);
    console.error(
      `    Required here: approximately ${formatStorageDecimalBytes(storageRequirement.requiredBytes)} (${formatStorageBytes(storageRequirement.requiredBytes)})`,
    );
  }
  console.error("");
  if (insufficient) {
    console.error("  Free or expand local storage before continuing.");
  }
  console.error("  Useful diagnostics:");
  if (includeImage) {
    console.error("    docker system df");
    console.error("    docker info --format '{{.DockerRootDir}}'");
  }
  console.error('    df -h "$HOME/.cache/huggingface"');
}

async function managedStorageAccepted(
  profile: VllmProfile,
  model: VllmModelDef,
  hasImage: boolean,
  opts: InstallVllmOptions,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): Promise<boolean> {
  const includeImage = !hasImage;
  const modelDownloadSizeBytes = profile.modelDownloadSizeBytes ?? model.downloadSizeBytes;
  if (!Number.isFinite(modelDownloadSizeBytes) || modelDownloadSizeBytes <= 0) {
    throw new Error("vLLM model download size must be a positive finite byte count");
  }
  const snapshotBytes = BigInt(Math.ceil(modelDownloadSizeBytes));
  const snapshotDir = hfModelSnapshotDir(model);
  const cachedBytes = snapshotDir ? measureDirectorySizeBytes(snapshotDir) : 0n;
  const remainingModelBytes = cachedBytes >= snapshotBytes ? 0n : snapshotBytes - cachedBytes;
  const includeModel = remainingModelBytes > 0n;
  const estimate = managedVllmStorageEstimateBytes({
    imageCompressedBytes: profile.imageDownloadSizeBytes,
    imageUnpackedBytes: managedImageUnpackedRequirementBytes(profile),
    includeImage,
    includeModel,
    modelBytes: includeModel ? Number(remainingModelBytes) : modelDownloadSizeBytes,
    writableAllowanceBytes: VLLM_WRITABLE_ALLOWANCE_BYTES,
  });
  const dockerProbe = includeImage
    ? probeDockerStorage({
        dockerContext: dockerEnv.DOCKER_CONTEXT,
        dockerHost: dockerEnv.DOCKER_HOST,
        dockerInfo: () =>
          dockerCapture(["info", "--format", "{{json .}}"], {
            env: dockerEnv,
            ignoreError: true,
            timeout: 10_000,
          }),
      })
    : null;
  const modelProbe = includeModel ? probeHostStorage(hostHfCacheDir(), "Hugging Face cache") : null;
  const requirements = managedStorageRequirements({
    dockerProbe,
    estimate,
    includeImage,
    modelProbe,
  });
  const problem = managedStorageProblem(requirements);
  if (!problem) return true;
  printManagedStorageWarning({
    estimate,
    includeImage,
    model,
    problem,
    profile,
    requirements,
  });
  const unknownModelRequirement = requirements.find(
    (requirement) => requirement.label === "Model cache storage" && !requirement.probe.ok,
  );
  if (problem.kind === "unknown") {
    if (problem.check.label === "Docker image storage") {
      console.error("  Continuing because Docker storage capacity could not be verified.");
      return true;
    }
    if (opts.nonInteractive) {
      console.error(
        "  Non-interactive setup stops because model-cache capacity could not be verified. Re-run interactively to review the warning.",
      );
      return false;
    }
    return isAffirmativeAnswer(
      await opts.promptFn("  Continue with the model download anyway? [y/N]: "),
    );
  }
  if (opts.nonInteractive) {
    if (unknownModelRequirement) {
      printManagedStorageWarning({
        estimate,
        includeImage,
        model,
        problem: { check: unknownModelRequirement, kind: "unknown" },
        profile,
        requirements,
      });
      console.error(
        "  Non-interactive setup stops because model-cache capacity could not be verified. Re-run interactively to review the warning.",
      );
      return false;
    }
    // Confirmed (not merely inconclusive) shortfalls are a known quantity: the
    // pull or download would run the target filesystem to its limit, taking
    // the whole host down with it (#9105). Unlike the "unknown" branch above,
    // there is nothing advisory about a statfs-confirmed deficit, so
    // non-interactive setup must stop the same way an interactive "n" would.
    console.error(
      "  Non-interactive setup stops because confirmed available storage is insufficient. Free space or expand storage, then retry.",
    );
    return false;
  }
  if (!isAffirmativeAnswer(await opts.promptFn("  Continue with the download anyway? [y/N]: "))) {
    return false;
  }
  if (!unknownModelRequirement) return true;
  printManagedStorageWarning({
    estimate,
    includeImage,
    model,
    problem: { check: unknownModelRequirement, kind: "unknown" },
    profile,
    requirements,
  });
  return isAffirmativeAnswer(
    await opts.promptFn("  Continue with the model download anyway? [y/N]: "),
  );
}

function ensureHfCacheDir(model: VllmModelDef): { ok: true } | { ok: false; reason: string } {
  const cacheDir = hostHfCacheDir();
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: `could not create Hugging Face cache directory ${cacheDir}: ${(err as Error).message}`,
    };
  }
  const unwritablePath = findUnwritableModelCachePath(cacheDir, hfModelCacheDir(model));
  if (unwritablePath) {
    const identity = hostUserIdentity() ?? "$(id -u):$(id -g)";
    return {
      ok: false,
      reason:
        `Hugging Face cache path ${unwritablePath} is not writable by host user ${identity}. ` +
        "It may have been created by an earlier root-run downloader; NemoClaw did not modify it. " +
        `Repair ownership, then retry: sudo chown -R ${identity} ${shellQuote(unwritablePath)}`,
    };
  }
  return { ok: true };
}

export interface InstallVllmOptions {
  hasImage: boolean;
  nonInteractive: boolean;
  promptFn: (q: string) => Promise<string>;
  beforeInstall?: (modelId: string) => void;
  /** Persist the validated source model before managed install effects begin. */
  checkpointInstallIntent?: (modelId: string) => void;
  /** Secret-free model restored from an unfinished onboarding checkpoint. */
  modelIntent?: string;
  resolveManagedBridgeHost?: (dockerEnv: Record<string, string>) => string;
  /** Reuse an already-collected readiness snapshot instead of probing the host again. */
  readinessReports?: readonly ManagedInferenceReadinessSource[];
  /**
   * Injected rather than imported so this module does not take a dependency on
   * the onboard preflight layer. onboard.ts supplies the same probe the gateway
   * port check uses. Absent means the caller opted out of the guard.
   */
  checkServingPort?: (port: number) => Promise<ServingPortProbe>;
}

/** The subset of the preflight port probe this module consumes. */
interface ServingPortProbe {
  ok: boolean;
  reason?: string;
}

type VllmInstallSelectionEnv =
  | { readonly ok: true; readonly env: NodeJS.ProcessEnv; readonly explicitModel: string }
  | { readonly ok: false };

function resolveVllmInstallSelectionEnv(
  modelIntent: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VllmInstallSelectionEnv {
  const resumedModel = String(modelIntent ?? "").trim();
  const environmentModel = String(env.NEMOCLAW_VLLM_MODEL ?? "").trim();
  if (
    resumedModel &&
    environmentModel &&
    resumedModel.toLowerCase() !== environmentModel.toLowerCase()
  ) {
    return { ok: false };
  }
  const selectionEnv = resumedModel ? { ...env, NEMOCLAW_VLLM_MODEL: resumedModel } : env;
  return {
    ok: true,
    env: selectionEnv,
    explicitModel: String(selectionEnv.NEMOCLAW_VLLM_MODEL ?? "").trim(),
  };
}

type VllmInstallRequestEnv =
  | {
      readonly ok: true;
      readonly env: NodeJS.ProcessEnv;
      readonly explicitModel: string;
      readonly requestedGpuDevice: string | null;
      readonly configuredPeer: string;
      readonly configuredManagedClusterPeers: string;
    }
  | { readonly ok: false; readonly error: string };

function resolveVllmInstallRequestEnv(
  modelIntent: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): VllmInstallRequestEnv {
  const selection = resolveVllmInstallSelectionEnv(modelIntent, env);
  if (!selection.ok) {
    return {
      ok: false,
      error: "the resumed model conflicts with NEMOCLAW_VLLM_MODEL.",
    };
  }
  const rawGpuDevice = String(env[NEMOCLAW_VLLM_GPU_DEVICE_ENV] ?? "").trim();
  let requestedGpuDevice: string | null = null;
  try {
    requestedGpuDevice = rawGpuDevice ? normalizeVllmGpuDevice(rawGpuDevice) : null;
  } catch (error) {
    return { ok: false, error: `${(error as Error).message}.` };
  }
  const configuredPeer = String(env[NEMOCLAW_DGX_STATION_PEER_ENV] ?? "").trim();
  const configuredManagedClusterPeers = String(
    env[NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV] ?? "",
  ).trim();
  if (requestedGpuDevice && (configuredPeer || configuredManagedClusterPeers)) {
    return {
      ok: false,
      error:
        "--vllm-gpu-device selects one host GPU and cannot be combined with managed multi-node inference.",
    };
  }
  return {
    ...selection,
    requestedGpuDevice,
    configuredPeer,
    configuredManagedClusterPeers,
  };
}

function shouldTryManagedClusterInstall(
  hostLocalSelection: MaterializedHostLocalVllmSelection | undefined,
  fixedServeCommand: boolean,
  requestedGpuDevice: string | null,
): boolean {
  return !hostLocalSelection && !fixedServeCommand && !requestedGpuDevice;
}

function applyRequestedVllmGpuDevice(
  profile: VllmProfile,
  requestedGpuDevice: string | null,
): VllmProfile {
  return requestedGpuDevice ? selectVllmGpuDevice(profile, requestedGpuDevice) : profile;
}

/**
 * Name the process holding the serving port so the operator can act, matching
 * how the Ollama auth proxy reports its own port conflict.
 */
function printServingPortConflict(probe: ServingPortProbe): void {
  console.error(
    `  vLLM install failed: port ${String(VLLM_PORT)} is already in use by another process.`,
  );
  if (probe.reason) console.error(`    ${probe.reason}`);
  console.error("  Stop that process, then rerun onboarding.");
}

export function imageIsCached(
  profile: VllmProfile,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): boolean {
  return Boolean(
    dockerImageInspectFormat("{{.Id}}", profile.image, {
      env: dockerEnv,
      ignoreError: true,
      timeout: 10_000,
    }).trim(),
  );
}

export function resolveVllmServedModelId(modelId: string, extraServeArgs: string[]): string {
  let override: string | null = null;
  for (let index = 0; index < extraServeArgs.length; index += 1) {
    const arg = extraServeArgs[index];
    let values: string[] | null = null;
    if (arg === "--served-model-name") {
      values = [];
      while (index + 1 < extraServeArgs.length && !extraServeArgs[index + 1].startsWith("-")) {
        values.push(extraServeArgs[(index += 1)]);
      }
    } else if (arg.startsWith("--served-model-name=")) {
      values = [arg.slice("--served-model-name=".length)];
    }
    if (!values) continue;
    if (override || values.length !== 1 || !isSafeModelId(values[0])) {
      throw new Error("--served-model-name must specify exactly one safe model ID");
    }
    override = values[0];
  }
  return override ?? modelId;
}

// Public entry point. Returns ok=false on any prereq, pull, run, or load
// failure, plus when the user declines the confirmation prompt.
export async function installVllm(
  profile: VllmProfile,
  opts: InstallVllmOptions,
): Promise<{ ok: boolean }> {
  // The whole managed install can run inside the provider-selection machine
  // state, so name the real sub-stage for the onboarding heartbeat. (#7156)
  const releasePhaseActivity = markPhaseActivity("vLLM install");
  try {
    return await runVllmInstall(profile, opts);
  } finally {
    releasePhaseActivity();
  }
}

async function runVllmInstall(
  profile: VllmProfile,
  opts: InstallVllmOptions,
  hostLocalSelection?: MaterializedHostLocalVllmSelection,
): Promise<{ ok: boolean }> {
  const selection = resolveVllmInstallRequestEnv(opts.modelIntent);
  if (!selection.ok) {
    console.error(`  vLLM install failed: ${selection.error}`);
    return { ok: false };
  }
  const {
    env: selectionEnv,
    explicitModel,
    requestedGpuDevice,
    configuredPeer,
    configuredManagedClusterPeers,
  } = selection;
  const fixedServeCommand = profile.defaultModel.fixedServeCommand === true;
  if (fixedServeCommand) {
    if (
      (!hostLocalSelection && explicitModel) ||
      String(process.env[VLLM_EXTRA_ARGS_ENV] ?? "").trim()
    ) {
      console.error(
        `  vLLM install failed: this local model profile does not accept NEMOCLAW_VLLM_MODEL or ${VLLM_EXTRA_ARGS_ENV}.`,
      );
      return { ok: false };
    }
    const configuredServingPreset = String(process.env[NEMOCLAW_SERVING_PRESET_ENV] ?? "").trim();
    if (configuredManagedClusterPeers) {
      console.error(
        `  vLLM install failed: this local model profile does not accept ${NEMOCLAW_MANAGED_CLUSTER_PEERS_ENV}.`,
      );
      return { ok: false };
    }
    if (configuredServingPreset && configuredServingPreset !== profile.servingCatalog?.presetId) {
      console.error(
        `  vLLM install failed: ${NEMOCLAW_SERVING_PRESET_ENV} must match this local model profile's catalog preset.`,
      );
      return { ok: false };
    }
  }
  if (shouldTryManagedClusterInstall(hostLocalSelection, fixedServeCommand, requestedGpuDevice)) {
    const managedCluster = await tryInstallManagedClusterManagedVllm(
      {
        env: selectionEnv,
        platform: profile.platform,
        nonInteractive: opts.nonInteractive,
        promptFn: opts.promptFn,
        beforeInstall: opts.beforeInstall,
        checkpointInstallIntent: opts.checkpointInstallIntent,
      },
      {
        prerequisites: dockerPrereqsOk,
        pullImage,
        downloadModel,
        printDownloadAuthentication: printHfDownloadAuthentication,
      },
    );
    if (managedCluster.kind === "handled") return managedCluster.result;
  }

  if (
    !hostLocalSelection &&
    !fixedServeCommand &&
    !(profile.platform === "station" && configuredPeer)
  ) {
    const selected = resolveHostLocalVllmSelection(profile, selectionEnv, {
      automatic: opts.nonInteractive,
      readinessReports: opts.readinessReports,
    });
    if (selected.kind === "rejected") {
      console.error(`  vLLM install failed: ${selected.reason}`);
      return { ok: false };
    }
    if (selected.kind === "selected") {
      return await runVllmInstall(selected.profile, opts, selected);
    }
  }

  let dualStationPlan: DualStationVllmPlan | null = null;
  let peerModelSnapshot: "ready" | "staging-required" | null = null;
  const pairedModel =
    profile.platform === "station" && configuredPeer
      ? vllmModelForOrchestration(
          STATION_PAIR_OPTIONAL_ORCHESTRATION,
          "station",
          profile.architecture ?? process.arch,
        )
      : undefined;

  if (profile.platform === "station" && configuredPeer) {
    if (!pairedModel) {
      console.error("  vLLM install failed: the Station-pair model is missing from the catalog");
      return { ok: false };
    }
    const normalizedExplicitModel = explicitModel.toLowerCase();
    if (
      normalizedExplicitModel &&
      normalizedExplicitModel !== pairedModel.envValue.toLowerCase() &&
      normalizedExplicitModel !== pairedModel.id.toLowerCase() &&
      normalizedExplicitModel !== pairedModel.servedModelId?.toLowerCase()
    ) {
      console.error(
        `  vLLM install failed: ${NEMOCLAW_DGX_STATION_PEER_ENV} requires the DGX Station dual-serving model. ` +
          `Unset NEMOCLAW_VLLM_MODEL or select ${pairedModel.envValue}; the explicit model override remains authoritative.`,
      );
      return { ok: false };
    }
  }
  // Model selection lives in `resolveVllmInstallModel` so this entry point
  // stays focused on the docker side effects. Gated-model access is checked
  // there before any docker work happens.
  let resolved: Awaited<ReturnType<typeof resolveVllmInstallModel>>;
  if (profile.platform === "station" && configuredPeer && !explicitModel && pairedModel) {
    const capability = probeDualStationVllmCapability();
    if (capability.kind !== "ready") {
      const reason =
        capability.kind === "unavailable"
          ? capability.reason
          : "the explicit peer configuration disappeared";
      console.error(`  Dual DGX Station setup unavailable: ${reason}`);
      return { ok: false };
    }
    resolved = await resolveVllmInstallModel(
      { ...profile, defaultModel: pairedModel },
      {
        // A qualified explicit peer is the model-selection signal. The normal
        // resolver still owns access validation, but no second model choice is
        // presented after hardware qualification.
        nonInteractive: true,
        promptFn: opts.promptFn,
        env: selectionEnv,
      },
    );
    if (!resolved) return { ok: false };
    dualStationPlan = capability.plan;
    peerModelSnapshot = capability.peerModelSnapshot;
  } else if (hostLocalSelection) {
    try {
      assertGatedModelAccess(hostLocalSelection.model);
    } catch (error) {
      console.error(`  vLLM install failed: ${(error as Error).message}`);
      return { ok: false };
    }
    resolved = { model: hostLocalSelection.model, source: "default" };
  } else {
    resolved = await resolveVllmInstallModel(profile, {
      nonInteractive: opts.nonInteractive || fixedServeCommand,
      promptFn: opts.promptFn,
      env: selectionEnv,
    });
  }
  if (!resolved) return { ok: false };
  if (
    !hostLocalSelection &&
    resolved.source === "picker" &&
    !process.env[VLLM_EXTRA_ARGS_ENV]?.trim()
  ) {
    const selected = resolveHostLocalVllmSelection(
      profile,
      {
        ...selectionEnv,
        NEMOCLAW_VLLM_MODEL: resolved.model.envValue,
      },
      {
        readinessReports: opts.readinessReports,
      },
    );
    if (selected.kind === "rejected") {
      console.error(`  vLLM install failed: ${selected.reason}`);
      return { ok: false };
    }
    if (selected.kind === "selected") {
      return await runVllmInstall(selected.profile, opts, selected);
    }
  }
  let { model } = resolved;
  const { source: modelSource } = resolved;
  // Platform-restricted models are filtered out of the interactive picker,
  // but a direct NEMOCLAW_VLLM_MODEL override bypasses that filter, so this
  // gate is the only platform enforcement on the env-override path. It must
  // reject every wrong-platform model, not just runtime-carrying ones — an
  // NVFP4 Spark checkpoint or a 352 GB Station recipe cannot serve here and
  // must fail before the image pull and download (#7358).
  const architecture = profile.architecture ?? process.arch;
  const usesStationPair = vllmModelUsesOrchestration(
    model,
    STATION_PAIR_OPTIONAL_ORCHESTRATION,
    profile.platform,
    architecture,
  );
  const hasCompatibleRuntime = (model.runtimeVariants ?? []).some(
    (variant) =>
      vllmPlatformSpecificity(variant.platforms, profile.platform) >= 0 &&
      (!variant.architectures || variant.architectures.includes(architecture)),
  );
  if (
    (model.runtimeVariants?.length && !hasCompatibleRuntime) ||
    (!model.runtimeVariants?.length && !model.platforms.includes(profile.platform))
  ) {
    console.error(`  vLLM install failed: ${model.label} is not supported on ${profile.name}`);
    return { ok: false };
  }
  let runtimeProfile: VllmProfile;
  if (
    hostLocalSelection ||
    (profile.platform === "station" && configuredPeer.length > 0 && usesStationPair)
  ) {
    runtimeProfile = profile;
  } else {
    try {
      const runtime = resolveVllmModelRuntime(profile, model);
      runtimeProfile = runtime.profile;
      model = runtime.model;
    } catch (err) {
      console.error(`  vLLM install failed: ${(err as Error).message}`);
      return { ok: false };
    }
  }

  let extraServeArgs: string[];
  let servedModelId: string;
  try {
    if (model.fixedServeCommand && String(process.env[VLLM_EXTRA_ARGS_ENV] ?? "").trim()) {
      throw new Error(`this managed vLLM recipe does not accept ${VLLM_EXTRA_ARGS_ENV}`);
    }
    extraServeArgs = parseVllmExtraServeArgs();
    servedModelId = resolveVllmServedModelId(model.servedModelId ?? model.id, extraServeArgs);
  } catch (err) {
    console.error(`  vLLM install failed: ${(err as Error).message}`);
    return { ok: false };
  }

  if (profile.platform === "station" && usesStationPair) {
    if (!dualStationPlan) {
      const capability = probeDualStationVllmCapability();
      if (capability.kind === "unavailable") {
        console.error(`  Dual DGX Station setup unavailable: ${capability.reason}`);
        return { ok: false };
      }
      if (capability.kind === "ready") {
        dualStationPlan = capability.plan;
        peerModelSnapshot = capability.peerModelSnapshot;
      }
    }
    if (dualStationPlan) {
      servedModelId = dualStationPlan.runtime.servedModelId;
      runtimeProfile = {
        ...runtimeProfile,
        image: dualStationPlan.runtime.image,
        imageDownloadSizeBytes: dualStationPlan.runtime.imageDownloadSizeBytes,
        imageUnpackedSizeBytes: undefined,
        loadTimeoutSec: dualStationPlan.runtime.loadTimeoutSeconds,
        gpuMemoryUtilization: dualStationPlan.runtime.gpuMemoryUtilization,
      };
      if (extraServeArgs.length > 0) {
        console.error(
          `  Dual DGX Station setup does not accept ${VLLM_EXTRA_ARGS_ENV}; the verified distributed launch is fixed.`,
        );
        return { ok: false };
      }
    }
  }

  try {
    runtimeProfile = {
      ...runtimeProfile,
      gpuMemoryUtilization: resolveVllmGpuMemoryUtilization(
        runtimeProfile.gpuMemoryUtilization,
        extraServeArgs,
      ),
    };
  } catch (error) {
    console.error(`  vLLM install failed: ${(error as Error).message}`);
    return { ok: false };
  }

  runtimeProfile = applyRequestedVllmGpuDevice(runtimeProfile, requestedGpuDevice);

  // Reject a held serving port before anything durable happens. In
  // particular, managed bearer auth persists a host credential below and
  // beforeInstall publishes the selected model to onboarding state. Running
  // the guard first keeps a refused install free of both side effects.
  // Port 25000 is not checked here: it belongs to the managed-cluster
  // rendezvous contract and this single-node path never binds it.
  let recoveredHostLocalContainerId: string | undefined;
  const servingPort = await opts.checkServingPort?.(VLLM_PORT);
  if (servingPort && !servingPort.ok) {
    // An interrupted host-local install can leave its authenticated managed
    // container holding the fixed port. Admit that state only after the
    // lifecycle recovery check validates the exact receipt, bindings, and
    // credential fingerprint. The replacement guard below then removes the
    // inspected container ID immediately before the new launch.
    try {
      const recovered = recoverHostLocalManagedVllmEndpoint();
      if (recovered?.baseUrl === `http://127.0.0.1:${String(VLLM_PORT)}`) {
        recoveredHostLocalContainerId = recovered.containerId;
        // Continue through the ordinary managed-container replacement path.
      } else {
        printServingPortConflict(servingPort);
        return { ok: false };
      }
    } catch (error) {
      console.error(
        `  vLLM install failed: managed host-local vLLM recovery could not verify the container: ${(error as Error).message}`,
      );
      return { ok: false };
    }
  }

  opts.beforeInstall?.(servedModelId);

  console.log("");
  console.log(`  vLLM (${runtimeProfile.name}):`);
  console.log(`    Image: ${runtimeProfile.image}`);
  console.log(
    `    Model: ${model.id}${modelSource === "env" ? " (NEMOCLAW_VLLM_MODEL override)" : ""}`,
  );
  if (extraServeArgs.length > 0) {
    console.log(
      `    Extra serve args: ${String(extraServeArgs.length)} token(s) from ${VLLM_EXTRA_ARGS_ENV}`,
    );
  }
  if (dualStationPlan) {
    console.log(
      `    Topology: 2× DGX Station (${dualStationPlan.local.hostname} + ${dualStationPlan.peer.hostname})`,
    );
    console.log(
      `    Fabric: ${dualStationPlan.rails.map((rail) => rail.subnet).join(", ")} (RoCEv2 GID ${String(dualStationPlan.roceGidIndex)})`,
    );
  }
  if (!opts.hasImage) console.log("    Image download on first run, cached after");
  console.log("    Model download on first run, cached after");
  printHfDownloadAuthentication(opts.nonInteractive);
  console.log("");

  const proceed = opts.nonInteractive
    ? true
    : isAffirmativeAnswer(await opts.promptFn("  Continue? [y/N]: "));
  if (!proceed) return { ok: false };

  let hostLocalApiKey: string | null = null;
  let localDockerEnv = dualStationPlan
    ? buildLocalDualStationDockerEnv()
    : model.managedBearerAuth
      ? buildLocalManagedVllmDockerEnv()
      : buildVllmDockerEnv();
  let gpuMemoryWarningShown = false;
  const reportGpuMemoryWarning = (result: GpuMemoryPreflightResult): void => {
    if (!result.ok || !result.warning || gpuMemoryWarningShown) return;
    console.error(warnLine(result.warning));
    gpuMemoryWarningShown = true;
  };

  console.log("");
  console.log("  Installing vLLM. Progress will print below.");

  const prereqs = dockerPrereqsOk();
  if (!prereqs.ok) {
    console.error(`  vLLM install failed: ${String(prereqs.reason)}`);
    return { ok: false };
  }

  const capability = computeCapabilityPreflight(
    model,
    readProfileGpuComputeCapabilities(runtimeProfile),
    runtimeProfile.minComputeCapability,
  );
  if (!capability.ok) {
    console.error(`  vLLM install failed: ${capability.reason}`);
    return { ok: false };
  }

  const memory = installGpuMemoryPreflight(model, runtimeProfile, dualStationPlan);
  reportGpuMemoryWarning(memory);
  if (!memory.ok) {
    console.error(`  vLLM install failed: ${memory.reason}`);
    return { ok: false };
  }

  // Only publish resumable install intent after every read-only hardware
  // guard passes. A rejected preflight must not create credentials or durable
  // onboarding state.
  opts.checkpointInstallIntent?.(explicitModel || model.id);

  // Fail before large downloads when either daemon has an ambiguous or
  // foreign fixed-name container. Each launch path repeats this ownership
  // check immediately before teardown to close the name-transfer race.
  if (dualStationPlan) {
    const preflight = preflightDualStationManagedVllm(dualStationPlan);
    if (!preflight.ok) {
      console.error(`  vLLM install failed: ${preflight.reason}`);
      return { ok: false };
    }
  } else {
    const replacement = vllmContainerReplacementTarget(
      runtimeProfile.containerName,
      model.managedBearerAuth ? localDockerEnv : undefined,
      recoveredHostLocalContainerId,
    );
    if (!replacement.ok) {
      console.error(`  vLLM install failed: ${replacement.reason}`);
      return { ok: false };
    }
  }

  // Guard the host filesystem before an image pull or model-download
  // container can start. The cache path itself is created only after both
  // storage decisions pass, so Docker never creates it as root.
  const hasImage = imageIsCached(runtimeProfile, localDockerEnv);
  if (!(await managedStorageAccepted(runtimeProfile, model, hasImage, opts, localDockerEnv))) {
    return { ok: false };
  }

  const cacheDir = ensureHfCacheDir(model);
  if (!cacheDir.ok) {
    console.error(`  vLLM install failed: ${cacheDir.reason}`);
    return { ok: false };
  }

  const pull = await pullImage(runtimeProfile, localDockerEnv);
  if (!pull.ok) {
    console.error(`  vLLM install failed: ${String(pull.reason)}`);
    return { ok: false };
  }

  if (dualStationPlan) {
    let peerDockerEnv: Record<string, string>;
    try {
      peerDockerEnv = buildRemoteVllmDockerEnv(dualStationPlan.peerSshBinding);
    } catch (err) {
      console.error(`  vLLM install failed: ${(err as Error).message}`);
      return { ok: false };
    }
    emit(`Pulling the pinned vLLM image on peer ${dualStationPlan.peer.hostname}`);
    const peerPull = await pullImage(runtimeProfile, peerDockerEnv);
    if (!peerPull.ok) {
      console.error(`  vLLM install failed on peer: ${String(peerPull.reason)}`);
      return { ok: false };
    }
    const gpuPreflight = await preflightDualStationGpuRuntime(dualStationPlan);
    if (!gpuPreflight.ok) {
      console.error(`  vLLM install failed: ${gpuPreflight.reason}`);
      return { ok: false };
    }
  }

  // A cold image pull can consume the same host filesystem that backs the
  // Hugging Face cache. Re-probe the model destination after the pull before
  // `hf download` starts.
  if (
    !hasImage &&
    !(await managedStorageAccepted(runtimeProfile, model, true, opts, localDockerEnv))
  ) {
    return { ok: false };
  }

  const modelDownload = await downloadModel(runtimeProfile, model, localDockerEnv);
  if (!modelDownload.ok) {
    console.error(`  vLLM install failed: ${String(modelDownload.reason)}`);
    return { ok: false };
  }

  if (dualStationPlan) {
    const stagingPlan = dualStationPlan;
    try {
      const verification = await withDualStationManagedVllmLifecycle(async () => {
        emit(
          peerModelSnapshot === "staging-required"
            ? `Staging the pinned model snapshot on peer ${stagingPlan.peer.hostname}`
            : `Verifying the pinned model snapshot on peer ${stagingPlan.peer.hostname}`,
        );
        const staging = await stageDualStationModelSnapshot(stagingPlan);
        if (!staging.ok) return { ok: false as const, reason: staging.reason };

        const refreshedCapability = probeDualStationVllmCapability();
        if (refreshedCapability.kind !== "ready") {
          const reason =
            refreshedCapability.kind === "unavailable"
              ? refreshedCapability.reason
              : "the explicit peer configuration disappeared";
          return {
            ok: false as const,
            reason: `dual-Station capability changed: ${reason}`,
          };
        }
        if (!sameDualStationTopology(refreshedCapability.plan, stagingPlan)) {
          return {
            ok: false as const,
            reason:
              "dual-Station topology changed during download; rerun setup against a stable pair.",
          };
        }
        if (refreshedCapability.peerModelSnapshot !== "ready") {
          return {
            ok: false as const,
            reason: "peer pinned model snapshot was not verified after staging.",
          };
        }
        const memory = installGpuMemoryPreflight(model, runtimeProfile, refreshedCapability.plan);
        if (!memory.ok) return { ok: false as const, reason: memory.reason };
        return { ok: true as const, plan: refreshedCapability.plan };
      });
      if (!verification.ok) {
        console.error(`  vLLM install failed: ${verification.reason}`);
        return { ok: false };
      }
      dualStationPlan = verification.plan;
    } catch (error) {
      console.error(
        `  vLLM install failed: dual-Station lifecycle lock failed during model verification: ${(error as Error).message}`,
      );
      return { ok: false };
    }
  }

  if (dualStationPlan) {
    const plannedPair = dualStationPlan;
    try {
      return await withDualStationManagedVllmLifecycle(async () => {
        const launchCapability = probeDualStationVllmCapability();
        if (launchCapability.kind !== "ready") {
          const reason =
            launchCapability.kind === "unavailable"
              ? launchCapability.reason
              : "the explicit peer configuration disappeared";
          console.error(`  vLLM install failed: dual-Station capability changed: ${reason}`);
          return { ok: false };
        }
        if (!sameDualStationTopology(launchCapability.plan, plannedPair)) {
          console.error(
            "  vLLM install failed: dual-Station topology changed before launch; rerun setup against a stable pair.",
          );
          return { ok: false };
        }
        if (launchCapability.peerModelSnapshot !== "ready") {
          console.error(
            "  vLLM install failed: peer pinned model snapshot was not verified before launch.",
          );
          return { ok: false };
        }
        const launchPlan = launchCapability.plan;
        const launchMemory = installGpuMemoryPreflight(model, runtimeProfile, launchPlan);
        if (!launchMemory.ok) {
          console.error(`  vLLM install failed: ${launchMemory.reason}`);
          return { ok: false };
        }

        let dualStationApiKey: string;
        try {
          const existingManagedBaseUrl = getDualStationManagedVllmBaseUrl();
          const existingApiKey = existingManagedBaseUrl ? loadDualStationVllmApiKey() : null;
          // If the key file alone was lost, create a new host-global key. The
          // lifecycle fingerprint then forces a coordinated pair replacement
          // under its lock instead of reusing containers bound to an unknown key.
          dualStationApiKey = existingApiKey ?? ensureDualStationVllmApiKey();
        } catch (error) {
          console.error(`  vLLM install failed: ${(error as Error).message}`);
          return { ok: false };
        }

        const start = await startDualStationManagedVllm(launchPlan, {
          apiKey: dualStationApiKey,
        });
        if (!start.ok) {
          console.error(`  vLLM install failed: ${start.reason}`);
          for (const rollbackError of start.rollbackErrors) {
            console.error(`  vLLM rollback warning: ${rollbackError}`);
          }
          return { ok: false };
        }

        const rollbackStartedPair = async (): Promise<void> => {
          if (start.reusedExisting) return;
          if (start.legacyMigration) {
            const rollback = await rollbackDualStationLegacyMigration(
              launchPlan,
              start.legacyMigration,
            );
            if (!rollback.ok) {
              for (const rollbackError of rollback.rollbackErrors) {
                console.error(`  vLLM rollback warning: ${rollbackError}`);
              }
            }
            return;
          }
          const cleanup = await cleanupDualStationManagedVllm(launchPlan);
          if (!cleanup.ok) console.error(`  vLLM rollback warning: ${cleanup.reason}`);
        };

        emit("Launching vLLM");
        emit(
          `Launch can take 5 minutes to ${String(Math.ceil(runtimeProfile.loadTimeoutSec / 60))} minutes`,
        );

        const ready = await waitForVllmReady(runtimeProfile, start.baseUrl, localDockerEnv);
        if (!ready.ok) {
          printContainerLogTail(runtimeProfile, localDockerEnv);
          await rollbackStartedPair();
          console.error(`  vLLM install failed: ${String(ready.reason)}`);
          return { ok: false };
        }

        const authBoundary = verifyDualStationVllmAuthBoundary(
          start.baseUrl,
          dualStationApiKey,
          servedModelId,
        );
        if (!authBoundary.ok) {
          await rollbackStartedPair();
          console.error(`  vLLM install failed: ${authBoundary.reason}`);
          return { ok: false };
        }

        if (!areDualStationManagedVllmContainersRunning(launchPlan)) {
          await rollbackStartedPair();
          console.error("  vLLM distributed containers exited unexpectedly after readiness");
          return { ok: false };
        }

        let legacyMigrationCommitted = false;
        if (start.legacyMigration) {
          const commit = await commitDualStationLegacyMigration(launchPlan, start.legacyMigration);
          if (!commit.ok) {
            await rollbackStartedPair();
            console.error(`  vLLM install failed: ${commit.reason}`);
            return { ok: false };
          }
          for (const warning of commit.cleanupWarnings) {
            console.error(`  vLLM cleanup warning: ${warning}`);
          }
          legacyMigrationCommitted = true;
        }

        try {
          persistDualStationVllmRuntimeReceipt(launchPlan);
        } catch (error) {
          if (legacyMigrationCommitted) {
            const cleanup = await cleanupDualStationManagedVllm(launchPlan);
            if (!cleanup.ok) console.error(`  vLLM rollback warning: ${cleanup.reason}`);
          } else {
            await rollbackStartedPair();
          }
          console.error(
            `  vLLM install failed: could not persist the dual-Station cleanup receipt: ${(error as Error).message}`,
          );
          return { ok: false };
        }

        console.log(`  ✓ vLLM ready across two DGX Stations at ${start.baseUrl}`);
        return { ok: true };
      });
    } catch (error) {
      console.error(
        `  vLLM install failed: dual-Station lifecycle lock failed: ${(error as Error).message}`,
      );
      return { ok: false };
    }
  }

  const launchMemory = installGpuMemoryPreflight(model, runtimeProfile, null);
  reportGpuMemoryWarning(launchMemory);
  if (!launchMemory.ok) {
    console.error(`  vLLM install failed: ${launchMemory.reason}`);
    return { ok: false };
  }

  if (model.managedBearerAuth) {
    try {
      hostLocalApiKey = ensureDualStationVllmApiKey();
      localDockerEnv = buildLocalManagedVllmDockerEnv({ VLLM_API_KEY: hostLocalApiKey });
    } catch (error) {
      console.error(`  vLLM install failed: ${(error as Error).message}`);
      return { ok: false };
    }
  }

  const start = startContainer(
    runtimeProfile,
    model,
    localDockerEnv,
    opts.resolveManagedBridgeHost,
    recoveredHostLocalContainerId,
  );
  if (!start.ok) {
    console.error(`  vLLM install failed: ${String(start.reason)}`);
    return { ok: false };
  }
  if (runtimeProfile.servingCatalog) {
    if (!hostLocalApiKey) {
      dockerForceRm(start.containerId, {
        env: localDockerEnv,
        ignoreError: true,
        suppressOutput: true,
      });
      console.error("  vLLM install failed: managed host-local API key was not provisioned");
      return { ok: false };
    }
    try {
      persistHostLocalVllmRuntimeReceipt({
        containerId: start.containerId,
        authFingerprint: runtimeAuthFingerprint(hostLocalApiKey),
        serving: runtimeProfile.servingCatalog,
      });
    } catch (error) {
      dockerForceRm(start.containerId, {
        env: localDockerEnv,
        ignoreError: true,
        suppressOutput: true,
      });
      console.error(
        `  vLLM install failed: could not persist the host-local ownership receipt: ${(error as Error).message}`,
      );
      return { ok: false };
    }
  }

  emit("Launching vLLM");
  emit(
    `Launch can take 5 minutes to ${String(Math.ceil(runtimeProfile.loadTimeoutSec / 60))} minutes`,
  );

  const hostLocalBaseUrl = model.managedBearerAuth
    ? `http://127.0.0.1:${String(VLLM_PORT)}`
    : undefined;
  const ready = await waitForVllmReady(runtimeProfile, hostLocalBaseUrl, localDockerEnv);
  if (!ready.ok) {
    printContainerLogTail(runtimeProfile, localDockerEnv);
    dockerStop(runtimeProfile.containerName, {
      env: localDockerEnv,
      ignoreError: true,
      suppressOutput: true,
    });
    console.error(`  vLLM install failed: ${String(ready.reason)}`);
    return { ok: false };
  }

  if (!containerStillRunning(runtimeProfile, localDockerEnv)) {
    console.error("  vLLM container exited unexpectedly after readiness");
    return { ok: false };
  }

  if (model.managedBearerAuth) {
    if (!hostLocalApiKey) {
      console.error("  vLLM install failed: managed host-local API key was not provisioned");
      return { ok: false };
    }
    const authBoundary = verifyDualStationVllmAuthBoundary(
      hostLocalBaseUrl!,
      hostLocalApiKey,
      servedModelId,
    );
    if (!authBoundary.ok) {
      dockerStop(runtimeProfile.containerName, {
        env: localDockerEnv,
        ignoreError: true,
        suppressOutput: true,
      });
      console.error(`  vLLM install failed: ${authBoundary.reason}`);
      return { ok: false };
    }
  }

  console.log(`  ✓ vLLM ready on localhost:${String(VLLM_PORT)}`);
  return { ok: true };
}
