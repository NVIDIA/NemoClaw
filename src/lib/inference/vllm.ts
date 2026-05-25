// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM container actions invoked from onboard.ts. Detection of "should we
// offer vLLM at all" lives in onboard.ts; this module owns picking the
// right profile per platform and running the install.

const { runCapture, runShell } = require("../runner");
const { dockerCapture, dockerSpawn } = require("../adapters/docker");
const { VLLM_PORT } = require("../core/ports");
const { getGpuIndicesByName } = require("./nim");
import {
  DEFAULT_VLLM_MODEL,
  VLLM_MODELS,
  assertGatedModelAccess,
  buildVllmServeCommand,
  selectVllmModelFromEnv,
  type VllmModelDef,
} from "./vllm-models";

// Per-platform install recipe. Add new platforms by appending an entry to
// the profile table at the bottom of this file. The menu key in onboard.ts
// stays "install-vllm" regardless of platform.
interface VllmProfile {
  name: string;            // human label, e.g. "DGX Spark"
  image: string;           // container image
  // Default model when NEMOCLAW_VLLM_MODEL is unset. Per-platform default
  // because Spark/Station can host a 27B model, but generic discrete-GPU
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
  // Approximate first-run time shown in the confirmation prompt.
  estimatedMinutes: string;
  // Image-pull deadline. First run on a slow link can be several minutes.
  pullTimeoutSec: number;
  // Marker emitter sees container output line by line. The patterns below
  // map a line to a user-visible "==> ..." progress marker. Order matters:
  // first matching entry wins.
  progressMarkers: { match: RegExp; emit: string }[];
  // Fatal patterns abort the install with the matching message.
  fatalMarkers: { match: RegExp; reason: string }[];
  // Pattern that means "vLLM is up and serving".
  readyMarker: RegExp;
  // Wall-clock budget for the load phase (after pull, before ready).
  loadTimeoutSec: number;
}

function nemotronNanoModel(): VllmModelDef {
  const match = VLLM_MODELS.find((m) => m.envValue === "nemotron-3-nano-4b");
  if (!match) throw new Error("vllm-models registry is missing the nemotron-3-nano-4b entry");
  return match;
}

const HF_TOKEN_ENV_KEYS = ["HF_TOKEN", "HUGGING_FACE_HUB_TOKEN"] as const;

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
  image: "nvcr.io/nvidia/vllm:26.03.post1-py3",
  defaultModel: DEFAULT_VLLM_MODEL,
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
  estimatedMinutes: "10–30 minutes",
  pullTimeoutSec: 900,
  loadTimeoutSec: 1800,
  progressMarkers: [
    {
      match: /Successfully installed vllm|already satisfied: vllm/,
      emit: "fastsafetensors extra ready",
    },
    {
      match: /Loading model weights from|Loading safetensors checkpoint/,
      emit: "Loading model weights into VRAM",
    },
    { match: /Loading model weights took|Model loading took/, emit: "Model weights loaded" },
  ],
  fatalMarkers: [
    { match: /CUDA out of memory|torch\.OutOfMemoryError/, reason: "CUDA out of memory" },
    { match: /ImportError|ModuleNotFoundError/, reason: "Python import error" },
    { match: /OSError: \[Errno 28\]|No space left on device/, reason: "out of disk space" },
  ],
  readyMarker: /Uvicorn running on|Application startup complete/,
};

// DGX Station.
const STATION_PROFILE: VllmProfile = {
  name: "DGX Station",
  image: SPARK_PROFILE.image,
  defaultModel: SPARK_PROFILE.defaultModel,
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
  estimatedMinutes: SPARK_PROFILE.estimatedMinutes,
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
  progressMarkers: SPARK_PROFILE.progressMarkers,
  fatalMarkers: SPARK_PROFILE.fatalMarkers,
  readyMarker: SPARK_PROFILE.readyMarker,
};

// Generic discrete-GPU Linux. Uses a small nemotron model that fits on
// most GPUs.
const GENERIC_LINUX_PROFILE: VllmProfile = {
  name: "Linux + NVIDIA GPU",
  image: SPARK_PROFILE.image,
  defaultModel: nemotronNanoModel(),
  containerName: "nemoclaw-vllm",
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  estimatedMinutes: SPARK_PROFILE.estimatedMinutes,
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
  progressMarkers: SPARK_PROFILE.progressMarkers,
  fatalMarkers: SPARK_PROFILE.fatalMarkers,
  readyMarker: SPARK_PROFILE.readyMarker,
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

function dockerPrereqsOk(): { ok: boolean; reason?: string } {
  if (!runCapture(["sh", "-c", "command -v docker"], { ignoreError: true }).trim()) {
    return { ok: false, reason: "docker not found on PATH" };
  }
  if (!runCapture(["sh", "-c", "command -v nvidia-smi"], { ignoreError: true }).trim()) {
    return { ok: false, reason: "nvidia-smi not found — vLLM requires NVIDIA drivers" };
  }
  return { ok: true };
}

function pullImage(profile: VllmProfile): { ok: boolean; reason?: string } {
  emit(`Pulling vLLM image: ${profile.image}`);
  // GNU `timeout` enforces the pull deadline. macOS BSD coreutils omits it;
  // fall back to a plain `docker pull` there.
  const hasTimeout = !!runCapture(["sh", "-c", "command -v timeout"], {
    ignoreError: true,
  }).trim();
  const prefix = hasTimeout ? `timeout ${String(profile.pullTimeoutSec)} ` : "";
  const result = runShell(`${prefix}docker pull ${profile.image}`, {
    ignoreError: true,
    suppressOutput: true,
  });
  if (result.status !== 0) {
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
        "--rm",
        "-v",
        `${process.env.HOME}/.cache/huggingface:/root/.cache/huggingface`,
        "-e",
        "HF_HOME=/root/.cache/huggingface",
        ...buildHfTokenDockerArgs(),
        profile.image,
        "hf",
        "download",
        model.id,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    const tail: string[] = [];
    const TAIL_MAX = 50;
    let totalFiles = 0;
    let lastEmittedPct = -1;

    function onChunk(buf: Buffer): void {
      const text = buf.toString();
      // tqdm uses \r to overwrite a line; split on either to catch updates.
      for (const segment of text.split(/[\r\n]+/)) {
        if (!segment) continue;
        tail.push(segment);
        if (tail.length > TAIL_MAX) tail.shift();
      }
      const fetchMatch = text.match(/Fetching (\d+) files:/);
      if (fetchMatch && totalFiles !== Number(fetchMatch[1])) {
        totalFiles = Number(fetchMatch[1]);
        emit(`Downloading ${String(totalFiles)} files`);
      }
      // Pull every percent update tqdm emits and only print when a new
      // 25% milestone is crossed (25/50/75).
      for (const m of text.matchAll(/(\d+)%\|/g)) {
        const pct = Number(m[1]);
        const milestone = Math.floor(pct / 25) * 25;
        if (milestone > 0 && milestone < 100 && milestone > lastEmittedPct) {
          lastEmittedPct = milestone;
          emit(`Download progress: ${String(milestone)}%`);
        }
      }
    }

    proc.stdout.on("data", onChunk);
    proc.stderr.on("data", onChunk);

    proc.on("error", (err: Error) => {
      resolve({ ok: false, reason: `spawn error: ${err.message}` });
    });

    proc.on("exit", (code: number | null) => {
      if (code === 0) {
        emit("Model download complete");
        resolve({ ok: true });
        return;
      }
      // Surface the last few raw lines so a failure has actionable context.
      if (tail.length > 0) {
        process.stderr.write(`  --- Last ${String(tail.length)} hf output lines: ---\n`);
        for (const line of tail) process.stderr.write(`    ${line}\n`);
        process.stderr.write("  ---\n");
      }
      resolve({ ok: false, reason: `hf download failed (exit ${String(code)})` });
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
    `--name ${profile.containerName} ${profile.image} bash -c ${JSON.stringify(buildVllmServeCommand(model))}`;
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

// Stream `docker logs -f` and classify each line. Resolves on ready, fatal,
// timeout, or container exit.
function streamLogsUntilReady(
  profile: VllmProfile,
): Promise<{ ok: boolean; reason?: string }> {
  return new Promise((resolve) => {
    const proc = dockerSpawn(["logs", "-f", profile.containerName], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let resolved = false;
    const start = Date.now();

    let tick: ReturnType<typeof setInterval> | null = null;

    function done(result: { ok: boolean; reason?: string }): void {
      if (resolved) return;
      resolved = true;
      if (tick) {
        clearInterval(tick);
        tick = null;
      }
      try {
        proc.kill();
      } catch {
        /* ignored */
      }
      resolve(result);
    }

    function processLine(line: string): void {
      if (!line || resolved) return;
      for (const fatal of profile.fatalMarkers) {
        if (fatal.match.test(line)) {
          emit(`ERROR: ${fatal.reason}`);
          done({ ok: false, reason: fatal.reason });
          return;
        }
      }
      for (const m of profile.progressMarkers) {
        if (m.match.test(line)) {
          emit(m.emit);
          break;
        }
      }
      if (profile.readyMarker.test(line)) {
        emit(`vLLM is serving on :${String(VLLM_PORT)}`);
        done({ ok: true });
      }
    }

    function consumeChunk(buffer: string, raw: Buffer): string {
      const segments = (buffer + raw.toString()).split(/\r?\n/);
      const nextBuffer = segments.pop() ?? "";
      for (const line of segments) processLine(line);
      return nextBuffer;
    }

    let stdoutBuffer = "";
    let stderrBuffer = "";
    proc.stdout.on("data", (raw: Buffer) => {
      stdoutBuffer = consumeChunk(stdoutBuffer, raw);
    });
    proc.stderr.on("data", (raw: Buffer) => {
      stderrBuffer = consumeChunk(stderrBuffer, raw);
    });

    tick = setInterval(() => {
      if ((Date.now() - start) / 1000 > profile.loadTimeoutSec) {
        done({
          ok: false,
          reason: `model load exceeded ${String(profile.loadTimeoutSec)}s`,
        });
      }
    }, 5000);

    proc.on("error", (err: Error) => {
      done({ ok: false, reason: `docker logs spawn error: ${err.message}` });
    });

    proc.on("close", (code: number | null) => {
      if (resolved) return;
      processLine(stdoutBuffer);
      processLine(stderrBuffer);
      if (resolved) return;
      done({ ok: false, reason: `docker logs exited with code ${String(code)}` });
    });
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
  // Nemotron-Nano-4B for VRAM headroom; Spark/Station to Qwen3.6-27B.
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
  console.log(
    `  Installing vLLM. This can take ${profile.estimatedMinutes}; progress markers (==>) will print below.`,
  );

  const prereqs = dockerPrereqsOk();
  if (!prereqs.ok) {
    console.error(`  vLLM install failed: ${String(prereqs.reason)}`);
    return { ok: false };
  }

  const pull = pullImage(profile);
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

  emit("Waiting for vLLM to install dependencies and load model");
  emit("    First-run downloads model weights; subsequent runs reuse the cache");

  const ready = await streamLogsUntilReady(profile);
  if (!ready.ok) {
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
