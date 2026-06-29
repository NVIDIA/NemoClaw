// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NIM container management — pull, start, stop, health-check NIM images.

const fs = require("fs");
const { runCapture } = require("../runner");
const {
  dockerContainerInspectFormat,
  dockerForceRm,
  dockerLoginPasswordStdin,
  dockerLogs,
  dockerManifestInspect,
  dockerPort,
  dockerPull,
  dockerRm,
  dockerRunDetached,
  dockerStop,
  dockerTag,
} = require("../adapters/docker");
const { sleepSeconds } = require("../core/wait");
const nimImages = require("../../../bin/lib/nim-images.json");

import { buildValidatedCurlCommandArgs } from "../adapters/http/curl-args";
import { VLLM_PORT } from "../core/ports";
import { isSafeModelId } from "../validation";
import {
  type Arm64WslDockerDesktopGpuProver,
  isDenylistedNvidiaGpuName,
  isPlausibleNvidiaGpuName,
  nvidiaHostLooksGenuine,
} from "./gpu-trust";

const UNIFIED_MEMORY_GPU_TAGS = ["GB10", "Thor", "Orin", "Xavier", "Jetson", "Tegra"];
const NIM_STATUS_PROBE_TIMEOUT_MS = 5000;
export const DEFAULT_NIM_HEALTH_TIMEOUT_SECONDS = 1200;

export interface NimModel {
  name: string;
  image: string;
  minGpuMemoryMB: number;
}

export type NvidiaPlatform = "spark" | "station" | "jetson" | "linux";

export interface NimGpu {
  name: string;
  memoryMB: number;
}

export interface GpuGroup {
  name: string;
  count: number;
  memoryMB: number;
}

export interface GpuDetection {
  type: string;
  name?: string;
  // Per-GPU breakdown when available (primary nvidia-smi --query-gpu path).
  // Always populated alongside `name` for NVIDIA; absent on the count-only
  // fallback when every parsed row had a blank name. See #2669.
  gpus?: NimGpu[];
  count: number;
  totalMemoryMB: number;
  // Currently free GPU memory at probe time. NVIDIA: summed from
  // `nvidia-smi memory.free`. Unified-memory (Spark/Jetson): approximated
  // from host `MemAvailable` since GPU memory is the system pool. macOS:
  // approximated from `vm_stat` reclaimable pages. Absent when every
  // probe was inconclusive; downstream callers fall back to
  // `totalMemoryMB`.
  availableMemoryMB?: number;
  perGpuMB: number;
  cores?: number | null;
  nimCapable: boolean;
  unifiedMemory?: boolean;
  spark?: boolean;
  platform?: NvidiaPlatform;
  // `true` for integrated/iGPU class NVIDIA platforms (Jetson Tegra/Thor/Orin)
  // whose token-generation throughput on 30B+ class Ollama models cannot clear
  // agent-loop timeouts even when advertised memory ostensibly fits. Mirrored
  // onto `GpuInfo.computeConstrained` so the Ollama bootstrap-model selector
  // skips `computeIntensive` registry entries on these hosts.
  computeConstrained?: boolean;
  // Set when a denylisted `JMJWOA-Generic-*` placeholder name was accepted only
  // because a bounded Docker `--gpus` CUDA proof passed (Windows-ARM N1X + WSL2
  // + Docker Desktop, #4565). Diagnostic marker that this detection cleared a
  // live proof rather than firmware/name trust. The sandbox GPU preflight still
  // reaches the Docker Desktop WSL compatibility branch via its own
  // `detectWslDockerDesktopStatus()` check (consistent because the proof itself
  // requires Docker Desktop WSL); this flag does not gate that branch.
  wslDockerDesktopGpuProofPassed?: boolean;
}

export interface DetectGpuDeps {
  // Optional accept-path for ARM64 WSL Docker Desktop `JMJWOA-Generic-*` GPUs
  // (#4565). Injected in tests; in production `detectGpu()` lazily builds the
  // default prover from the onboard WSL Docker Desktop module only when it is
  // about to reject a denylisted ARM64 name.
  proveArm64WslDockerDesktopGpu?: Arm64WslDockerDesktopGpuProver | null;
}

// Lazily construct the default ARM64 WSL Docker Desktop GPU prover. Kept lazy
// (and behind a require) so the inference layer does not statically depend on
// the onboard layer, and so the bounded Docker proof is only wired when we
// actually reach the denylist-reject path on an ARM64 host.
function defaultArm64WslDockerDesktopGpuProver(): Arm64WslDockerDesktopGpuProver | null {
  try {
    return require("../onboard/wsl-docker-desktop-gpu").createArm64WslDockerDesktopGpuProver();
  } catch (error) {
    // Only the optional module-resolution case should degrade to "no prover";
    // a real bug inside the prover module must bubble up rather than masquerade
    // as a missing GPU on an otherwise-supported N1X host.
    if (
      error &&
      typeof error === "object" &&
      (error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND"
    ) {
      return null;
    }
    throw error;
  }
}

// Group GPUs by their nvidia-smi model name, preserving first-appearance order.
// Names are whitespace-normalized; rows with blank names are dropped (the caller
// falls through to the count-only display in that case). We deliberately do not
// include memoryMB in the group key — within a single host, nvidia-smi reports
// stable name strings that already disambiguate memory variants (e.g.
// "H100 80GB HBM3" vs "H100 40GB"). The only theoretical collision is ECC-mode
// reporting variance on otherwise-identical cards, which is rare enough that
// splitting the group would create more confusion than it solves.
export function groupGpusByName(gpus: readonly NimGpu[]): GpuGroup[] {
  const groups: GpuGroup[] = [];
  for (const g of gpus) {
    const name = g.name.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const existing = groups.find((grp) => grp.name === name);
    if (existing) {
      existing.count += 1;
      existing.memoryMB += g.memoryMB;
    } else {
      groups.push({ name, count: 1, memoryMB: g.memoryMB });
    }
  }
  return groups;
}

// Render the preflight summary for an NVIDIA GPU detection. Returns one
// or more lines that the caller prefixes with `  ✓ ` /  prints directly.
//
//   - Homogeneous (1 GPU or N of the same model) → single compact line:
//       NVIDIA GPU detected (<model>, <vram> MB)
//       NVIDIA GPU detected (Nx <model>, <vram> MB)
//   - Mixed model → aggregate header + indented per-group breakdown:
//       NVIDIA GPU detected: 2 GPUs, 354590 MB VRAM
//           - NVIDIA RTX PRO 6000 Blackwell Max-Q (97887 MB)
//           - NVIDIA GB300 (256703 MB)
//     Within one breakdown block, `Nx ` is added to every group when any
//     group has count > 1 (preserves column alignment); otherwise dropped.
//   - No usable names → last-resort count-only fallback.
//
// See #2669 for the multi-GPU case the previous fix missed.
export function formatNvidiaGpuPreflightLines(gpu: GpuDetection): string[] {
  if (gpu.name) {
    const detail = gpu.count > 1 ? `${gpu.count}x ${gpu.name}` : gpu.name;
    return [`NVIDIA GPU detected (${detail}, ${gpu.totalMemoryMB} MB)`];
  }
  if (gpu.gpus && gpu.gpus.length > 0) {
    const groups = groupGpusByName(gpu.gpus);
    if (groups.length > 0) {
      const lines = [`NVIDIA GPU detected: ${gpu.count} GPUs, ${gpu.totalMemoryMB} MB VRAM`];
      const anyDuplicate = groups.some((grp) => grp.count > 1);
      for (const grp of groups) {
        const prefix = anyDuplicate ? `${grp.count}x ` : "";
        lines.push(`    - ${prefix}${grp.name} (${grp.memoryMB} MB)`);
      }
      return lines;
    }
  }
  return [`NVIDIA GPU detected: ${gpu.count} GPU(s), ${gpu.totalMemoryMB} MB VRAM`];
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

function readHostMemoryMB(): number {
  try {
    const freeOut = runCapture(["free", "-m"], { ignoreError: true });
    if (freeOut) {
      const memLine = freeOut.split("\n").find((l: string) => l.includes("Mem:"));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        return parseInt(parts[1], 10) || 0;
      }
    }
  } catch {
    /* ignored */
  }
  return 0;
}

// macOS equivalent of `MemAvailable`: parse `vm_stat` output, sum the
// kernel-reclaimable page classes (free + inactive + speculative), and
// scale by the reported page size. The result is the same "could I load
// a 22 GB model right now?" signal the unified-memory Linux path uses.
// Returns 0 when any expected field is missing so the caller can treat
// the figure as "unknown" and fall back to total memory.
function readMacOsAvailableMemoryMB(): number {
  try {
    const out = runCapture(["vm_stat"], { ignoreError: true });
    if (!out) return 0;
    const pageMatch = out.match(/page size of (\d+) bytes/);
    if (!pageMatch) return 0;
    const pageBytes = parseInt(pageMatch[1], 10);
    if (!Number.isFinite(pageBytes) || pageBytes <= 0) return 0;
    const grab = (label: string): number => {
      const match = out.match(new RegExp(`Pages ${label}:\\s+(\\d+)\\.`));
      return match ? parseInt(match[1], 10) : 0;
    };
    const pages = grab("free") + grab("inactive") + grab("speculative");
    if (pages <= 0) return 0;
    return Math.floor((pages * pageBytes) / 1024 / 1024);
  } catch {
    return 0;
  }
}

// `free -m` columns: total used free shared buff/cache available.
// "available" (column 6) is the kernel's estimate of memory that can be
// reclaimed without swapping — the right signal for "is there room for a
// 22 GB Ollama load right now?" on unified-memory hosts. Returns 0 when
// the column cannot be parsed; the caller treats 0 as "unknown" and falls
// back to total memory.
function readHostAvailableMemoryMB(): number {
  try {
    const freeOut = runCapture(["free", "-m"], { ignoreError: true });
    if (freeOut) {
      const memLine = freeOut.split("\n").find((l: string) => l.includes("Mem:"));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        return parseInt(parts[6], 10) || 0;
      }
    }
  } catch {
    /* ignored */
  }
  return 0;
}

function hostPathExists(path: string): boolean {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function hasTegraDeviceNodeSignal(): boolean {
  return ["/dev/nvhost-gpu", "/dev/nvhost-ctrl-gpu", "/dev/nvhost-ctrl", "/dev/nvmap"].some(
    hostPathExists,
  );
}

function detectTegraHostGpu(): { name: string; platform: NvidiaPlatform } | null {
  const model = readPlatformModel();
  const modelLooksTegra = /Jetson|Tegra|Thor|Orin|Xavier/i.test(model);
  if (!modelLooksTegra && !hasTegraDeviceNodeSignal()) return null;

  let name = model.replace(/^NVIDIA\s+/i, "").trim();
  if (!name) name = "Jetson/Tegra";
  if (!/^NVIDIA\b/i.test(name)) name = `NVIDIA ${name}`;
  if (!/Jetson|Tegra|Thor|Orin|Xavier/i.test(name)) {
    name = "NVIDIA Jetson/Tegra GPU";
  }
  return { name, platform: "jetson" };
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
  if (/Jetson|Tegra|Thor|Orin|Xavier/i.test(model) || hasTegraDeviceNodeSignal()) {
    return "jetson";
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

// First model id from a NIM `/v1/models` body, or null if absent/unparseable.
export function parseServedModelId(modelsJson: string): string | null {
  try {
    const doc = JSON.parse(modelsJson);
    const data = Array.isArray(doc?.data) ? doc.data : [];
    for (const entry of data) {
      if (typeof entry?.id === "string" && entry.id.length > 0) return entry.id;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

// Model id a running local NIM actually serves; null if unreachable/empty.
export function getServedModelId(port = VLLM_PORT): string | null {
  const out = runCapture(
    [
      "curl",
      ...buildValidatedCurlCommandArgs([
        "-sf",
        "--connect-timeout",
        "5",
        "--max-time",
        "5",
        `http://127.0.0.1:${Number(port)}/v1/models`,
      ]),
    ],
    { ignoreError: true },
  );
  return out ? parseServedModelId(out) : null;
}

// Adopt the id NIM serves (from /v1/models) when it differs from the catalog
// name and is safe; the catalog id otherwise 404s on validation. See #3885.
export function adoptServedModelId(catalogModel: string | null, port = VLLM_PORT): string | null {
  const served = getServedModelId(port);
  if (!served || served === catalogModel) return catalogModel;
  // /v1/models is local-controlled — refuse an unsafe id; don't echo it (log-injection).
  if (!isSafeModelId(served)) {
    console.error(`  NIM reported an invalid model id; keeping "${catalogModel}".`);
    return catalogModel;
  }
  console.log(`  NIM serves "${served}" (catalog "${catalogModel}"); using served id.`);
  return served;
}

export function detectGpu(deps: DetectGpuDeps = {}): GpuDetection | null {
  // Try NVIDIA first — query name, total, and free VRAM in a single call so
  // the preflight line can show the GPU model alongside the memory size and
  // the bootstrap-model selector can pick a model that fits currently
  // available memory, not just the headline total.
  try {
    const output = runCapture(
      ["nvidia-smi", "--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { ignoreError: true },
    );
    if (output) {
      type ParsedGpu = { name: string; memoryMB: number; freeMemoryMB: number };
      const parsed: ParsedGpu[] = [];
      for (const raw of output.split("\n")) {
        const line = raw.trim();
        if (!line) continue;
        // Split on commas from the RIGHT: free MB, then total MB; the
        // remainder is the GPU name (which can itself contain commas).
        const lastIdx = line.lastIndexOf(",");
        if (lastIdx === -1) continue;
        const freeMemoryMB = parseInt(line.slice(lastIdx + 1).trim(), 10);
        const beforeFree = line.slice(0, lastIdx);
        const totalIdx = beforeFree.lastIndexOf(",");
        if (totalIdx === -1) continue;
        const memoryMB = parseInt(beforeFree.slice(totalIdx + 1).trim(), 10);
        const name = beforeFree.slice(0, totalIdx).trim();
        if (isNaN(memoryMB)) continue;
        parsed.push({
          name,
          memoryMB,
          freeMemoryMB: isNaN(freeMemoryMB) ? 0 : freeMemoryMB,
        });
      }
      if (parsed.length > 0) {
        const platform = detectNvidiaPlatform();
        // Off Spark/Station/Jetson firmware, layer a denylist check and the
        // trust-tier gate before trusting the nvidia-smi probe. The observed
        // Windows-on-ARM WSL2 nvidia-smi shim emits a `JMJWOA-Generic-*`
        // placeholder name AND ships no `/proc/driver/nvidia/` directory. A
        // denylisted row still fails closed by default; the only escape is a
        // bounded Docker `--gpus` CUDA proof (#4565), which the Snapdragon shim
        // cannot pass. Without that proof, any denylisted row rejects the whole
        // probe — partial filtering would let a mixed-row spoof surface a
        // non-placeholder row as a real GPU.
        const firmwareConfirmsNvidia =
          platform === "spark" || platform === "station" || platform === "jetson";
        let trusted: ParsedGpu[];
        let wslDockerDesktopGpuProofPassed = false;
        if (firmwareConfirmsNvidia) {
          trusted = parsed;
        } else if (parsed.some((p: ParsedGpu) => isDenylistedNvidiaGpuName(p.name))) {
          // A denylisted `JMJWOA-Generic-*` placeholder. Both real Windows-ARM
          // N1X (WSL2 + Docker Desktop) and the Snapdragon nvidia-smi shim emit
          // this name, so the name and `/proc/driver/nvidia` are insufficient.
          // Give the host one bounded Docker `--gpus` CUDA proof: only the real
          // GPU can run the workload, so a pass safely accepts N1X while the
          // shim keeps failing closed (#4565 without reopening #3988/#4424).
          const prover =
            deps.proveArm64WslDockerDesktopGpu === undefined
              ? defaultArm64WslDockerDesktopGpuProver()
              : deps.proveArm64WslDockerDesktopGpu;
          const proof = prover ? prover(parsed.map((p: ParsedGpu) => p.name)) : null;
          if (!proof || !proof.passed) {
            return null;
          }
          // The proof confirms a usable GPU, but it does not vouch for every
          // row. Keep only the placeholder rows it covers plus any plausibly-
          // named NVIDIA rows; drop unrecognized garbage so a mixed-row spoof
          // cannot inflate totalMemoryMB with a phantom device.
          trusted = parsed.filter(
            (p: ParsedGpu) => isDenylistedNvidiaGpuName(p.name) || isPlausibleNvidiaGpuName(p.name),
          );
          wslDockerDesktopGpuProofPassed = true;
        } else {
          if (!nvidiaHostLooksGenuine()) {
            return null;
          }
          trusted = parsed.filter((p: ParsedGpu) => isPlausibleNvidiaGpuName(p.name));
        }
        if (trusted.length === 0) {
          return null;
        }
        const totalMemoryMB = trusted.reduce((sum: number, p: ParsedGpu) => sum + p.memoryMB, 0);
        const availableMemoryMB = trusted.reduce(
          (sum: number, p: ParsedGpu) => sum + p.freeMemoryMB,
          0,
        );
        const firstName = trusted[0].name;
        // Only surface a single name when every GPU reports the same model;
        // a mixed-GPU host would otherwise be misreported as `Nx <firstName>`.
        const allSameName = !!firstName && trusted.every((p: ParsedGpu) => p.name === firstName);
        return {
          type: "nvidia",
          ...(allSameName ? { name: firstName } : {}),
          gpus: trusted.map((p) => ({ name: p.name, memoryMB: p.memoryMB })),
          count: trusted.length,
          totalMemoryMB,
          ...(availableMemoryMB > 0 ? { availableMemoryMB } : {}),
          perGpuMB: trusted[0].memoryMB,
          nimCapable: canRunNimWithMemory(totalMemoryMB),
          platform,
          spark: platform === "spark",
          ...(platform === "jetson" ? { computeConstrained: true } : {}),
          ...(wslDockerDesktopGpuProofPassed ? { wslDockerDesktopGpuProofPassed: true } : {}),
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
    // Cross-check the firmware model up front. On DGX Spark, nvidia-smi may
    // identify the GPU as something like "NVIDIA JMJWOA-Generic-GPU" that
    // matches none of UNIFIED_MEMORY_GPU_TAGS, even though the device is a
    // unified-memory one (#3510). When firmware confirms a unified-memory
    // platform, accept whatever name nvidia-smi reports.
    const firmwarePlatform = detectNvidiaPlatform();
    const firmwareIsUnifiedMemory = firmwarePlatform === "spark" || firmwarePlatform === "jetson";
    // Reject placeholder names on hosts where firmware does not vouch for an
    // NVIDIA platform, mirroring the primary path. A WSL2 d3d12/WDDM shim
    // could in principle emit `JMJWOA-Generic-*` on this fallback too.
    if (
      !firmwareIsUnifiedMemory &&
      gpuNames.some((name: string) => isDenylistedNvidiaGpuName(name))
    ) {
      return null;
    }
    const taggedNames = gpuNames.filter((name: string) =>
      UNIFIED_MEMORY_GPU_TAGS.some((tag) => new RegExp(tag, "i").test(name)),
    );
    // Tagged-name acceptance on non-firmware-vouched hosts must additionally
    // pass the trust-tier gate so the same source-boundary policy documented
    // in gpu-trust.ts applies on the unified-memory fallback.
    const allowTaggedOnGenericFirmware = nvidiaHostLooksGenuine();
    const unifiedGpuNames =
      taggedNames.length > 0
        ? firmwareIsUnifiedMemory || allowTaggedOnGenericFirmware
          ? taggedNames
          : []
        : firmwareIsUnifiedMemory
          ? gpuNames
          : [];
    if (unifiedGpuNames.length > 0) {
      const totalMemoryMB = readHostMemoryMB();
      const count = unifiedGpuNames.length;
      const perGpuMB = count > 0 ? Math.floor(totalMemoryMB / count) : totalMemoryMB;
      const firstUnifiedName = unifiedGpuNames[0] ?? "";
      // Mirror the primary path: only surface a single name when every GPU
      // reports the same model. Otherwise a hypothetical mixed unified-memory
      // host (e.g. Spark + Orin) would be misrendered as `Nx <first model>`.
      const allUnifiedSameName =
        !!firstUnifiedName && unifiedGpuNames.every((n: string) => n === firstUnifiedName);
      // Cross-check the firmware model against the GPU name. Spark must have
      // a GB10; falling through to firmware lets us classify Station too.
      const hasGb10 = unifiedGpuNames.some((name: string) => /GB10/i.test(name));
      const platform: NvidiaPlatform =
        firmwarePlatform === "spark" || hasGb10
          ? "spark"
          : firmwarePlatform === "station"
            ? "station"
            : firmwarePlatform === "jetson"
              ? "jetson"
              : "linux";
      // Memory.total is not available on unified-memory devices, so we split
      // the host RAM evenly across the named GPUs for the per-GPU breakdown.
      // Approximation, but the only number nvidia-smi gives us in this path.
      // `availableMemoryMB` mirrors that approximation using MemAvailable so
      // the bootstrap-model selector reacts to concurrent GPU workloads
      // eating into the shared system pool.
      const availableMemoryMB = readHostAvailableMemoryMB();
      return {
        type: "nvidia",
        ...(allUnifiedSameName ? { name: firstUnifiedName } : {}),
        gpus: unifiedGpuNames.map((name: string) => ({ name, memoryMB: perGpuMB })),
        count,
        totalMemoryMB,
        ...(availableMemoryMB > 0 ? { availableMemoryMB } : {}),
        perGpuMB: perGpuMB || totalMemoryMB,
        nimCapable: canRunNimWithMemory(totalMemoryMB),
        unifiedMemory: true,
        spark: platform === "spark",
        ...(platform === "jetson" ? { computeConstrained: true } : {}),
        platform,
      };
    }
  } catch {
    /* ignored */
  }

  // Jetson/Tegra hosts often do not ship nvidia-smi, but still expose the
  // integrated NVIDIA GPU through firmware and Tegra device nodes.
  const tegraGpu = detectTegraHostGpu();
  if (tegraGpu) {
    const totalMemoryMB = readHostMemoryMB();
    const availableMemoryMB = readHostAvailableMemoryMB();
    return {
      type: "nvidia",
      name: tegraGpu.name,
      gpus: [{ name: tegraGpu.name, memoryMB: totalMemoryMB }],
      count: 1,
      totalMemoryMB,
      ...(availableMemoryMB > 0 ? { availableMemoryMB } : {}),
      perGpuMB: totalMemoryMB,
      nimCapable: canRunNimWithMemory(totalMemoryMB),
      unifiedMemory: true,
      spark: false,
      computeConstrained: tegraGpu.platform === "jetson",
      platform: tegraGpu.platform,
    };
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

          const availableMemoryMB = readMacOsAvailableMemoryMB();
          return {
            type: "apple",
            name,
            count: 1,
            cores: coresMatch ? parseInt(coresMatch[1], 10) : null,
            totalMemoryMB: memoryMB,
            ...(availableMemoryMB > 0 ? { availableMemoryMB } : {}),
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

// Node's process.arch → OCI manifest "architecture" (x64 → amd64; others match).
export function nodeArchToOci(arch: string): string {
  if (arch === "x64") return "amd64";
  return arch;
}

interface ManifestPlatform {
  architecture?: string;
  os?: string;
}
interface ManifestIndexEntry {
  digest?: string;
  platform?: ManifestPlatform;
}
interface ManifestIndexDoc {
  manifests?: ManifestIndexEntry[];
}

// Linux image-manifest digest for `ociArch` from `docker manifest inspect` JSON,
// or null if not a multi-arch index / no match. Arch+os match skips attestations.
export function selectPlatformManifestDigest(manifestJson: string, ociArch: string): string | null {
  let doc: ManifestIndexDoc;
  try {
    doc = JSON.parse(manifestJson);
  } catch {
    return null;
  }
  const manifests = Array.isArray(doc?.manifests) ? doc.manifests : [];
  for (const entry of manifests) {
    if (
      entry?.platform?.architecture === ociArch &&
      entry?.platform?.os === "linux" &&
      typeof entry.digest === "string" &&
      entry.digest.length > 0
    ) {
      return entry.digest;
    }
  }
  return null;
}

// Repository portion of an image ref, dropping `:tag`/`@digest` (port-safe).
export function imageRepository(imageRef: string): string {
  const lastSlash = imageRef.lastIndexOf("/");
  const prefix = lastSlash === -1 ? "" : imageRef.slice(0, lastSlash + 1);
  const lastSegment = lastSlash === -1 ? imageRef : imageRef.slice(lastSlash + 1);
  const atIdx = lastSegment.indexOf("@");
  if (atIdx !== -1) return prefix + lastSegment.slice(0, atIdx);
  const colonIdx = lastSegment.indexOf(":");
  if (colonIdx !== -1) return prefix + lastSegment.slice(0, colonIdx);
  return imageRef;
}

// Pull `image` avoiding the NIM-on-NGC break: docker's containerd store fetches
// the index's buildkit attestation manifest, which nvcr.io rejects ("Incorrect
// Repository Format") after pulling all layers. Pull the host-arch manifest by
// digest instead (no index walk); plain pull when not a resolvable index. #3885.
function pullImageResolvingPlatform(image: string): void {
  let manifestJson = "";
  try {
    manifestJson = dockerManifestInspect(image, { ignoreError: true }) || "";
  } catch {
    manifestJson = "";
  }
  const digest = manifestJson
    ? selectPlatformManifestDigest(manifestJson, nodeArchToOci(process.arch))
    : null;
  if (!digest) {
    // No resolvable multi-arch index — plain tag pull. On Docker 29.x this can
    // re-hit the NGC attestation failure (#3885); surface the path taken.
    console.log(`  No platform manifest resolved; pulling ${image} by tag.`);
    dockerPull(image);
    return;
  }
  const digestRef = `${imageRepository(image)}@${digest}`;
  console.log(`  Resolved ${nodeArchToOci(process.arch)} manifest: ${digestRef}`);
  dockerPull(digestRef);
  // Tag back to the friendly ref so the run path starts the container by `image`.
  dockerTag(digestRef, image);
}

export function pullNimImage(model: string): string {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }
  console.log(`  Pulling NIM image: ${image}`);
  pullImageResolvingPlatform(image);
  return image;
}

export interface NimStartOptions {
  ngcApiKey?: string;
}

export function startNimContainerByName(
  name: string,
  model: string,
  port = VLLM_PORT,
  opts: NimStartOptions = {},
): string {
  const image = getImageForModel(model);
  if (!image) {
    console.error(`  Unknown model: ${model}`);
    process.exit(1);
  }

  // Resolve the NGC key: explicit arg wins, then NGC_API_KEY, then NVIDIA_INFERENCE_API_KEY,
  // then the legacy NVIDIA_API_KEY alias.
  // (covers users who only set the NVIDIA key for cloud inference but reuse it
  // against NGC). Without this, NIM's in-container model-manifest download
  // returns "Authentication Error" and the container exits 0 a few seconds in.
  // Regression of #210 — see #3333.
  const ngcApiKey =
    opts.ngcApiKey ??
    process.env.NGC_API_KEY ??
    process.env.NVIDIA_INFERENCE_API_KEY ??
    process.env.NVIDIA_API_KEY ??
    "";
  // Use `-e KEY` (no value) so the secret never appears in argv; pass the
  // value through the spawn env instead. Docker reads each named var from
  // its own process env and forwards it to the container.
  const envFlags = ngcApiKey ? ["-e", "NGC_API_KEY", "-e", "NIM_NGC_API_KEY"] : [];
  const runEnv = ngcApiKey ? { NGC_API_KEY: ngcApiKey, NIM_NGC_API_KEY: ngcApiKey } : undefined;
  if (!ngcApiKey) {
    console.warn(
      "  No NGC API key available; NIM will fail to download model weights. " +
        "Set NGC_API_KEY or pass it through onboard.",
    );
  }

  dockerForceRm(name, { ignoreError: true });

  console.log(`  Starting NIM container: ${name}`);
  dockerRunDetached(
    [
      "--gpus",
      "all",
      "-p",
      `${Number(port)}:8000`,
      "--name",
      name,
      "--shm-size",
      "16g",
      ...envFlags,
      image,
    ],
    runEnv ? { env: runEnv } : {},
  );
  return name;
}

export interface WaitForNimHealthOptions {
  container?: string;
}

export function waitForNimHealth(
  port = VLLM_PORT,
  timeout = DEFAULT_NIM_HEALTH_TIMEOUT_SECONDS,
  opts: WaitForNimHealthOptions = {},
): boolean {
  const start = Date.now();
  const intervalSec = 5;
  const hostPort = Number(port);
  const { container } = opts;
  console.log(`  Waiting for NIM health on port ${hostPort} (timeout: ${timeout}s)...`);

  while ((Date.now() - start) / 1000 < timeout) {
    try {
      const result = runCapture(
        [
          "curl",
          ...buildValidatedCurlCommandArgs([
            "-sf",
            "--connect-timeout",
            "5",
            "--max-time",
            "5",
            `http://127.0.0.1:${hostPort}/v1/models`,
          ]),
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
    // Short-circuit if the container has already exited — typically NGC auth
    // failure or OOM during model load. Without this, the wizard polls the
    // full timeout (default 1200s) against a dead container. See #3333.
    if (container) {
      const state = dockerContainerInspectFormat("{{.State.Status}}", container, {
        ignoreError: true,
        timeout: NIM_STATUS_PROBE_TIMEOUT_MS,
      });
      if (state && state !== "running" && state !== "created" && state !== "restarting") {
        console.error(`  NIM container ${container} is ${state}; aborting health wait.`);
        const tail = dockerLogs(container, { tail: 30 });
        if (tail) {
          console.error("  Last container output:");
          for (const line of tail.split("\n")) {
            if (line) console.error(`    ${line}`);
          }
        }
        return false;
      }
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
          ...buildValidatedCurlCommandArgs([
            "-sf",
            "--connect-timeout",
            "5",
            "--max-time",
            "5",
            `http://127.0.0.1:${resolvedHostPort}/v1/models`,
          ]),
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
