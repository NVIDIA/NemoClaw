// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM container actions invoked from onboard.ts. Detection of "should we
// offer vLLM at all" lives in onboard.ts; this module owns picking the
// right profile per platform and running the install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  dockerCapture,
  dockerForceRm,
  dockerImageInspectFormat,
  dockerPullWithProgressWatchdog,
  dockerRunDetached,
  dockerSpawn,
  dockerStop,
} from "../adapters/docker";
import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { warnLine } from "../cli/terminal-style";
import { VLLM_PORT } from "../core/ports";
import { shellQuote } from "../core/shell-quote";
import { isAffirmativeAnswer } from "../onboard/prompt-helpers";
import { runCapture } from "../runner";
import { isSafeModelId } from "../validation";
import { getGpuIndicesByName } from "./nim";
import { buildVllmDockerEnv } from "./vllm-docker-env";
import {
  buildVllmServeCommand,
  NEMOTRON_ULTRA_STATION_IMAGE,
  parseVllmExtraServeArgs,
  VLLM_EXTRA_ARGS_ENV,
  VLLM_MODELS,
  type VllmModelDef,
  type VllmPlatform,
} from "./vllm-models";
import { resolveVllmInstallModel } from "./vllm-prompt";
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

// Per-platform install recipe. Add new platforms by appending an entry to
// the profile table at the bottom of this file. The menu key in onboard.ts
// stays "install-vllm" regardless of platform.
export interface VllmProfile {
  name: string; // human label, e.g. "DGX Spark"
  // Platform key matched against `VllmModelDef.platforms` when the picker
  // filters the registry. Decoupled from `name` so future user-facing label
  // tweaks don't change which models are offered.
  platform: VllmPlatform;
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
}

interface VllmImageCatalogEntry {
  downloadSizeBytes: number;
  ref: string;
  unpackedSizeBytes?: number;
}

const VLLM_WRITABLE_ALLOWANCE_BYTES = 816_000_000;

// Platform manifests and decimal compressed sizes published by NGC for the
// named release tags. Pinning the digest makes a cache hit authoritative: an
// explicit pull cannot begin downloading different same-tag layers. Unpacked
// sizes are digest-catalog values measured ahead of time because OCI metadata
// does not publish exact uncompressed byte counts.
export const VLLM_IMAGES = {
  vllm022: NEMOTRON_ULTRA_STATION_IMAGE,
  ngc2603Post1: {
    tag: "nvcr.io/nvidia/vllm:26.03.post1-py3",
    amd64: {
      ref: "nvcr.io/nvidia/vllm@sha256:7be6c2f676c36059a494fe17254e69ae5c677535ba6191044e5fc8e42a91c773",
      downloadSizeBytes: 8_928_665_752,
    },
    arm64: {
      ref: "nvcr.io/nvidia/vllm@sha256:447995cbb57e6c7cf792cab95e9852e5f62b5fb6d2f39e030fa4eda9a54eadb4",
      downloadSizeBytes: 9_278_081_698,
    },
  },
  ngc2605Post1: {
    tag: "nvcr.io/nvidia/vllm:26.05.post1-py3",
    arm64: {
      ref: "nvcr.io/nvidia/vllm@sha256:9204569b17ee4c0eff75194b8e6e458479c8aee18953b5ab9cf359fcdac659e2",
      downloadSizeBytes: 9_603_085_145,
      unpackedSizeBytes: 27_658_526_720,
    },
  },
} as const;

function nemotronNanoModel(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-nano-4b");
  if (!match) throw new Error("vllm-models registry is missing the nemotron-3-nano-4b entry");
  return match;
}

function deepseekV4FlashModel(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "deepseek-v4-flash");
  if (!match) throw new Error("vllm-models registry is missing the deepseek-v4-flash entry");
  return match;
}

function qwen35bNvfp4Model(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4");
  if (!match) throw new Error("vllm-models registry is missing the qwen3.6-35b-a3b-nvfp4 entry");
  return match;
}

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;
const MODEL_DOWNLOAD_HEARTBEAT_MS = 30_000;
const VLLM_LAUNCH_HEARTBEAT_MS = 30_000;
const HF_CACHE_CONTAINER_DIR = "/root/.cache/huggingface";
const HF_DOWNLOAD_CACHE_CONTAINER_DIR = "/tmp/nemoclaw-huggingface";
const HF_CACHE_COMPONENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const NEMOCLAW_VLLM_CONTAINER_NAME = "nemoclaw-vllm";
export const NEMOCLAW_VLLM_MANAGED_LABEL = "com.nvidia.nemoclaw.managed-vllm";
const DOCKER_CONTAINER_ID_PATTERN = /^[a-f0-9]{12,64}$/;

function hostHfCacheDir(): string {
  return path.join(os.homedir(), ".cache", "huggingface");
}

function hfCacheMount(): string {
  return `${hostHfCacheDir()}:${HF_CACHE_CONTAINER_DIR}`;
}

function hfDownloadCacheMount(): string {
  return `${hostHfCacheDir()}:${HF_DOWNLOAD_CACHE_CONTAINER_DIR}`;
}

function hfModelCacheKey(model: VllmModelDef): string | null {
  const modelParts = model.id.split("/");
  if (modelParts.some((part) => !HF_CACHE_COMPONENT_PATTERN.test(part))) return null;
  return `models--${modelParts.join("--")}`;
}

function hfModelSnapshotDir(model: VllmModelDef): string | null {
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

function hostUserDockerArgs(): string[] {
  const identity = hostUserIdentity();
  return identity ? ["--user", identity] : [];
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

function pickHfTokenEntry(
  env: NodeJS.ProcessEnv = process.env,
): { key: (typeof HF_TOKEN_ENV_KEYS)[number]; value: string } | null {
  for (const key of HF_TOKEN_ENV_KEYS) {
    const value = String(env[key] ?? "").trim();
    if (value) return { key, value };
  }
  return null;
}

/**
 * Forward a Hugging Face token from the host into the one-shot `hf download`
 * container so gated model weights can be fetched.
 *
 * Returns the bare `-e KEY` form (no `=value`) so the token never lands in
 * the host process list. Docker reads the actual value from its own
 * environment, which the caller is responsible for populating via
 * `buildHfTokenForwardEnv` when spawning through the runner allowlist.
 * The download container can live for several minutes during a cold pull;
 * argv-embedded secrets would be visible via `ps` for that whole window.
 */
export function buildHfTokenDockerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const entry = pickHfTokenEntry(env);
  return entry ? ["-e", entry.key] : [];
}

/**
 * Companion to `buildHfTokenDockerArgs`: returns the `{ KEY: value }` map
 * that has to be merged into the subprocess env so docker can see the
 * token when `-e KEY` (key-only) tells it to forward by name. The CLI runner
 * strips non-allowlisted env names by default (see subprocess-env.ts), so
 * Docker callers must pass this map via the runner's `env` option.
 */
export function buildHfTokenForwardEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const entry = pickHfTokenEntry(env);
  return entry ? { [entry.key]: entry.value } : {};
}

const SPARK_PROFILE: VllmProfile = {
  name: "DGX Spark",
  platform: "spark",
  image: VLLM_IMAGES.ngc2605Post1.arm64.ref,
  imageDownloadSizeBytes: VLLM_IMAGES.ngc2605Post1.arm64.downloadSizeBytes,
  imageUnpackedSizeBytes: VLLM_IMAGES.ngc2605Post1.arm64.unpackedSizeBytes,
  defaultModel: qwen35bNvfp4Model(),
  containerName: NEMOCLAW_VLLM_CONTAINER_NAME,
  dockerRunFlags: vllmDockerRunFlags(),
  pullTimeoutSec: 12 * 60 * 60,
  loadTimeoutSec: 1800,
};

// DGX Station.
const STATION_PROFILE: VllmProfile = {
  name: "DGX Station",
  platform: "station",
  image: VLLM_IMAGES.ngc2605Post1.arm64.ref,
  imageDownloadSizeBytes: VLLM_IMAGES.ngc2605Post1.arm64.downloadSizeBytes,
  imageUnpackedSizeBytes: VLLM_IMAGES.ngc2605Post1.arm64.unpackedSizeBytes,
  defaultModel: deepseekV4FlashModel(),
  containerName: NEMOCLAW_VLLM_CONTAINER_NAME,
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  buildDockerRunFlags: () => {
    const indices = getGpuIndicesByName(/GB300/i);
    // Docker parses --gpus as CSV, so multi-device values must retain
    // double quotes inside the argv token to keep the comma in one field.
    const gpuFlag =
      indices.length === 0
        ? "all"
        : indices.length === 1
          ? `device=${indices[0]}`
          : `"device=${indices.join(",")}"`;
    return vllmDockerRunFlags(gpuFlag);
  },
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
};

// Generic discrete-GPU Linux. Uses a small nemotron model that fits on
// most GPUs.
const genericLinuxImage: VllmImageCatalogEntry | null =
  process.arch === "arm64"
    ? VLLM_IMAGES.ngc2603Post1.arm64
    : process.arch === "x64"
      ? VLLM_IMAGES.ngc2603Post1.amd64
      : null;

const GENERIC_LINUX_PROFILE: VllmProfile | null = genericLinuxImage
  ? {
      name: "Linux + NVIDIA GPU",
      platform: "linux",
      image: genericLinuxImage.ref,
      imageDownloadSizeBytes: genericLinuxImage.downloadSizeBytes,
      imageUnpackedSizeBytes: genericLinuxImage.unpackedSizeBytes,
      defaultModel: nemotronNanoModel(),
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
        platform?: "spark" | "station" | "linux";
      }
    | null
    | undefined,
): VllmProfile | null {
  if (gpu?.platform === "spark") return SPARK_PROFILE;
  if (gpu?.platform === "station") return STATION_PROFILE;
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
  if (!runCapture(["sh", "-c", "command -v nvidia-smi"], { ignoreError: true }).trim()) {
    return { ok: false, reason: "nvidia-smi not found — vLLM requires NVIDIA drivers" };
  }
  if (!runCapture(["sh", "-c", "command -v curl"], { ignoreError: true }).trim()) {
    return { ok: false, reason: "curl not found on PATH — vLLM readiness checks require curl" };
  }
  return { ok: true };
}

export async function pullImage(profile: VllmProfile): Promise<{ ok: boolean; reason?: string }> {
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
    env: buildVllmDockerEnv(),
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

// Run `hf download <model>` inside a one-shot container of the same image.
function downloadModel(
  profile: VllmProfile,
  model: VllmModelDef,
): Promise<{ ok: boolean; reason?: string }> {
  emit(`Pre-downloading model with hf: ${model.id}`);
  return new Promise((resolve) => {
    const proc = dockerSpawn(
      [
        "run",
        "-t",
        "--rm",
        "--pull=never",
        ...hostUserDockerArgs(),
        "--entrypoint",
        "hf",
        "-v",
        hfDownloadCacheMount(),
        "-e",
        `HF_HOME=${HF_DOWNLOAD_CACHE_CONTAINER_DIR}`,
        ...buildHfTokenDockerArgs(),
        profile.image,
        "download",
        model.id,
        ...(model.revision ? ["--revision", model.revision] : []),
      ],
      {
        env: buildVllmDockerEnv(buildHfTokenForwardEnv()),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const tail: string[] = [];
    const TAIL_MAX = 50;
    let resolved = false;
    const start = Date.now();
    let lastOutputAt = start;
    let lastOutputEndedCleanly = true;
    const heartbeat = setInterval(() => {
      const now = Date.now();
      if (now - lastOutputAt >= MODEL_DOWNLOAD_HEARTBEAT_MS) {
        if (!lastOutputEndedCleanly) process.stdout.write("\n");
        emit(`Model download still running (${formatElapsed(now - start)} elapsed; no new output)`);
        lastOutputAt = now;
        lastOutputEndedCleanly = true;
      }
    }, MODEL_DOWNLOAD_HEARTBEAT_MS);
    heartbeat.unref?.();

    function done(result: { ok: boolean; reason?: string }): void {
      if (resolved) return;
      resolved = true;
      clearInterval(heartbeat);
      resolve(result);
    }

    function rememberTail(text: string): void {
      for (const segment of text.split(/[\r\n]+/)) {
        if (!segment) continue;
        tail.push(segment);
        if (tail.length > TAIL_MAX) tail.shift();
      }
    }

    function onChunk(buf: Buffer, stream: NodeJS.WriteStream): void {
      lastOutputAt = Date.now();
      stream.write(buf);
      const text = buf.toString();
      lastOutputEndedCleanly = /[\r\n]$/.test(text);
      rememberTail(text);
    }

    proc.stdout?.on("data", (buf: Buffer) => onChunk(buf, process.stdout));
    proc.stderr?.on("data", (buf: Buffer) => onChunk(buf, process.stderr));

    proc.on("error", (err: Error) => {
      done({ ok: false, reason: `spawn error: ${err.message}` });
    });

    proc.on("exit", (code: number | null) => {
      if (code === 0) {
        if (!lastOutputEndedCleanly) process.stdout.write("\n");
        emit("Model download complete");
        done({ ok: true });
        return;
      }
      // Surface the last few raw lines so a failure has actionable context.
      if (tail.length > 0) {
        process.stderr.write(`  --- Last ${String(tail.length)} hf output lines: ---\n`);
        for (const line of tail) process.stderr.write(`    ${line}\n`);
        process.stderr.write("  ---\n");
      }
      done({ ok: false, reason: `hf download failed (exit ${String(code)})` });
    });
  });
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
// Exported for testing. `--restart unless-stopped` makes the container come
// back after a host reboot or Docker daemon restart (#4886); without a restart
// policy the container stays down after a reboot and `nemoclaw inference get`
// fails until a full `nemoclaw onboard --fresh --gpu` recreates it.
export function buildVllmRunArgs(
  profile: VllmProfile,
  model: VllmModelDef,
  runFlags: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  assertVllmRegistryDigestRef(profile.image);
  const image = validateDockerArg(profile.image, "vLLM image");
  const containerName = validateDockerArg(profile.containerName, "vLLM container name");
  const safeRunFlags = validateDockerArgs(runFlags, "vLLM docker run flags");
  return [
    "--pull=never",
    "--restart",
    "unless-stopped",
    ...safeRunFlags,
    "--label",
    `${NEMOCLAW_VLLM_MANAGED_LABEL}=true`,
    "-p",
    `${String(VLLM_PORT)}:8000`,
    "--name",
    containerName,
    "--entrypoint",
    "/bin/bash",
    image,
    "-lc",
    buildVllmServeCommand(model, env),
  ];
}

export function resolveVllmRuntimeProfile(profile: VllmProfile, model: VllmModelDef): VllmProfile {
  const runtime = model.runtime;
  let resolved = profile;
  if (runtime) {
    const extraRunArgs = [...(runtime.dockerRunArgs ?? [])];
    resolved = {
      ...profile,
      image: runtime.image,
      imageDownloadSizeBytes: runtime.imageDownloadSizeBytes,
      imageUnpackedSizeBytes: undefined,
      modelDownloadSizeBytes: runtime.modelDownloadSizeBytes ?? profile.modelDownloadSizeBytes,
      loadTimeoutSec: runtime.loadTimeoutSec ?? profile.loadTimeoutSec,
      dockerRunFlags: [...profile.dockerRunFlags, ...extraRunArgs],
      buildDockerRunFlags: profile.buildDockerRunFlags
        ? () => [...profile.buildDockerRunFlags!(), ...extraRunArgs]
        : undefined,
    };
  }
  assertVllmRegistryDigestRef(resolved.image);
  return resolved;
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
  | { kind: "foreign" }
  | { kind: "managed"; containerId: string; running: boolean }
  | { kind: "unknown" };

function inspectVllmContainerOwnership(containerName: string): VllmContainerOwnership {
  const format = `{{.ID}}|{{.Names}}|{{.State}}|{{.Label "${NEMOCLAW_VLLM_MANAGED_LABEL}"}}`;
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
      { env: buildVllmDockerEnv(), timeout: 10_000 },
    ).trim();
    if (!output) return { kind: "absent" };

    const rows = output.split(/\r?\n/);
    if (rows.length !== 1) return { kind: "unknown" };
    const fields = rows[0].split("|");
    if (fields.length !== 4) return { kind: "unknown" };
    const [containerId, observedName, state, managedLabel] = fields;
    if (observedName !== containerName || !DOCKER_CONTAINER_ID_PATTERN.test(containerId)) {
      return { kind: "unknown" };
    }
    if (managedLabel !== "true") return { kind: "foreign" };
    return { kind: "managed", containerId, running: state === "running" };
  } catch {
    return { kind: "unknown" };
  }
}

function vllmContainerReplacementTarget(
  containerName: string,
): { ok: true; containerId?: string } | { ok: false; reason: string } {
  const ownership = inspectVllmContainerOwnership(containerName);
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
  return ownership.kind === "managed"
    ? { ok: true, containerId: ownership.containerId }
    : { ok: true };
}

export function isNemoClawManagedVllmRunning(): boolean {
  const ownership = inspectVllmContainerOwnership(NEMOCLAW_VLLM_CONTAINER_NAME);
  return ownership.kind === "managed" && ownership.running;
}

function startContainer(
  profile: VllmProfile,
  model: VllmModelDef,
): { ok: boolean; reason?: string } {
  emit(`Starting vLLM container (${profile.containerName})`);
  const resolvedFlags = profile.buildDockerRunFlags
    ? profile.buildDockerRunFlags()
    : profile.dockerRunFlags;
  // The explicit download completed before this long-lived container starts,
  // so do not retain the host Hugging Face token in the serving process.
  let runArgs: string[];
  try {
    runArgs = buildVllmRunArgs(profile, model, resolvedFlags);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  // Re-check immediately before teardown. Removing the inspected container ID
  // avoids deleting an unrelated same-name container if the name changes hands.
  const replacement = vllmContainerReplacementTarget(profile.containerName);
  if (!replacement.ok) return replacement;
  if (replacement.containerId) {
    dockerForceRm(replacement.containerId, {
      env: buildVllmDockerEnv(),
      ignoreError: true,
      suppressOutput: true,
    });
  }
  const result = dockerRunDetached(runArgs, {
    env: buildVllmDockerEnv(),
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status !== 0) {
    return { ok: false, reason: `docker run failed (exit ${String(result.status)})` };
  }
  return { ok: true };
}

function vllmModelsEndpoint(): string {
  return `http://127.0.0.1:${String(VLLM_PORT)}/v1/models`;
}

function vllmEndpointReady(): boolean {
  const response = runCapture(
    [
      "curl",
      ...buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "2",
        "--max-time",
        "5",
        vllmModelsEndpoint(),
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

function readContainerLogTail(profile: VllmProfile, lineCount = 80): string[] {
  const output = dockerCapture(["logs", "--tail", String(lineCount), profile.containerName], {
    env: buildVllmDockerEnv(),
    ignoreError: true,
  }).trim();
  if (!output) return [];
  return output.split(/\r?\n/).slice(-lineCount);
}

function printContainerLogTail(profile: VllmProfile): void {
  const tail = readContainerLogTail(profile);
  if (tail.length === 0) return;
  process.stderr.write(`  --- Last ${String(tail.length)} vLLM log lines: ---\n`);
  for (const line of tail) process.stderr.write(`    ${line}\n`);
  process.stderr.write("  ---\n");
}

// Poll the real OpenAI-compatible models endpoint instead of interpreting
// vLLM startup logs. Logs stay quiet on the happy path and print only on
// failure.
function waitForVllmReady(profile: VllmProfile): Promise<{ ok: boolean; reason?: string }> {
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
      if (vllmEndpointReady()) {
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
      if (!containerStillRunning(profile)) {
        done({ ok: false, reason: "vLLM container exited before readiness" });
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

function containerStillRunning(profile: VllmProfile): boolean {
  const out = dockerCapture(
    ["ps", "--filter", `name=${profile.containerName}`, "--format", "{{.Names}}"],
    { env: buildVllmDockerEnv(), ignoreError: true },
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
  const dockerProbe = includeImage ? probeDockerStorage() : null;
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
    console.error(
      "  Continuing because managed vLLM storage estimates are advisory in non-interactive setup.",
    );
    return true;
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

interface InstallVllmOptions {
  hasImage: boolean;
  nonInteractive: boolean;
  promptFn: (q: string) => Promise<string>;
  beforeInstall?: (modelId: string) => void;
}

function imageIsCached(profile: VllmProfile): boolean {
  return Boolean(
    dockerImageInspectFormat("{{.Id}}", profile.image, {
      env: buildVllmDockerEnv(),
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
  // Model selection lives in `resolveVllmInstallModel` so this entry point
  // stays focused on the docker side effects. Gated-model access is checked
  // there before any docker work happens.
  const resolved = await resolveVllmInstallModel(profile, {
    nonInteractive: opts.nonInteractive,
    promptFn: opts.promptFn,
  });
  if (!resolved) return { ok: false };
  const { model, source: modelSource } = resolved;
  if (model.runtime && !model.platforms.includes(profile.platform)) {
    console.error(`  vLLM install failed: ${model.label} is not supported on ${profile.name}`);
    return { ok: false };
  }
  let runtimeProfile: VllmProfile;
  try {
    runtimeProfile = resolveVllmRuntimeProfile(profile, model);
  } catch (err) {
    console.error(`  vLLM install failed: ${(err as Error).message}`);
    return { ok: false };
  }

  let extraServeArgs: string[];
  let servedModelId: string;
  try {
    extraServeArgs = parseVllmExtraServeArgs();
    servedModelId = resolveVllmServedModelId(model.servedModelId ?? model.id, extraServeArgs);
  } catch (err) {
    console.error(`  vLLM install failed: ${(err as Error).message}`);
    return { ok: false };
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
  if (!opts.hasImage) console.log("    Image download on first run, cached after");
  console.log("    Model download on first run, cached after");
  console.log("");

  const proceed = opts.nonInteractive
    ? true
    : isAffirmativeAnswer(await opts.promptFn("  Continue? [y/N]: "));
  if (!proceed) return { ok: false };

  console.log("");
  console.log("  Installing vLLM. Progress will print below.");

  const prereqs = dockerPrereqsOk();
  if (!prereqs.ok) {
    console.error(`  vLLM install failed: ${String(prereqs.reason)}`);
    return { ok: false };
  }

  // Fail before large downloads when the fixed name belongs to another
  // operator. startContainer repeats this check to close the teardown race.
  const replacement = vllmContainerReplacementTarget(runtimeProfile.containerName);
  if (!replacement.ok) {
    console.error(`  vLLM install failed: ${replacement.reason}`);
    return { ok: false };
  }

  // Guard the host filesystem before an image pull or model-download
  // container can start. The cache path itself is created only after both
  // storage decisions pass, so Docker never creates it as root.
  const hasImage = imageIsCached(runtimeProfile);
  if (!(await managedStorageAccepted(runtimeProfile, model, hasImage, opts))) {
    return { ok: false };
  }

  const cacheDir = ensureHfCacheDir(model);
  if (!cacheDir.ok) {
    console.error(`  vLLM install failed: ${cacheDir.reason}`);
    return { ok: false };
  }

  const pull = await pullImage(runtimeProfile);
  if (!pull.ok) {
    console.error(`  vLLM install failed: ${String(pull.reason)}`);
    return { ok: false };
  }

  // A cold image pull can consume the same host filesystem that backs the
  // Hugging Face cache. Re-probe the model destination after the pull before
  // `hf download` starts.
  if (!hasImage && !(await managedStorageAccepted(runtimeProfile, model, true, opts))) {
    return { ok: false };
  }

  const modelDownload = await downloadModel(runtimeProfile, model);
  if (!modelDownload.ok) {
    console.error(`  vLLM install failed: ${String(modelDownload.reason)}`);
    return { ok: false };
  }

  const start = startContainer(runtimeProfile, model);
  if (!start.ok) {
    console.error(`  vLLM install failed: ${String(start.reason)}`);
    return { ok: false };
  }

  emit("Launching vLLM");
  emit(
    `Launch can take 5 minutes to ${String(Math.ceil(runtimeProfile.loadTimeoutSec / 60))} minutes`,
  );

  const ready = await waitForVllmReady(runtimeProfile);
  if (!ready.ok) {
    printContainerLogTail(runtimeProfile);
    dockerStop(runtimeProfile.containerName, {
      env: buildVllmDockerEnv(),
      ignoreError: true,
      suppressOutput: true,
    });
    console.error(`  vLLM install failed: ${String(ready.reason)}`);
    return { ok: false };
  }

  if (!containerStillRunning(runtimeProfile)) {
    console.error("  vLLM container exited unexpectedly after readiness");
    return { ok: false };
  }

  console.log(`  ✓ vLLM ready on localhost:${String(VLLM_PORT)}`);
  return { ok: true };
}
