// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const os = require("os");
const path = require("path");

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

function shouldPatchCoredns(runtime, opts = {}) {
  // k3s CoreDNS defaults to a loopback DNS that pods can't reach.
  // Patch it to use a real upstream on most Docker-based runtimes.
  // On WSL2, the host DNS is not routable from k3s pods - skip the
  // patch and let setup-dns-proxy.sh handle resolution instead.
  if (isWsl(opts)) return false;
  return runtime !== "unknown";
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
  inferContainerRuntime,
  isUnsupportedMacosRuntime,
  isWsl,
  shouldPatchCoredns,
};
