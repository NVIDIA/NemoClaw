// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM container actions invoked from onboard.ts. Detection of "should we
// offer vLLM at all" lives in onboard.ts; this module owns picking the
// right profile per platform and running the install.

import {
  dockerCapture,
  dockerPullWithProgressWatchdog,
  dockerSpawn,
} from "../adapters/docker";
import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { VLLM_PORT } from "../core/ports";
import { runCapture, runShell } from "../runner";
import { getGpuIndicesByName } from "./nim";
import {
  VLLM_MODELS,
  assertGatedModelAccess,
  buildVllmServeCommand,
  selectVllmModelFromEnv,
  type VllmModelDef,
} from "./vllm-models";

// Per-platform install recipe. Add new platforms by appending an entry to
// the profile table at the bottom of this file. The menu key in onboard.ts
// stays "install-vllm" regardless of platform.
export interface VllmProfile {
  name: string;            // human label, e.g. "DGX Spark"
  image: string;           // container image
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
}

const VLLM_IMAGES = {
  ngc2603Post1: "nvcr.io/nvidia/vllm:26.03.post1-py3",
  ngc2605Post1: "nvcr.io/nvidia/vllm:26.05.post1-py3",
} as const;

function nemotronNanoModel(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-nano-4b");
  if (!match) throw new Error("vllm-models registry is missing the nemotron-3-nano-4b entry");
  return match;
}

function qwen35bNvfp4Model(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "qwen3.6-35b-a3b-nvfp4");
  if (!match) throw new Error("vllm-models registry is missing the qwen3.6-35b-a3b-nvfp4 entry");
  return match;
}

function deepseekV4FlashModel(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "deepseek-v4-flash");
  if (!match) throw new Error("vllm-models registry is missing the deepseek-v4-flash entry");
  return match;
}

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;
const MODEL_DOWNLOAD_HEARTBEAT_MS = 30_000;
const VLLM_LAUNCH_HEARTBEAT_MS = 30_000;

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
 * Forward a Hugging Face token from the host into the vLLM/hf container so
 * `hf download` and `vllm serve` can pull weights for gated models.
 *
 * Returns the bare `-e KEY` form (no `=value`) so the token never lands in
 * the host process list. Docker reads the actual value from its own
 * environment, which the caller is responsible for populating via
 * `buildHfTokenForwardEnv` when spawning through the runner allowlist.
 * The `hf download` container can live for several minutes during a cold
 * pull and `vllm serve` runs for the lifetime of the sandbox; argv-embedded
 * secrets would be visible via `ps` for that whole window.
 */
export function buildHfTokenDockerArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const entry = pickHfTokenEntry(env);
  return entry ? ["-e", entry.key] : [];
}

/**
 * Companion to `buildHfTokenDockerArgs`: returns the `{ KEY: value }` map
 * that has to be merged into the subprocess env so docker can see the
 * token when `-e KEY` (key-only) tells it to forward by name. The CLI's
 * `runShell` strips non-allowlisted env names by default (see
 * subprocess-env.ts), so callers that go through that path must pass
 * this map via the runner's `env` option.
 */
export function buildHfTokenForwardEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const entry = pickHfTokenEntry(env);
  return entry ? { [entry.key]: entry.value } : {};
}

const SPARK_PROFILE: VllmProfile = {
  name: "DGX Spark",
  image: VLLM_IMAGES.ngc2605Post1,
  defaultModel: qwen35bNvfp4Model(),
  containerName: "nemoclaw-vllm",
  dockerRunFlags: [
    "--gpus",
    "all",
    "--ipc=host",
    "-v",
    `${process.env.HOME}/.cache/huggingface:/root/.cache/huggingface`,
    "-e",
    "HF_HOME=/root/.cache/huggingface",
  ],
  pullTimeoutSec: 12 * 60 * 60,
  loadTimeoutSec: 1800,
};

// DGX Station.
const STATION_PROFILE: VllmProfile = {
  name: "DGX Station",
  image: VLLM_IMAGES.ngc2605Post1,
  defaultModel: deepseekV4FlashModel(),
  containerName: "nemoclaw-vllm",
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  buildDockerRunFlags: () => {
    const indices = getGpuIndicesByName(/GB300/i);
    const gpuFlag =
      indices.length === 0
        ? "all"
        : indices.length === 1
          ? `device=${indices[0]}`
          : `'"device=${indices.join(",")}"'`;
    return [
      "--gpus",
      gpuFlag,
      "--ipc=host",
      "-v",
      `${process.env.HOME}/.cache/huggingface:/root/.cache/huggingface`,
      "-e",
      "HF_HOME=/root/.cache/huggingface",
    ];
  },
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
};

// Generic discrete-GPU Linux. Uses a small nemotron model that fits on
// most GPUs.
const GENERIC_LINUX_PROFILE: VllmProfile = {
  name: "Linux + NVIDIA GPU",
  image: VLLM_IMAGES.ngc2603Post1,
  defaultModel: nemotronNanoModel(),
  containerName: "nemoclaw-vllm",
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
};

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
  emit(`Pulling vLLM image: ${profile.image}`);
  const result = await dockerPullWithProgressWatchdog(profile.image, {
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
        "--entrypoint",
        "hf",
        "-v",
        `${process.env.HOME}/.cache/huggingface:/root/.cache/huggingface`,
        "-e",
        "HF_HOME=/root/.cache/huggingface",
        ...buildHfTokenDockerArgs(),
        profile.image,
        "download",
        model.id,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
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

function startContainer(
  profile: VllmProfile,
  model: VllmModelDef,
): { ok: boolean; reason?: string } {
  emit(`Starting vLLM container (${profile.containerName})`);
  // Idempotent: tear down any prior container by the same name first.
  runShell(`docker rm -f ${profile.containerName}`, {
    ignoreError: true,
    suppressOutput: true,
  });
  const resolvedFlags = profile.buildDockerRunFlags
    ? profile.buildDockerRunFlags()
    : profile.dockerRunFlags;
  // Forward HF_TOKEN/HUGGING_FACE_HUB_TOKEN so the long-lived `vllm serve`
  // pull can authenticate against gated repos when the model weights are
  // not already in the mounted cache. The runner allowlist strips the
  // token from the docker subprocess env by default, so we have to put it
  // back via the `env:` option; the docker argv only carries `-e KEY` so
  // the value stays out of /proc/<pid>/cmdline.
  const hfTokenFlags = buildHfTokenDockerArgs().join(" ");
  const flags = [resolvedFlags.join(" "), hfTokenFlags].filter(Boolean).join(" ");
  const cmd =
    `docker run -d ${flags} -p ${String(VLLM_PORT)}:8000 ` +
    `--name ${profile.containerName} --entrypoint /bin/bash ${profile.image} -lc ${JSON.stringify(buildVllmServeCommand(model))}`;
  const result = runShell(cmd, {
    ignoreError: true,
    suppressOutput: true,
    env: buildHfTokenForwardEnv(),
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
    { ignoreError: true },
  ).trim();
  return out === profile.containerName;
}

interface InstallVllmOptions {
  hasImage: boolean;
  nonInteractive: boolean;
  promptFn: (q: string) => Promise<string>;
}

// Public entry point. Returns ok=false on any prereq, pull, run, or load
// failure, plus when the user declines the confirmation prompt.
export async function installVllm(
  profile: VllmProfile,
  opts: InstallVllmOptions,
): Promise<{ ok: boolean }> {
  // Resolve the model to serve: `NEMOCLAW_VLLM_MODEL` override if set, else
  // the per-platform profile default. The generic-Linux profile defaults to
  // Nemotron-Nano-4B for VRAM headroom; Station to DeepSeek V4 Flash; Spark
  // to the Qwen3.6-35B-A3B NVFP4 checkpoint.
  // Validate gated-model access (HF_TOKEN required for models like
  // DeepSeek-R1 Distill 70B) before touching docker so the user does not
  // burn a multi-minute pull on a 401.
  let model: VllmModelDef;
  try {
    model = selectVllmModelFromEnv() ?? profile.defaultModel;
    assertGatedModelAccess(model);
  } catch (err) {
    console.error(`  vLLM install failed: ${(err as Error).message}`);
    return { ok: false };
  }

  console.log("");
  console.log(`  vLLM (${profile.name}):`);
  console.log(`    Image: ${profile.image}`);
  console.log(`    Model: ${model.id}${model.id === profile.defaultModel.id ? "" : " (NEMOCLAW_VLLM_MODEL override)"}`);
  if (!opts.hasImage) console.log("    Image download on first run, cached after");
  console.log("    Model download on first run, cached after");
  console.log("");

  const proceed = opts.nonInteractive
    ? true
    : (await opts.promptFn("  Continue? [y/N]: ")).trim().toLowerCase().startsWith("y");
  if (!proceed) return { ok: false };

  console.log("");
  console.log("  Installing vLLM. Progress will print below.");

  const prereqs = dockerPrereqsOk();
  if (!prereqs.ok) {
    console.error(`  vLLM install failed: ${String(prereqs.reason)}`);
    return { ok: false };
  }

  const pull = await pullImage(profile);
  if (!pull.ok) {
    console.error(`  vLLM install failed: ${String(pull.reason)}`);
    return { ok: false };
  }

  const modelDownload = await downloadModel(profile, model);
  if (!modelDownload.ok) {
    console.error(`  vLLM install failed: ${String(modelDownload.reason)}`);
    return { ok: false };
  }

  const start = startContainer(profile, model);
  if (!start.ok) {
    console.error(`  vLLM install failed: ${String(start.reason)}`);
    return { ok: false };
  }

  emit("Launching vLLM");
  emit(`Launch can take 5 minutes to ${String(Math.ceil(profile.loadTimeoutSec / 60))} minutes`);

  const ready = await waitForVllmReady(profile);
  if (!ready.ok) {
    printContainerLogTail(profile);
    runShell(`docker stop ${profile.containerName}`, {
      ignoreError: true,
      suppressOutput: true,
    });
    console.error(`  vLLM install failed: ${String(ready.reason)}`);
    return { ok: false };
  }

  if (!containerStillRunning(profile)) {
    console.error("  vLLM container exited unexpectedly after readiness");
    return { ok: false };
  }

  console.log(`  ✓ vLLM ready on localhost:${String(VLLM_PORT)}`);
  return { ok: true };
}
