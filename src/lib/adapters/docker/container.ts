// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun, type DockerCaptureOptions, type DockerRunOptions } from "./run";

export function dockerStop(containerName: string, opts: DockerRunOptions = {}) {
  return dockerRun(["stop", containerName], opts);
}

// NIM (and most Python services) write errors to stderr, so a stdout-only
// capture would silently lose the auth-error tail. Use dockerRun so we can
// read both streams from the SpawnResult and concatenate them. Bounded by a
// short timeout — callers (e.g. waitForNimHealth's fast-fail) rely on this
// not blocking when the Docker daemon is unresponsive.
const DOCKER_LOGS_DEFAULT_TIMEOUT_MS = 5000;

export function dockerLogs(
  containerName: string,
  { tail = 30, timeout = DOCKER_LOGS_DEFAULT_TIMEOUT_MS }: { tail?: number; timeout?: number } = {},
): string {
  const result = dockerRun(["logs", "--tail", String(tail), containerName], {
    ignoreError: true,
    suppressOutput: true,
    timeout,
  });
  const stdout = result?.stdout ? result.stdout.toString("utf-8") : "";
  const stderr = result?.stderr ? result.stderr.toString("utf-8") : "";
  return `${stdout}${stderr}`.trim();
}

export function dockerRm(containerName: string, opts: DockerRunOptions = {}) {
  return dockerRun(["rm", containerName], opts);
}

export function dockerForceRm(containerName: string, opts: DockerRunOptions = {}) {
  return dockerRun(["rm", "-f", containerName], opts);
}

export function dockerRename(
  oldContainerName: string,
  newContainerName: string,
  opts: DockerRunOptions = {},
) {
  return dockerRun(["rename", oldContainerName, newContainerName], opts);
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
