// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hardware resource discovery for NemoClaw.
 *
 * Provides `nemoclaw resources` — a read-only inventory of CPU, RAM, GPU,
 * and Kubernetes allocatable capacity. Used by the NemoClaw Installer to
 * auto-select profiles and models based on available hardware.
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { spawnSync, execSync } from "child_process";
import * as YAML from "yaml";

import { dockerSpawnSync } from "./adapters/docker";

const GATEWAY_NAME = "nemoclaw";

function getGatewayContainer(): string {
  return `openshell-cluster-${GATEWAY_NAME}`;
}

function getBlueprintPath(): string {
  return path.join(__dirname, "..", "..", "nemoclaw-blueprint", "blueprint.yaml");
}

function parseResourceProfilesFromBlueprint(
  blueprintPath: string,
): Record<string, ResourceProfile> {
  if (!fs.existsSync(blueprintPath)) return {};
  const content = fs.readFileSync(blueprintPath, "utf-8");
  const blueprint = YAML.parse(content);
  const raw = blueprint?.components?.sandbox?.resource_profiles;
  if (!raw || typeof raw !== "object") return {};
  const profiles: Record<string, ResourceProfile> = {};
  for (const [name, p] of Object.entries(raw)) {
    const prof = p as Record<string, unknown>;
    const profile = normalizeResourceProfile(prof);
    if (profile) profiles[name] = profile;
  }
  return profiles;
}

// ── Types ────────────────────────────────────────────────────────

export interface ResourceProfile {
  cpu: string;
  memory: string;
}

export interface HardwareResources {
  cpu: { cores: number; model: string; allocatable?: string };
  memory: { totalMB: number; swapMB: number; allocatableMB?: number };
  gpu: { type: string; name: string; count: number; vramMB: number } | null;
  profiles: Record<string, ResourceProfile> | null;
}

// ── Implementation ───────────────────────────────────────────────

/**
 * Query system hardware resources. Returns CPU, memory, and GPU info.
 * Also attempts to read Kubernetes node allocatable capacity from the
 * gateway's k3s cluster (returns undefined fields if gateway is not running).
 */
export function getHardwareResources(): HardwareResources {
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model?.trim() || "unknown";

  let totalMB = 0;
  let swapMB = 0;
  try {
    const meminfo = execSync("cat /proc/meminfo", {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const totalMatch = meminfo.match(/MemTotal:\s+(\d+)/);
    const swapMatch = meminfo.match(/SwapTotal:\s+(\d+)/);
    if (totalMatch) totalMB = Math.round(parseInt(totalMatch[1], 10) / 1024);
    if (swapMatch) swapMB = Math.round(parseInt(swapMatch[1], 10) / 1024);
  } catch {
    // Non-Linux or /proc unreadable — fall back to os.totalmem()
    totalMB = Math.round(os.totalmem() / 1024 / 1024);
  }

  // Kubernetes allocatable (best-effort — only works if gateway is running)
  let allocatableCpu: string | undefined;
  let allocatableMemMB: number | undefined;
  try {
    const container = getGatewayContainer();
    const result = dockerSpawnSync(["exec", container, "kubectl", "get", "nodes", "-o", "json"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0 && result.stdout) {
      const nodes = JSON.parse(String(result.stdout));
      const alloc = nodes.items?.[0]?.status?.allocatable;
      if (alloc) {
        allocatableCpu = alloc.cpu;
        const memStr: string = alloc.memory || "";
        const kiMatch = memStr.match(/^(\d+)Ki$/);
        if (kiMatch) allocatableMemMB = Math.round(parseInt(kiMatch[1], 10) / 1024);
      }
    }
  } catch {
    // Gateway not running — skip k8s allocatable
  }

  // GPU detection via nvidia-smi
  let gpu: HardwareResources["gpu"] = null;
  try {
    const nvOut = execSync(
      "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
      { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (nvOut) {
      const lines = nvOut.split("\n").filter(Boolean);
      const [name, vramStr] = lines[0].split(",").map((s: string) => s.trim());
      gpu = {
        type: "nvidia",
        name: name || "unknown",
        count: lines.length,
        vramMB: parseInt(vramStr, 10) || 0,
      };
    }
  } catch {
    // nvidia-smi not available
  }

  // Resource profiles from blueprint.yaml (CPU/RAM only)
  let profiles: Record<string, ResourceProfile> | null = null;
  try {
    const parsedProfiles = parseResourceProfilesFromBlueprint(getBlueprintPath());
    profiles = Object.keys(parsedProfiles).length > 0 ? parsedProfiles : null;
  } catch {
    // blueprint.yaml missing or unparseable — skip profiles
  }

  return {
    cpu: { cores: cpus.length, model: cpuModel, allocatable: allocatableCpu },
    memory: { totalMB, swapMB, allocatableMB: allocatableMemMB },
    gpu,
    profiles,
  };
}

/**
 * Print hardware resources. JSON mode writes to stdout for machine parsing.
 * Human mode writes a formatted table to stdout via console.log.
 */
export function printHardwareResources(json: boolean): HardwareResources {
  const hw = getHardwareResources();
  if (json) {
    process.stdout.write(JSON.stringify(hw) + "\n");
    return hw;
  }
  console.log("");
  console.log("  Hardware Resources");
  console.log("  " + "\u2500".repeat(44));
  console.log(`  CPU:       ${hw.cpu.cores} cores (${hw.cpu.model})`);
  if (hw.cpu.allocatable) {
    console.log(`             k8s allocatable: ${hw.cpu.allocatable}`);
  }
  console.log(`  RAM:       ${hw.memory.totalMB} MB + ${hw.memory.swapMB} MB swap`);
  if (hw.memory.allocatableMB) {
    console.log(`             k8s allocatable: ${hw.memory.allocatableMB} MB`);
  }
  if (hw.gpu) {
    console.log(`  GPU:       ${hw.gpu.name}`);
    console.log(
      `  VRAM:      ${hw.gpu.vramMB} MB (${hw.gpu.count} device${hw.gpu.count > 1 ? "s" : ""})`,
    );
  } else {
    console.log("  GPU:       not detected");
  }
  if (hw.profiles && Object.keys(hw.profiles).length > 0) {
    console.log("");
    console.log("  Resource Profiles:");
    for (const [name, p] of Object.entries(hw.profiles)) {
      const resolved = resolveProfile(p, hw);
      const cpuStr = p.cpu.endsWith("%")
        ? `${p.cpu} \u2192 ${resolved.cpu} cores`
        : `${p.cpu} cores`;
      const ramStr = p.memory.endsWith("%") ? `${p.memory} \u2192 ${resolved.memory}` : p.memory;
      console.log(`    ${name}: cpu=${cpuStr}, ram=${ramStr}`);
    }
  }
  console.log("  " + "\u2500".repeat(44));
  console.log("");
  return hw;
}

/**
 * Resolve a resource value that may be a percentage or absolute quantity.
 * Throws on invalid percentages so callers can surface clear errors.
 */
export function resolveResourceValue(value: string, total: number, unit: "cpu" | "memory"): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    // Strict validation: only accept integers 1-100 followed by %
    if (!/^(?:[1-9]\d?|100)%$/.test(trimmed)) {
      throw new Error(`Invalid percentage '${trimmed}': must be an integer between 1% and 100%`);
    }
    const pct = parseInt(trimmed.slice(0, -1), 10);
    if (unit === "cpu") {
      const milliCores = Math.max(1, Math.floor((total * 1000 * pct) / 100));
      return milliCores % 1000 === 0 ? String(milliCores / 1000) : `${milliCores}m`;
    }
    // Memory: use Mi for precision on smaller machines, Gi for larger
    const resultMB = Math.floor((total * pct) / 100);
    if (resultMB < 4096) {
      return `${Math.max(128, resultMB)}Mi`;
    }
    const resultGi = Math.max(1, Math.floor(resultMB / 1024));
    return `${resultGi}Gi`;
  }
  // Absolute value — pass through as-is
  return trimmed;
}

/**
 * Parse a Kubernetes CPU quantity.
 * Handles plain quantities ("16", "3.5") and millicores ("7500m" -> 7.5).
 */
function parseCpuQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.endsWith("m")) {
    const millis = parseInt(trimmed.slice(0, -1), 10);
    if (isNaN(millis)) return null;
    return millis / 1000;
  }
  const cores = parseFloat(trimmed);
  return isNaN(cores) ? null : cores;
}

/**
 * Resolve profile percentages to absolutes. Prefers k8s allocatable capacity
 * when available (accounts for kubelet/system reservations); falls back to
 * host totals when gateway is not running.
 */
export function resolveProfile(profile: ResourceProfile, hw: HardwareResources): ResourceProfile {
  const cpuTotal = hw.cpu.allocatable
    ? (parseCpuQuantity(hw.cpu.allocatable) ?? hw.cpu.cores)
    : hw.cpu.cores;
  const memTotalMB = hw.memory.allocatableMB ?? hw.memory.totalMB;
  return {
    cpu: resolveResourceValue(profile.cpu, cpuTotal, "cpu"),
    memory: resolveResourceValue(profile.memory, memTotalMB, "memory"),
  };
}

/**
 * Append resource flags to an openshell sandbox create args array.
 * Resolves percentage values against detected hardware before passing.
 * Gracefully degrades: checks `openshell sandbox create --help` for flag
 * support and skips silently if the installed OpenShell doesn't have them.
 */
export function appendResourceFlags(
  args: string[],
  profile: ResourceProfile,
  openshellBinary = "openshell",
): boolean {
  try {
    const result = spawnSync(openshellBinary, ["sandbox", "create", "--help"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const help = result.stdout || "";
    const hasFlag = (name: string) => new RegExp(`(^|\\s)--${name}(\\s|,|$)`).test(help);
    if (result.status !== 0 || !hasFlag("cpu") || !hasFlag("memory")) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    const hw = getHardwareResources();
    const resolved = resolveProfile(profile, hw);
    if (resolved.cpu) args.push("--cpu", resolved.cpu);
    if (resolved.memory) args.push("--memory", resolved.memory);
    return true;
  } catch {
    return false;
  }
}

function normalizeResourceProfile(prof: Record<string, unknown>): ResourceProfile | null {
  const cpu = prof.cpu;
  const memory = prof.memory;
  if (!cpu || !memory) return null;
  return {
    cpu: String(cpu),
    memory: String(memory),
  };
}

/**
 * Load resource profiles from blueprint.yaml. Returns empty object if
 * the file doesn't exist or has no profiles section.
 */
export function loadResourceProfiles(): Record<string, ResourceProfile> {
  try {
    return parseResourceProfilesFromBlueprint(getBlueprintPath());
  } catch {
    return {};
  }
}

/**
 * Dispatcher for the `nemoclaw resources` command.
 */
export function runResourcesCommand(argv: string[]): void {
  const json = argv.includes("--json");
  printHardwareResources(json);
}
