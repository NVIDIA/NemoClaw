// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun, type DockerCaptureOptions, type DockerRunOptions } from "./run";

export function dockerStop(containerName: string, opts: DockerRunOptions = {}) {
  return dockerRun(["stop", containerName], opts);
}

export function dockerRm(containerName: string, opts: DockerRunOptions = {}) {
  return dockerRun(["rm", containerName], opts);
}

export function dockerForceRm(containerName: string, opts: DockerRunOptions = {}) {
  return dockerRun(["rm", "-f", containerName], opts);
}

export function dockerRunDetached(args: readonly string[], opts: DockerRunOptions = {}) {
  return dockerRun(["run", "-d", ...args], opts);
}

export function dockerPort(
  containerName: string,
  containerPort: string | number,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["port", containerName, String(containerPort)], opts);
}

export function dockerExecArgv(containerName: string, cmd: readonly string[]): string[] {
  return ["docker", "exec", containerName, ...cmd];
}
