// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}

function isJetson(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return false;

  const release = opts.release ?? os.release();
  if (/tegra/i.test(release)) return true;

  const deviceTree = opts.deviceTreeCompatible ?? readFileSafe("/proc/device-tree/compatible");
  if (/nvidia,tegra|nvidia,jetson/i.test(deviceTree)) return true;

  const tegraRelease = opts.nvTegraRelease ?? readFileSafe("/etc/nv_tegra_release");
  return tegraRelease.trim().length > 0;
}

function hasNfTablesNatSupport(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return true;

  const procModules = opts.procModules ?? readFileSafe("/proc/modules");
  return /\bnft_chain_nat\b/.test(procModules);
}

function needsIptablesLegacy(opts = {}) {
  return isJetson(opts) && !hasNfTablesNatSupport(opts);
}

function isWsl(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return false;

  const env = opts.env ?? process.env;
  const release = opts.release ?? os.release();
  const procVersion = opts.procVersion ?? "";

  return (
    Boolean(env.WSL_DISTRO_NAME) ||
    Boolean(env.WSL_INTEROP) ||
    /microsoft/i.test(release) ||
    /microsoft/i.test(procVersion)
  );
}

function inferContainerRuntime(info = "") {
  const normalized = String(info).toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (normalized.includes("podman")) return "podman";
  if (normalized.includes("colima")) return "colima";
  if (normalized.includes("docker desktop")) return "docker-desktop";
  if (normalized.includes("docker")) return "docker";
  return "unknown";
}

function isUnsupportedMacosRuntime(runtime, opts = {}) {
  const platform = opts.platform ?? process.platform;
  return platform === "darwin" && runtime === "podman";
}

function shouldPatchCoredns(runtime) {
  return runtime === "colima";
}

function getColimaDockerSocketCandidates(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  return [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
  ];
}

function findColimaDockerSocket(opts = {}) {
  const existsSync = opts.existsSync ?? require("fs").existsSync;
  return getColimaDockerSocketCandidates(opts).find((socketPath) => existsSync(socketPath)) ?? null;
}

function getDockerSocketCandidates(opts = {}) {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;

  if (platform === "darwin") {
    return [
      ...getColimaDockerSocketCandidates({ home }),
      path.join(home, ".docker/run/docker.sock"),
    ];
  }

  return [];
}

function detectDockerHost(opts = {}) {
  const env = opts.env ?? process.env;
  if (env.DOCKER_HOST) {
    return {
      dockerHost: env.DOCKER_HOST,
      source: "env",
      socketPath: null,
    };
  }

  const existsSync = opts.existsSync ?? require("fs").existsSync;
  for (const socketPath of getDockerSocketCandidates(opts)) {
    if (existsSync(socketPath)) {
      return {
        dockerHost: `unix://${socketPath}`,
        source: "socket",
        socketPath,
      };
    }
  }

  return null;
}

module.exports = {
  detectDockerHost,
  findColimaDockerSocket,
  getColimaDockerSocketCandidates,
  getDockerSocketCandidates,
  hasNfTablesNatSupport,
  inferContainerRuntime,
  isJetson,
  isUnsupportedMacosRuntime,
  isWsl,
  needsIptablesLegacy,
  shouldPatchCoredns,
};
