// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { dockerCapture, type DockerCaptureOptions } from "../../adapters/docker/run";
import { detectWsl } from "../wsl-docker-desktop-gpu";
import { WSL_NVIDIA_CDI_PREPARE_SCRIPT } from "./script";

// Approved candidate range; hardware evidence currently covers Docker Desktop 4.97.0.
// Do not extend this to unreviewed future releases or infer Docker's fixed release.
export const DOCKER_DESKTOP_NVIDIA_CDI_GENERATION_RANGE = {
  minimum: "4.97.0",
  maximum: "4.99.0",
} as const;

type Capture = (args: readonly string[], options?: DockerCaptureOptions) => string;
export type WslNvidiaCdiDeps = {
  dockerCapture?: Capture;
  runCapture?: Capture;
  realpath?: (value: string) => string;
  isWsl?: () => boolean;
  arch?: NodeJS.Architecture;
  env?: NodeJS.ProcessEnv;
};

// WSL host commands receive only the explicit allowlisted environment, never runner defaults.
function captureHostCommand(args: readonly string[], options: DockerCaptureOptions = {}): string {
  const { env, input, timeout, maxBuffer } = options;
  const result = spawnSync(args[0], args.slice(1), {
    env,
    input,
    timeout,
    maxBuffer,
    shell: false,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new Error("WSL CDI host command failed; no retry was attempted.");
  }
  return result.stdout.trim();
}

function versionParts(version: string): number[] {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(version)) {
    throw new Error("A stable Docker Desktop product version is required for CDI preparation.");
  }
  const parts = version.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part)))
    throw new Error("Invalid Desktop version.");
  return parts;
}

function compareVersions(left: number[], right: number[]): number {
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

export function requireWslNvidiaCdiGenerationVersion(desktopName: unknown): void {
  if (typeof desktopName !== "string")
    throw new Error("Docker Desktop product version is unknown; CDI preparation stopped.");
  const match = /^Docker Desktop (\d+\.\d+\.\d+)(?: \(\d+\))?$/u.exec(desktopName);
  if (!match)
    throw new Error("Docker Desktop product version is unknown; CDI preparation stopped.");
  const current = versionParts(match[1]);
  const { minimum, maximum } = DOCKER_DESKTOP_NVIDIA_CDI_GENERATION_RANGE;
  if (compareVersions(current, versionParts(minimum)) < 0) {
    throw new Error(
      `NVIDIA CDI is missing and Docker Desktop ${match[1]} is below the workaround's minimum version. ` +
        `Upgrade Docker Desktop to version ${minimum} through ${maximum} and retry GPU setup.`,
    );
  }
  if (compareVersions(current, versionParts(maximum)) > 0) {
    throw new Error(
      `NVIDIA CDI is missing on Docker Desktop ${match[1]}, outside the workaround range ` +
        `${minimum} through ${maximum}. No CDI file was generated. ` +
        "Report the Docker Desktop version and missing NVIDIA CDI inventory for compatibility review.",
    );
  }
}

type DockerInfo = {
  ID?: unknown;
  OperatingSystem?: unknown;
  Architecture?: unknown;
  DockerRootDir?: unknown;
  DiscoveredDevices?: unknown;
};

function hasNvidiaCdi(info: DockerInfo): boolean {
  if (
    !Array.isArray(info.DiscoveredDevices) ||
    info.DiscoveredDevices.some(
      (device) => !device || typeof device.Source !== "string" || typeof device.ID !== "string",
    )
  ) {
    throw new Error("Docker CDI inventory is unavailable or malformed.");
  }
  return info.DiscoveredDevices.some(
    (device) => device?.Source === "cdi" && device?.ID === "nvidia.com/gpu=all",
  );
}

/** Prepare before both preflight and create, including rebuilds that skip initial onboarding. */
export function prepareWslNvidiaCdi(deps: WslNvidiaCdiDeps = {}): boolean {
  // Other architectures retain the existing compatibility route, without new host prerequisites.
  if ((deps.arch ?? process.arch) !== "arm64") return false;
  if (!(deps.isWsl ?? detectWsl)()) throw new Error("CDI preparation requires a local WSL host.");

  const env = deps.env ?? process.env;
  const capture = deps.dockerCapture ?? dockerCapture;
  const exec = deps.runCapture ?? captureHostCommand;
  const options = { timeout: 30_000, maxBuffer: 1024 * 1024 };
  const context = String(env.DOCKER_CONTEXT ?? "").trim();
  if (context) throw new Error("CDI preparation requires NemoClaw's selected local Docker socket.");
  const endpoint = String(env.DOCKER_HOST ?? "unix:///var/run/docker.sock");
  if (!endpoint.startsWith("unix:///"))
    throw new Error("Remote Docker CDI preparation is not supported.");
  const socket = (deps.realpath ?? fs.realpathSync)(endpoint.slice("unix://".length));
  if (
    ![
      // Desktop 4.97 exposes a distro-local socket here instead of a shared-socket symlink.
      // The daemon-root engine ID is still checked before any CDI write.
      "/run/docker.sock",
      "/mnt/wsl/docker-desktop/shared-sockets/guest-services/docker.sock",
      "/mnt/wsl/docker-desktop/shared-sockets/host-services/docker.proxy.sock",
    ].includes(socket)
  ) {
    throw new Error("Docker socket is not a recognized local Docker Desktop WSL socket.");
  }
  // Pin every probe to the selected endpoint, even if the process environment changes later.
  const docker = (args: readonly string[]) => capture(["--host", endpoint, ...args], options);
  const info = JSON.parse(docker(["info", "--format", "{{json .}}"])) as DockerInfo;
  if (
    info.OperatingSystem !== "Docker Desktop" ||
    info.Architecture !== "aarch64" ||
    info.DockerRootDir !== "/var/lib/docker" ||
    typeof info.ID !== "string" ||
    !/^[a-zA-Z0-9:-]{1,80}$/u.test(info.ID)
  ) {
    throw new Error("CDI preparation requires the expected ARM64 Docker Desktop daemon layout.");
  }
  const hostEnv: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME", "SystemRoot", "WINDIR"]) {
    if (env[key] !== undefined) hostEnv[key] = env[key];
  }
  const mode = exec(["wslinfo", "--networking-mode"], {
    ...options,
    env: hostEnv,
    replaceEnv: true,
  }).trim();
  if (mode !== "nat") {
    throw new Error(
      "WSL GPU CDI preparation requires NAT. Mirrored networking has a separate seccomp listener conflict; no networking setting was changed.",
    );
  }
  // Existing CDI belongs to its current owner, regardless of the installed Desktop version.
  const existing = hasNvidiaCdi(info);
  if (!existing) {
    const platformName = JSON.parse(
      docker(["version", "--format", "{{json .Server.Platform.Name}}"]),
    );
    requireWslNvidiaCdiGenerationVersion(platformName);
  }
  // Discovery can observe an uncommitted writer. Verify its lock even when CDI already exists.
  const result = exec(
    [
      "wsl.exe",
      "--distribution",
      "docker-desktop",
      "--user",
      "root",
      "--exec",
      "/bin/sh",
      "-s",
      "--",
      info.ID,
      existing ? "0" : "1",
    ],
    {
      ...options,
      input: WSL_NVIDIA_CDI_PREPARE_SCRIPT,
      env: hostEnv,
      replaceEnv: true,
    },
  ).trim();
  if (!/^(NEMOCLAW_CDI_PREPARED|NEMOCLAW_CDI_EXISTING)$/u.test(result)) {
    throw new Error(
      "CDI preparation was inconclusive. Inspect Docker Desktop's /run/nemoclaw-nvidia-cdi before retrying.",
    );
  }
  const after = JSON.parse(docker(["info", "--format", "{{json .}}"])) as DockerInfo;
  if (after.ID !== info.ID || !hasNvidiaCdi(after)) {
    throw new Error(
      "CDI was prepared but Docker discovery was not confirmed. The managed runtime spec was retained; no sandbox was created.",
    );
  }
  return true;
}
