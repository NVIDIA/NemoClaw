// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM container actions invoked from onboard.ts. Detection of "should we
// offer vLLM at all" lives in onboard.ts; this module owns picking the
// right profile per platform and running the install.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
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
import { VLLM_PORT } from "../core/ports";
import { shellQuote } from "../core/shell-quote";
import { isAffirmativeAnswer } from "../onboard/prompt-helpers";
import { runCapture } from "../runner";
import { redactFull } from "../security/redact";
import { isSafeModelId } from "../validation";
import { getGpuIndicesByName } from "./nim";
import { ensureDualStationVllmApiKey, loadDualStationVllmApiKey } from "./vllm-api-key";
import {
  buildLocalDualStationDockerEnv,
  buildRemoteVllmDockerEnv,
  buildVllmDockerEnv,
} from "./vllm-docker-env";
import {
  buildVllmServeCommand,
  NEMOTRON_ULTRA_DUAL_STATION_IMAGE,
  NEMOTRON_ULTRA_STATION_IMAGE,
  parseVllmExtraServeArgs,
  VLLM_EXTRA_ARGS_ENV,
  VLLM_MODELS,
  type VllmModelDef,
  type VllmPlatform,
} from "./vllm-models";
import { resolveVllmInstallModel } from "./vllm-prompt";
import {
  type DualStationVllmPlan,
  NEMOCLAW_DGX_STATION_PEER_ENV,
  probeDualStationVllmCapability,
} from "./vllm-station-cluster";
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
const HF_TOKEN_SETTINGS_URL = "https://huggingface.co/settings/tokens";
const HF_RATE_LIMIT_PATTERN = /\b429\b|too many requests|rate[\s_-]*limit/i;
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

export type HfDownloadAuthentication =
  | { authenticated: false }
  | { authenticated: true; source: (typeof HF_TOKEN_ENV_KEYS)[number] };

/** Return only the presence and source of Hugging Face authentication, never its value. */
export function hfDownloadAuthentication(
  env: NodeJS.ProcessEnv = process.env,
): HfDownloadAuthentication {
  const entry = pickHfTokenEntry(env);
  return entry ? { authenticated: true, source: entry.key } : { authenticated: false };
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

function redactHfDownloadOutput(text: string, tokenValue: string | null): string {
  const withoutKnownToken = tokenValue ? text.split(tokenValue).join("<REDACTED>") : text;
  return redactFull(withoutKnownToken);
}

function redactHfDownloadOutputChunks(
  chunks: readonly { text: string; stream: NodeJS.WriteStream }[],
  tokenValue: string | null,
): string[] {
  const joined = chunks.map((chunk) => chunk.text).join("");
  const tokenSpans: { start: number; end: number }[] = [];
  if (tokenValue) {
    let searchFrom = 0;
    while (searchFrom < joined.length) {
      const start = joined.indexOf(tokenValue, searchFrom);
      if (start < 0) break;
      tokenSpans.push({ start, end: start + tokenValue.length });
      searchFrom = start + tokenValue.length;
    }
  }

  let chunkStart = 0;
  return chunks.map((chunk) => {
    const chunkEnd = chunkStart + chunk.text.length;
    let cursor = chunkStart;
    let safeText = "";
    for (const span of tokenSpans) {
      if (span.end <= chunkStart || span.start >= chunkEnd) continue;
      safeText += joined.slice(cursor, Math.max(cursor, span.start));
      if (span.start >= chunkStart) safeText += "<REDACTED>";
      cursor = Math.max(cursor, Math.min(chunkEnd, span.end));
    }
    safeText += joined.slice(cursor, chunkEnd);
    chunkStart = chunkEnd;
    return redactHfDownloadOutput(safeText, null);
  });
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

// Run `hf download <model>` inside a one-shot container of the same image.
function downloadModel(
  profile: VllmProfile,
  model: VllmModelDef,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): Promise<{ ok: boolean; reason?: string }> {
  emit(`Pre-downloading model with hf: ${model.id}`);
  return new Promise((resolve) => {
    const tokenValue = pickHfTokenEntry()?.value ?? null;
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
        env: { ...dockerEnv, ...buildHfTokenForwardEnv() },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    const tail: string[] = [];
    const outputDecoders = [
      { decoder: new StringDecoder("utf8"), stream: process.stdout },
      { decoder: new StringDecoder("utf8"), stream: process.stderr },
    ];
    let pendingOutput: { text: string; stream: NodeJS.WriteStream }[] = [];
    const TAIL_MAX = 50;
    let resolved = false;
    let decodersFinalized = false;
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

    function takePendingOutput(end: number): { text: string; stream: NodeJS.WriteStream }[] {
      const selected: { text: string; stream: NodeJS.WriteStream }[] = [];
      let remaining = end;
      while (remaining > 0 && pendingOutput.length > 0) {
        const chunk = pendingOutput[0];
        if (chunk.text.length <= remaining) {
          selected.push(chunk);
          pendingOutput.shift();
          remaining -= chunk.text.length;
          continue;
        }
        selected.push({ text: chunk.text.slice(0, remaining), stream: chunk.stream });
        pendingOutput[0] = { text: chunk.text.slice(remaining), stream: chunk.stream };
        remaining = 0;
      }
      return selected;
    }

    function flushOutput(flushAll = false): void {
      const pendingText = pendingOutput.map((chunk) => chunk.text).join("");
      const end = flushAll
        ? pendingText.length
        : Math.max(pendingText.lastIndexOf("\n"), pendingText.lastIndexOf("\r")) + 1;
      if (end <= 0) return;
      const selected = takePendingOutput(end);
      const safeChunks = redactHfDownloadOutputChunks(selected, tokenValue);
      for (const [index, safeText] of safeChunks.entries()) {
        if (!safeText) continue;
        selected[index].stream.write(safeText);
        lastOutputEndedCleanly = /[\r\n]$/.test(safeText);
        rememberTail(safeText);
      }
    }

    function finalizeOutputDecoders(): void {
      if (decodersFinalized) return;
      decodersFinalized = true;
      for (const state of outputDecoders) {
        const text = state.decoder.end();
        if (text) pendingOutput.push({ text, stream: state.stream });
      }
      flushOutput(true);
    }

    function onChunk(buf: Buffer, state: (typeof outputDecoders)[number]): void {
      lastOutputAt = Date.now();
      const text = state.decoder.write(buf);
      if (text) pendingOutput.push({ text, stream: state.stream });
      flushOutput();
    }

    proc.stdout?.on("data", (buf: Buffer) => onChunk(buf, outputDecoders[0]));
    proc.stderr?.on("data", (buf: Buffer) => onChunk(buf, outputDecoders[1]));

    proc.on("error", (err: Error) => {
      finalizeOutputDecoders();
      done({ ok: false, reason: `spawn error: ${err.message}` });
    });

    proc.on("exit", (code: number | null) => {
      finalizeOutputDecoders();
      if (code === 0) {
        if (!lastOutputEndedCleanly) process.stdout.write("\n");
        emit("Model download complete");
        done({ ok: true });
        return;
      }
      // Surface the last few sanitized lines so a failure has actionable context.
      if (tail.length > 0) {
        process.stderr.write(`  --- Last ${String(tail.length)} hf output lines: ---\n`);
        for (const line of tail) process.stderr.write(`    ${line}\n`);
        process.stderr.write("  ---\n");
      }
      if (HF_RATE_LIMIT_PATTERN.test(tail.join("\n"))) printHfRateLimitRecovery();
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
): string[] {
  assertVllmRegistryDigestRef(profile.image);
  const image = validateDockerArg(profile.image, "vLLM image");
  const containerName = validateDockerArg(profile.containerName, "vLLM container name");
  const safeRunFlags = validateDockerArgs(runFlags, "vLLM docker run flags");
  return [
    "--pull=never",
    "--init",
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
  if (ownership.kind === "dual-managed") {
    return {
      ok: false,
      reason:
        `Container "${containerName}" is the head of a managed dual-Station deployment. ` +
        `Refusing single-host replacement because it would orphan the peer worker. Restore ${NEMOCLAW_DGX_STATION_PEER_ENV} and select Nemotron Ultra to manage the pair.`,
    };
  }
  return ownership.kind === "managed"
    ? { ok: true, containerId: ownership.containerId }
    : { ok: true };
}

export function isNemoClawManagedVllmRunning(): boolean {
  const ownership = inspectVllmContainerOwnership(NEMOCLAW_VLLM_CONTAINER_NAME);
  return (ownership.kind === "managed" || ownership.kind === "dual-managed") && ownership.running;
}

export type PersistConfiguredDualStationVllmRuntimeResult =
  | { ok: true; persisted: boolean }
  | { ok: false; reason: string };

/**
 * Adopt an already-running installer-qualified pair into durable uninstall
 * ownership after onboarding has authenticated and validated its endpoint.
 */
export async function persistConfiguredDualStationVllmRuntimeReceipt(): Promise<PersistConfiguredDualStationVllmRuntimeResult> {
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
): { ok: boolean; reason?: string } {
  emit(`Starting vLLM container (${profile.containerName})`);
  // The explicit download completed before this long-lived container starts,
  // so do not retain the host Hugging Face token in the serving process.
  let runArgs: string[];
  try {
    const resolvedFlags = profile.buildDockerRunFlags
      ? profile.buildDockerRunFlags()
      : profile.dockerRunFlags;
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

function readContainerLogTail(
  profile: VllmProfile,
  lineCount = 80,
  dockerEnv: Record<string, string> = buildVllmDockerEnv(),
): string[] {
  const output = dockerCapture(["logs", "--tail", String(lineCount), profile.containerName], {
    env: dockerEnv,
    ignoreError: true,
  }).trim();
  if (!output) return [];
  return output.split(/\r?\n/).slice(-lineCount);
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
      if (now - lastHeartbeatAt >= VLLM_LAUNCH_HEARTBEAT_MS) {
        lastHeartbeatAt = now;
        emit(`Still waiting for vLLM (${formatElapsed(now - start)} elapsed; API not ready)`);
      }
    }

    tick = setInterval(poll, 5000);
    poll();
  });
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

function imageIsCached(
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
): Promise<{ ok: boolean }> {
  let dualStationPlan: DualStationVllmPlan | null = null;
  let peerModelSnapshot: "ready" | "staging-required" | null = null;
  const explicitModel = String(process.env.NEMOCLAW_VLLM_MODEL ?? "").trim();
  const configuredPeer = String(process.env[NEMOCLAW_DGX_STATION_PEER_ENV] ?? "").trim();
  const ultra =
    profile.platform === "station" && configuredPeer
      ? VLLM_MODELS.find((candidate) => candidate.envValue === "nemotron-3-ultra-550b-a55b")
      : undefined;

  if (profile.platform === "station" && configuredPeer) {
    if (!ultra) {
      console.error("  vLLM install failed: Nemotron Ultra is missing from the model registry");
      return { ok: false };
    }
    const normalizedExplicitModel = explicitModel.toLowerCase();
    if (
      normalizedExplicitModel &&
      normalizedExplicitModel !== ultra.envValue.toLowerCase() &&
      normalizedExplicitModel !== ultra.id.toLowerCase()
    ) {
      console.error(
        `  vLLM install failed: ${NEMOCLAW_DGX_STATION_PEER_ENV} requires the DGX Station dual-serving model. ` +
          "Unset NEMOCLAW_VLLM_MODEL or select nemotron-3-ultra-550b-a55b; the explicit model override remains authoritative.",
      );
      return { ok: false };
    }
  }
  // Model selection lives in `resolveVllmInstallModel` so this entry point
  // stays focused on the docker side effects. Gated-model access is checked
  // there before any docker work happens.
  let resolved: Awaited<ReturnType<typeof resolveVllmInstallModel>>;
  if (profile.platform === "station" && configuredPeer && !explicitModel && ultra) {
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
      { ...profile, defaultModel: ultra },
      {
        // A qualified explicit peer is the model-selection signal. The normal
        // resolver still owns access validation, but no second model choice is
        // presented after hardware qualification.
        nonInteractive: true,
        promptFn: opts.promptFn,
      },
    );
    if (!resolved) return { ok: false };
    dualStationPlan = capability.plan;
    peerModelSnapshot = capability.peerModelSnapshot;
  } else {
    resolved = await resolveVllmInstallModel(profile, {
      nonInteractive: opts.nonInteractive,
      promptFn: opts.promptFn,
    });
  }
  if (!resolved) return { ok: false };
  const { model, source: modelSource } = resolved;
  // Platform-restricted models are filtered out of the interactive picker,
  // but a direct NEMOCLAW_VLLM_MODEL override bypasses that filter, so this
  // gate is the only platform enforcement on the env-override path. It must
  // reject every wrong-platform model, not just runtime-carrying ones — an
  // NVFP4 Spark checkpoint or a 352 GB Station recipe cannot serve here and
  // must fail before the image pull and download (#7358).
  if (!model.platforms.includes(profile.platform)) {
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

  if (profile.platform === "station" && model.envValue === "nemotron-3-ultra-550b-a55b") {
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
        imageDownloadSizeBytes: NEMOTRON_ULTRA_DUAL_STATION_IMAGE.arm64.downloadSizeBytes,
        imageUnpackedSizeBytes: undefined,
        loadTimeoutSec: 7200,
      };
      if (VLLM_PORT !== 8000) {
        console.error(
          "  Dual DGX Station setup requires the default vLLM port 8000; unset NEMOCLAW_VLLM_PORT and retry.",
        );
        return { ok: false };
      }
      if (extraServeArgs.length > 0) {
        console.error(
          `  Dual DGX Station setup does not accept ${VLLM_EXTRA_ARGS_ENV}; the verified distributed launch is fixed.`,
        );
        return { ok: false };
      }
    }
  }
  const localDockerEnv = dualStationPlan ? buildLocalDualStationDockerEnv() : buildVllmDockerEnv();
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

  console.log("");
  console.log("  Installing vLLM. Progress will print below.");

  const prereqs = dockerPrereqsOk();
  if (!prereqs.ok) {
    console.error(`  vLLM install failed: ${String(prereqs.reason)}`);
    return { ok: false };
  }

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
    const replacement = vllmContainerReplacementTarget(runtimeProfile.containerName);
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
  if (!hasImage && !(await managedStorageAccepted(runtimeProfile, model, true, opts))) {
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
        if (!isDeepStrictEqual(refreshedCapability.plan, stagingPlan)) {
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

  let dualStationApiKey: string | null = null;
  if (dualStationPlan) {
    try {
      const existingManagedBaseUrl = getDualStationManagedVllmBaseUrl();
      const existingApiKey = existingManagedBaseUrl ? loadDualStationVllmApiKey() : null;
      // If the key file alone was lost, create a new host-global key. The
      // lifecycle fingerprint then forces a coordinated pair replacement
      // under its lock instead of reusing containers bound to an unknown key.
      dualStationApiKey = existingApiKey ?? ensureDualStationVllmApiKey();
    } catch (err) {
      console.error(`  vLLM install failed: ${(err as Error).message}`);
      return { ok: false };
    }
  }

  if (dualStationPlan) {
    if (!dualStationApiKey) {
      console.error("  vLLM install failed: dual-Station API key was not provisioned");
      return { ok: false };
    }
    try {
      return await withDualStationManagedVllmLifecycle(async () => {
        const start = await startDualStationManagedVllm(dualStationPlan, {
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
              dualStationPlan,
              start.legacyMigration,
            );
            if (!rollback.ok) {
              for (const rollbackError of rollback.rollbackErrors) {
                console.error(`  vLLM rollback warning: ${rollbackError}`);
              }
            }
            return;
          }
          const cleanup = await cleanupDualStationManagedVllm(dualStationPlan);
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

        if (!areDualStationManagedVllmContainersRunning(dualStationPlan)) {
          await rollbackStartedPair();
          console.error("  vLLM distributed containers exited unexpectedly after readiness");
          return { ok: false };
        }

        let legacyMigrationCommitted = false;
        if (start.legacyMigration) {
          const commit = await commitDualStationLegacyMigration(
            dualStationPlan,
            start.legacyMigration,
          );
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
          persistDualStationVllmRuntimeReceipt(dualStationPlan);
        } catch (error) {
          if (legacyMigrationCommitted) {
            const cleanup = await cleanupDualStationManagedVllm(dualStationPlan);
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

  const start = startContainer(runtimeProfile, model);
  if (!start.ok) {
    console.error(`  vLLM install failed: ${String(start.reason)}`);
    return { ok: false };
  }

  emit("Launching vLLM");
  emit(
    `Launch can take 5 minutes to ${String(Math.ceil(runtimeProfile.loadTimeoutSec / 60))} minutes`,
  );

  const ready = await waitForVllmReady(runtimeProfile, undefined, localDockerEnv);
  if (!ready.ok) {
    printContainerLogTail(runtimeProfile, localDockerEnv);
    dockerStop(runtimeProfile.containerName, {
      env: buildVllmDockerEnv(),
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

  console.log(`  ✓ vLLM ready on localhost:${String(VLLM_PORT)}`);
  return { ok: true };
}
