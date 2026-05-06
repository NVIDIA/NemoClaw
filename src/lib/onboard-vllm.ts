// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// vLLM container actions invoked from onboard.ts. Detection of "should we
// offer vLLM at all" lives in onboard.ts; this module owns picking the
// right profile per platform and running the install.

const { runCapture, runShell } = require("./runner");
const { dockerCapture, dockerSpawn } = require("./adapters/docker");
const { VLLM_PORT } = require("./ports");
const { getGpuIndicesByName } = require("./nim");

// Per-platform install recipe. Add new platforms by appending an entry to
// the profile table at the bottom of this file. The menu key in onboard.ts
// stays "install-vllm" regardless of platform.
interface VllmProfile {
  name: string;            // human label, e.g. "DGX Spark"
  image: string;           // container image
  model: string;           // model id pulled at first run
  containerName: string;
  // docker run flags excluding the image and the entrypoint command. The
  // caller appends -p / --name / etc. that are not platform-specific.
  dockerRunFlags: string[];
  // Optional dynamic flag builder. When present, its return value replaces
  // dockerRunFlags at install time. Used by Station to pick the GB300 GPU
  // out of a mixed-GPU host instead of using `--gpus all`.
  buildDockerRunFlags?: () => string[];
  // bash -c command passed to docker run (pip install + vllm serve …)
  command: string;
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

const SPARK_PROFILE: VllmProfile = {
  name: "DGX Spark",
  image: "nvcr.io/nvidia/vllm:26.03.post1-py3",
  model: "Qwen/Qwen3.6-27B-FP8",
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
  command:
    "pip install vllm[fastsafetensors] && vllm serve Qwen/Qwen3.6-27B-FP8 " +
    "--gpu-memory-utilization 0.7 " +
    "--tensor-parallel-size 1 " +
    "--pipeline-parallel-size 1 " +
    "--data-parallel-size 1 " +
    "--max-model-len 262144 " +
    "--port 8000 " +
    "--max-num-seqs 4 " +
    "--trust-remote-code " +
    "--reasoning-parser qwen3 " +
    "--enable-auto-tool-choice " +
    "--tool-call-parser qwen3_coder " +
    "--load-format fastsafetensors " +
    "--enable-prefix-caching",
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
  model: SPARK_PROFILE.model,
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
  command: SPARK_PROFILE.command,
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
  model: "nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8",
  containerName: "nemoclaw-vllm",
  dockerRunFlags: SPARK_PROFILE.dockerRunFlags,
  command:
    "pip install vllm[fastsafetensors] && " +
    "vllm serve nvidia/NVIDIA-Nemotron-3-Nano-4B-FP8 " +
    "--gpu-memory-utilization 0.7 " +
    "--tensor-parallel-size 1 " +
    "--pipeline-parallel-size 1 " +
    "--data-parallel-size 1 " +
    "--max-model-len 262000 " +
    "--port 8000 --trust-remote-code --load-format fastsafetensors",
  estimatedMinutes: SPARK_PROFILE.estimatedMinutes,
  pullTimeoutSec: SPARK_PROFILE.pullTimeoutSec,
  loadTimeoutSec: SPARK_PROFILE.loadTimeoutSec,
  progressMarkers: SPARK_PROFILE.progressMarkers,
  fatalMarkers: SPARK_PROFILE.fatalMarkers,
  readyMarker: SPARK_PROFILE.readyMarker,
};

export const PROFILES: VllmProfile[] = [SPARK_PROFILE, STATION_PROFILE, GENERIC_LINUX_PROFILE];

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
function downloadModel(profile: VllmProfile): Promise<{ ok: boolean; reason?: string }> {
  emit(`Pre-downloading model with hf: ${profile.model}`);
  return new Promise((resolve) => {
    const proc = dockerSpawn(
      [
        "run",
        "--rm",
        "-v",
        `${process.env.HOME}/.cache/huggingface:/root/.cache/huggingface`,
        "-e",
        "HF_HOME=/root/.cache/huggingface",
        profile.image,
        "hf",
        "download",
        profile.model,
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

function startContainer(profile: VllmProfile): { ok: boolean; reason?: string } {
  emit(`Starting vLLM container (${profile.containerName})`);
  // Idempotent: tear down any prior container by the same name first.
  runShell(`docker rm -f ${profile.containerName}`, {
    ignoreError: true,
    suppressOutput: true,
  });
  const resolvedFlags = profile.buildDockerRunFlags
    ? profile.buildDockerRunFlags()
    : profile.dockerRunFlags;
  const flags = resolvedFlags.join(" ");
  const cmd =
    `docker run -d ${flags} -p ${String(VLLM_PORT)}:8000 ` +
    `--name ${profile.containerName} ${profile.image} bash -c ${JSON.stringify(profile.command)}`;
  const result = runShell(cmd, { ignoreError: true, suppressOutput: true });
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
  console.log("");
  console.log(`  vLLM (${profile.name}):`);
  console.log(`    Image: ${profile.image}`);
  console.log(`    Model: ${profile.model}`);
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

  const modelDownload = await downloadModel(profile);
  if (!modelDownload.ok) {
    console.error(`  vLLM install failed: ${String(modelDownload.reason)}`);
    return { ok: false };
  }

  const start = startContainer(profile);
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
