// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "child_process";
import * as registry from "./registry";
import type { SandboxEntry } from "./registry";

export interface ContainerStat {
  id: string;
  name: string;
  cpuPercent: number;
  memUsage: string;
  memPercent: number;
  netIO: string;
  blockIO: string;
}

export interface ContainerStats {
  runtime: "docker" | "podman" | null;
  containers: ContainerStat[];
}

export type SandboxWithContainer = SandboxEntry & { container: ContainerStat | null };

export interface SandboxList {
  runtime: "docker" | "podman" | null;
  defaultSandbox: string | null;
  sandboxes: SandboxWithContainer[];
}

export function parsePercent(str: unknown): number {
  const n = parseFloat(String(str));
  return isNaN(n) ? 0 : n;
}

export function parseDockerStats(stdout: string): ContainerStat[] {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line): ContainerStat | null => {
      try {
        const raw = JSON.parse(line);
        return {
          id: raw.ID || raw.id || "",
          name: raw.Name || raw.name || "",
          cpuPercent: parsePercent(raw.CPUPerc),
          memUsage: raw.MemUsage || "",
          memPercent: parsePercent(raw.MemPerc),
          netIO: raw.NetIO || "",
          blockIO: raw.BlockIO || "",
        };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ContainerStat => entry !== null);
}

export function parsePodmanStats(stdout: string): ContainerStat[] {
  try {
    const raw = JSON.parse(stdout);
    if (!Array.isArray(raw)) return [];
    return raw.map((entry) => ({
      id: entry.id || "",
      name: entry.name || "",
      cpuPercent: parsePercent(entry.cpu_percent || entry.CPUPerc),
      memUsage: entry.mem_usage || entry.MemUsage || "",
      memPercent: parsePercent(entry.mem_percent || entry.MemPerc),
      netIO: entry.net_io || entry.NetIO || "",
      blockIO: entry.block_io || entry.BlockIO || "",
    }));
  } catch {
    return [];
  }
}

export function getContainerStats(): ContainerStats {
  const docker = spawnSync("docker", ["stats", "--no-stream", "--format", "{{json .}}"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (docker.status === 0 && docker.stdout.trim()) {
    return { runtime: "docker", containers: parseDockerStats(docker.stdout) };
  }

  const podman = spawnSync("podman", ["stats", "--no-stream", "--format", "json"], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (podman.status === 0 && podman.stdout.trim()) {
    return { runtime: "podman", containers: parsePodmanStats(podman.stdout) };
  }

  return { runtime: null, containers: [] };
}

export function getSandboxList(): SandboxList {
  const { sandboxes, defaultSandbox } = registry.listSandboxes();
  const { runtime, containers } = getContainerStats();

  return {
    runtime,
    defaultSandbox,
    sandboxes: sandboxes.map((sandbox) => ({
      ...sandbox,
      container: containers.find((c) => c.name === sandbox.name) ?? null,
    })),
  };
}
