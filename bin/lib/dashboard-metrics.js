// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const { spawnSync } = require("child_process");
const registry = require("./registry");

function parsePercent(str) {
  const n = parseFloat(str);
  return isNaN(n) ? 0 : n;
}

function parseDockerStats(stdout) {
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
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
    .filter(Boolean);
}

function parsePodmanStats(stdout) {
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

function getContainerStats() {
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

function getSandboxList() {
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

module.exports = { getContainerStats, getSandboxList, parseDockerStats, parsePodmanStats, parsePercent };
