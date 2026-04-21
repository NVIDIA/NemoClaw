// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { run, runCapture } = require("./runner");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nimImages = require("../../bin/lib/nim-images.json");

import { VLLM_PORT } from "./ports";

const UNIFIED_MEMORY_GPU_TAGS = ["GB10", "Thor", "Orin", "Xavier"];

export interface NimModel {
  name: string;
  image: string;
  minGpuMemoryMB: number;
}

export interface GpuDetection {
  type: string;
  name?: string;
  count: number;
  totalMemoryMB: number;
  perGpuMB: number;
  cores?: number | null;
  nimCapable: boolean;
  unifiedMemory?: boolean;
  spark?: boolean;
}

export interface NimStatus {
  running: boolean;
  healthy?: boolean;
  container: string;
  state?: string;
}

export function containerName(sandboxName: string): string {
  return `nemoclaw-nim-${sandboxName}`;
}

export function getImageForModel(modelName: string): string | null {
  const entry = nimImages.models.find((m: NimModel) => m.name === modelName);
  return entry ? entry.image : null;
}

export function listModels(): NimModel[] {
  return nimImages.models.map((m: NimModel) => ({
    name: m.name,
    image: m.image,
    minGpuMemoryMB: m.minGpuMemoryMB,
  }));
}

export function canRunNimWithMemory(totalMemoryMB: number): boolean {
  return nimImages.models.some((m: NimModel) => m.minGpuMemoryMB <= totalMemoryMB);
}

export function detectGpu(): GpuDetection | null {
  // Try NVIDIA first — query VRAM
  try {
    const output = runCapture(
      ["nvidia-smi", "--query-gpu=memory.total", "--format=csv,noheader,nounits"],
      { ignoreError: true },
    );
    if (output) {
      const lines = output.split("\n").filter((l: string) => l.trim());
      const perGpuMB = lines
        .map((l: string) => parseInt(l.trim(), 10))
        .filter((n: number) => !isNaN(n));
      if (perGpuMB.length > 0) {
        const totalMemoryMB = perGpuMB.reduce((a: number, b: number) => a + b, 0);
        return {
          type: "nvidia",
          count: perGpuMB.length,
          totalMemoryMB,
          perGpuMB: perGpuMB[0],
          nimCapable: canRunNimWithMemory(totalMemoryMB),
        };
      }
    }
  } catch {
    /* ignored */
  }

  // Fallback: unified-memory NVIDIA devices
  try {
    const nameOutput = runCapture(
      ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader,nounits"],
      { ignoreError: true },
    );
    const gpuNames = nameOutput
      .split("\n")
      .map((line: string) => line.trim())
      .filter(Boolean);
    const unifiedGpuNames = gpuNames.filter((name: string) =>
      UNIFIED_MEMORY_GPU_TAGS.some((tag) => new RegExp(tag, "i").test(name)),
    );
    if (unifiedGpuNames.length > 0) {
      let totalMemoryMB = 0;
      try {
        const freeOut = runCapture(["free", "-m"], { ignoreError: true });
        if (freeOut) {
          const memLine = freeOut.split("\n").find((l: string) => l.includes("Mem:"));
          if (memLine) {
            const parts = memLine.split(/\s+/);
            totalMemoryMB = parseInt(parts[1], 10) || 0;
          }
        }
      } catch {
        /* ignored */
      }
      const count = unifiedGpuNames.length;
      const perGpuMB = count > 0 ? Math.floor(totalMemoryMB / count) : totalMemoryMB;
      const isSpark = unifiedGpuNames.some((name: string) => /GB10/i.test(name));
      return {
        type: "nvidia",
        name: unifiedGpuNames[0],
        count,
        totalMemoryMB,
        perGpuMB: perGpuMB || totalMemoryMB,
        nimCapable: canRunNimWithMemory(totalMemoryMB),
        unifiedMemory: true,
        spark: isSpark,
      };
    }
  } catch {
    /* ignored */
  }

  // macOS: detect Apple Silicon or discrete GPU
  if (process.platform === "darwin") {
    try {
      const spOutput = runCapture(["system_profiler", "SPDisplaysDataType"], {
        ignoreError: true,
      });
      if (spOutput) {
        const chipMatch = spOutput.match(/Chipset Model:\s*(.+)/);
        const vramMatch = spOutput.match(/VRAM.*?:\s*(\d+)\s*(MB|GB)/i);
        const coresMatch = spOutput.match(/Total Number of Cores:\s*(\d+)/);

        if (chipMatch) {
          const name = chipMatch[1].trim();
          let memoryMB = 0;

          if (vramMatch) {
            memoryMB = parseInt(vramMatch[1], 10);
            if (vramMatch[2].toUpperCase() === "GB") memoryMB *= 1024;
          } else {
            try {
              const memBytes = runCapture(["sysctl", "-n", "hw.memsize"], { ignoreError: true });
              if (memBytes) memoryMB = Math.floor(parseInt(memBytes, 10) / 1024 / 1024);
            } catch {
              /* ignored */
            }
          }

          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            perGpuMB: memoryMB,
            nimCapable: false,
          };
        }
      }
    } catch {
      /* ignored */
    }
  }

  return null;
}

// Check if Docker has stored credentials for nvcr.io.
// Docker Desktop (macOS/Windows/WSL) stores creds in the OS keychain and
// leaves an empty marker entry { "nvcr.io": {} } in auths after a successful
// login. That marker plus a global credsStore is treated as logged in.
export function isNgcLoggedIn(): boolean {
  try {
    const os = require("os");
    const fs = require("fs");
    const path = require("path");
    const config = path.join(os.homedir(), ".docker", "config.json");
    const data = fs.readFileSync(config, "utf-8");
    const parsed = JSON.parse(data);
    if (parsed?.credHelpers?.["nvcr.io"]) return true;
    const auths = parsed?.auths || {};
    const entry = auths["nvcr.io"] || auths["https://nvcr.io"];
    if (entry?.auth) return true;
    if (entry && parsed?.credsStore) return true;
    return false;
  } catch {
    return false;
  }
}

// NGC expects literal "$oauthtoken" as the username for API key authentication.
export function dockerLoginNgc(apiKey: string): boolean {
  const { spawnSync } = require("child_process");
  const result = spawnSync("docker", ["login", "nvcr.io", "-u", "$oauthtoken", "--password-stdin"], {
    input: apiKey,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    console.error(`  Docker error: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0 && result.stderr) {
    console.error(`  Docker login error: ${result.stderr.trim()}`);
  }
  return result.status === 0;
}

export function pullNimImage(model: string): string {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }
  console.log(`  Pulling NIM image: ${image}`);
  run(["docker", "pull", image]);
  return image;
}

export function startNimContainer(sandboxName: string, model: string, port = VLLM_PORT): string {
  const name = containerName(sandboxName);
  return startNimContainerByName(name, model, port);
}

export function startNimContainerByName(name: string, model: string, port = VLLM_PORT): string {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  run(["docker", "rm", "-f", name], { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  run([
    "docker", "run", "-d", "--gpus", "all",
    "-p", `${Number(port)}:8000`,
    "--name", name,
    "--shm-size", "16g",
    image,
  ]);
  return name;
}

export function waitForNimHealth(port = VLLM_PORT, timeout = 300): boolean {
  const start = Date.now();
  const intervalSec = 5;
  const hostPort = Number(port);
  console.log(`  Waiting for NIM health on port ${hostPort} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runCapture(
        [
          "curl",
          "-sf",
          "--connect-timeout",
          "5",
          "--max-time",
          "5",
          `http://127.0.0.1:${hostPort}/v1/models`,
        ],
        { ignoreError: true },
      );
      if (result) {
        console.log("  NIM is healthy.");
        return true;
      }
    } catch {
      /* ignored */
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("child_process").spawnSync("sleep", [String(intervalSec)]);
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

export function stopNimContainer(sandboxName: string): void {
  const name = containerName(sandboxName);
  stopNimContainerByName(name);
}

export function stopNimContainerByName(name: string): void {
  console.log(`  Stopping NIM container: ${name}`);
  run(["docker", "stop", name], { ignoreError: true });
  run(["docker", "rm", name], { ignoreError: true });
}

export function nimStatus(sandboxName: string, port?: number): NimStatus {
  const name = containerName(sandboxName);
  return nimStatusByName(name, port);
}

export function nimStatusByName(name: string, port?: number): NimStatus {
  try {
    const state = runCapture(
      ["docker", "inspect", "--format", "{{.State.Status}}", name],
      { ignoreError: true },
    );
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      let resolvedHostPort = port != null ? Number(port) : 0;
      if (!resolvedHostPort) {
        const mapping = runCapture(["docker", "port", name, "8000"], {
          ignoreError: true,
        });
        const m = mapping && mapping.match(/:(\d+)\s*$/);
        resolvedHostPort = m ? Number(m[1]) : VLLM_PORT;
      }
      const health = runCapture(
        [
          "curl",
          "-sf",
          "--connect-timeout",
          "5",
          "--max-time",
          "5",
          `http://127.0.0.1:${resolvedHostPort}/v1/models`,
        ],
        { ignoreError: true },
      );
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}
