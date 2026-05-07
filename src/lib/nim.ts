// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const fs = require("fs");
const { runCapture } = require("./runner");
const {
  dockerContainerInspectFormat,
  dockerForceRm,
  dockerLoginPasswordStdin,
  dockerPort,
  dockerPull,
  dockerRm,
  dockerRunDetached,
  dockerStop,
} = require("./adapters/docker");
const { sleepSeconds } = require("./wait");
const nimImages = require("../../bin/lib/nim-images.json");

import { VLLM_PORT } from "./ports";

const UNIFIED_MEMORY_GPU_TAGS = ["GB10", "Thor", "Orin", "Xavier"];
const NIM_STATUS_PROBE_TIMEOUT_MS = 5000;

export interface NimModel {
  name: string;
  image: string;
  minGpuMemoryMB: number;
}

export type NvidiaPlatform = "spark" | "station" | "linux";

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
  platform?: NvidiaPlatform;
}

// Read the platform model name from firmware. Try DMI first (covers Spark
// and Station, observed empirically), fall back to devicetree on systems
// without DMI tables. Returns "" if neither is readable.
function readPlatformModel(): string {
  try {
    const dmi = fs.readFileSync("/sys/class/dmi/id/product_name", "utf-8").trim();
    if (dmi) return dmi;
  } catch {
    /* no dmi */
  }
  try {
    return fs
      .readFileSync("/sys/firmware/devicetree/base/model", "utf-8")
      .replace(/\0/g, "")
      .trim();
  } catch {
    /* not arm devicetree */
  }
  return "";
}

export function detectNvidiaPlatform(): NvidiaPlatform {
  const model = readPlatformModel();
  if (/DGX[_\s-]+Spark/i.test(model)) return "spark";
  if (
    /(?<![A-Za-z0-9])P3830(?![A-Za-z0-9])/i.test(model) ||
    /DGX[_\s-]+Station/i.test(model) ||
    (/Station/i.test(model) && /GB300/i.test(model))
  ) {
    return "station";
  }
  return "linux";
}

// Return the indices of NVIDIA GPUs whose name matches `pattern`. Returns
// [] if nvidia-smi is unavailable or no GPU matches. Used to pin a Docker
// container to a specific GPU on hosts with mixed configurations (e.g.
// DGX Station's GB300 alongside other GPUs).
export function getGpuIndicesByName(pattern: RegExp): number[] {
  const out = runCapture(
    ["nvidia-smi", "--query-gpu=index,name", "--format=csv,noheader,nounits"],
    { ignoreError: true },
  );
  if (!out) return [];
  const indices: number[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(",");
    if (idx === -1) continue;
    const i = Number(trimmed.slice(0, idx).trim());
    const name = trimmed.slice(idx + 1).trim();
    if (!Number.isNaN(i) && pattern.test(name)) indices.push(i);
  }
  return indices;
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
  // Try NVIDIA first — query name and VRAM in a single call so the preflight
  // line can show the GPU model alongside the memory size.
  try {
    const output = runCapture(
      ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
      { ignoreError: true },
    );
    if (output) {
      type ParsedGpu = { name: string; memoryMB: number };
      const parsed: ParsedGpu[] = [];
      for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        // Split on the LAST comma — GPU names can contain commas in rare cases.
        const idx = line.lastIndexOf(",");
        if (idx === -1) continue;
        const name = line.slice(0, idx).trim();
        const memoryMB = parseInt(line.slice(idx + 1).trim(), 10);
        if (isNaN(memoryMB)) continue;
        parsed.push({ name, memoryMB });
      }
      if (parsed.length > 0) {
        const totalMemoryMB = parsed.reduce(
          (sum: number, p: ParsedGpu) => sum + p.memoryMB,
          0,
        );
        const firstName = parsed[0].name;
        // Only surface a single name when every GPU reports the same model;
        // a mixed-GPU host would otherwise be misreported as `Nx <firstName>`.
        const allSameName =
          !!firstName && parsed.every((p: ParsedGpu) => p.name === firstName);
        const platform = detectNvidiaPlatform();
        return {
          type: "nvidia",
          ...(allSameName ? { name: firstName } : {}),
          count: parsed.length,
          totalMemoryMB,
          perGpuMB: parsed[0].memoryMB,
          nimCapable: canRunNimWithMemory(totalMemoryMB),
          platform,
          spark: platform === "spark",
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
      // Cross-check the firmware model against the GPU name. Spark must have
      // a GB10; falling through to firmware lets us classify Station too.
      const firmwarePlatform = detectNvidiaPlatform();
      const hasGb10 = unifiedGpuNames.some((name: string) => /GB10/i.test(name));
      const platform: NvidiaPlatform =
        firmwarePlatform === "spark" || hasGb10
          ? "spark"
          : firmwarePlatform === "station"
            ? "station"
            : "linux";
      return {
        type: "nvidia",
        name: unifiedGpuNames[0],
        count,
        totalMemoryMB,
        perGpuMB: perGpuMB || totalMemoryMB,
        nimCapable: canRunNimWithMemory(totalMemoryMB),
        unifiedMemory: true,
        spark: platform === "spark",
        platform,
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
  const result = dockerLoginPasswordStdin("nvcr.io", "$oauthtoken", apiKey);
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
  dockerPull(image);
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

  dockerForceRm(name, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  dockerRunDetached([
    "--gpus",
    "all",
    "-p",
    `${Number(port)}:8000`,
    "--name",
    name,
    "--shm-size",
    "16g",
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
    sleepSeconds(intervalSec);
  }
  console.error(`  NIM did not become healthy within ${timeout}s.`);
  return false;
}

export function stopNimContainer(
  sandboxName: string,
  { silent = false }: { silent?: boolean } = {},
): void {
  const name = containerName(sandboxName);
  stopNimContainerByName(name, { silent });
}

export function stopNimContainerByName(
  name: string,
  { silent = false }: { silent?: boolean } = {},
): void {
  if (!silent) console.log(`  Stopping NIM container: ${name}`);
  const stdio = silent ? ["ignore", "ignore", "ignore"] : undefined;
  dockerStop(name, { ignoreError: true, ...(stdio && { stdio }) });
  dockerRm(name, { ignoreError: true, ...(stdio && { stdio }) });
}

export function nimStatus(sandboxName: string, port?: number): NimStatus {
  const name = containerName(sandboxName);
  return nimStatusByName(name, port);
}

export function nimStatusByName(name: string, port?: number): NimStatus {
  try {
    const state = dockerContainerInspectFormat("{{.State.Status}}", name, {
      ignoreError: true,
      timeout: NIM_STATUS_PROBE_TIMEOUT_MS,
    });
    if (!state) return { running: false, container: name };

    let healthy = false;
    if (state === "running") {
      let resolvedHostPort = port != null ? Number(port) : 0;
      if (!resolvedHostPort) {
        const mapping = dockerPort(name, "8000", {
          ignoreError: true,
          timeout: NIM_STATUS_PROBE_TIMEOUT_MS,
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
        { ignoreError: true, timeout: NIM_STATUS_PROBE_TIMEOUT_MS + 1000 },
      );
      healthy = !!health;
    }
    return { running: state === "running", healthy, container: name, state };
  } catch {
    return { running: false, container: name };
  }
}

// Cloud-only providers leave nimContainer unset; printing "NIM: not running"
// for those sandboxes implies a fault when NIM is simply not part of the
// deployment. Still surface the line if a container is unexpectedly alive,
// so an orphan NIM is not silently hidden.
export function shouldShowNimLine(
  nimContainer: string | null | undefined,
  nimRunning: boolean,
): boolean {
  return Boolean(nimContainer) || nimRunning;
}
