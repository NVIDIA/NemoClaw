// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync as defaultExistsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type ContainerRuntime = "podman" | "colima" | "docker-desktop" | "docker" | "unknown";

export interface PlatformLookupOptions {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
}

export interface WslDetectionOptions {
  isWsl?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  procVersion?: string;
}

export interface DockerHostDetectionOptions extends PlatformLookupOptions, WslDetectionOptions {
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
}

export interface DockerHostDetection {
  dockerHost: string;
  source: "env" | "socket";
  socketPath: string | null;
}

function isWsl(opts: WslDetectionOptions = {}): boolean {
  // Explicit override — lets tests pin behavior regardless of the host kernel.
  // Useful because the WSL detection below consults `os.release()`, which
  // returns a "microsoft"-tagged string on WSL2 hosts even when env vars are
  // unset. Without this override, any test calling functions that consult
  // `isWsl()` becomes non-deterministic on WSL2 dev machines.
  if (typeof opts.isWsl === "boolean") return opts.isWsl;

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

function inferContainerRuntime(info = ""): ContainerRuntime {
  const normalized = String(info).toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (normalized.includes("podman")) return "podman";
  if (normalized.includes("colima")) return "colima";
  if (normalized.includes("docker desktop")) return "docker-desktop";
  if (normalized.includes("docker")) return "docker";
  return "unknown";
}

function shouldPatchCoredns(runtime: ContainerRuntime, opts: WslDetectionOptions = {}): boolean {
  // CoreDNS patching is needed for Colima and Podman (both use custom network bridges).
  // On WSL2, the host DNS is not routable from k3s pods — skip and let setup-dns-proxy.sh handle it.
  if (isWsl(opts)) return false;
  return runtime === "colima" || runtime === "podman";
}

function getColimaDockerSocketCandidates(opts: PlatformLookupOptions = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  return [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
  ];
}

function findColimaDockerSocket(
  opts: PlatformLookupOptions & { existsSync?: (filePath: string) => boolean } = {},
): string | null {
  const fileExists = opts.existsSync ?? defaultExistsSync;
  return getColimaDockerSocketCandidates(opts).find((socketPath) => fileExists(socketPath)) ?? null;
}

function getPodmanSocketCandidates(opts: PlatformLookupOptions = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? process.getuid?.() ?? 1000;

  if (platform === "darwin") {
    return [
      path.join(home, ".local/share/containers/podman/machine/podman.sock"),
      "/var/run/docker.sock",
    ];
  }

  if (platform === "linux") {
    return [`/run/user/${String(uid)}/podman/podman.sock`, "/run/podman/podman.sock"];
  }

  return [];
}

function getDockerSocketCandidates(opts: PlatformLookupOptions = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;

  if (platform === "darwin") {
    return [
      ...getColimaDockerSocketCandidates({ home }),
      ...getPodmanSocketCandidates({ home, platform }),
      path.join(home, ".docker/run/docker.sock"),
    ];
  }

  if (platform === "linux") {
    return [
      ...getPodmanSocketCandidates({ home, platform, uid: opts.uid }),
      "/run/docker.sock",
      "/var/run/docker.sock",
    ];
  }

  return [];
}

function detectDockerHost(opts: DockerHostDetectionOptions = {}): DockerHostDetection | null {
  const env = opts.env ?? process.env;
  if (env.DOCKER_HOST) {
    return {
      dockerHost: env.DOCKER_HOST,
      source: "env",
      socketPath: null,
    };
  }

  const fileExists = opts.existsSync ?? defaultExistsSync;
  for (const socketPath of getDockerSocketCandidates(opts)) {
    if (fileExists(socketPath)) {
      return {
        dockerHost: `unix://${socketPath}`,
        source: "socket",
        socketPath,
      };
    }
  }

  return null;
}

export {
  detectDockerHost,
  findColimaDockerSocket,
  getColimaDockerSocketCandidates,
  getDockerSocketCandidates,
  getPodmanSocketCandidates,
  inferContainerRuntime,
  isWsl,
  shouldPatchCoredns,
};
