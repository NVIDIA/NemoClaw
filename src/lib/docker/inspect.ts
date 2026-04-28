// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture, dockerRun, type DockerCaptureOptions, type DockerRunOptions } from "./run";

export function dockerInspect(args: readonly string[], opts: DockerRunOptions = {}) {
  return dockerRun(["inspect", ...args], opts);
}

export function dockerInspectFormat(
  format: string,
  target: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["inspect", "--format", format, target], opts);
}

export function dockerImageInspect(
  target: string,
  opts: DockerRunOptions = {},
) {
  return dockerRun(["image", "inspect", target], opts);
}

export function dockerImageInspectFormat(
  format: string,
  target: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["image", "inspect", "--format", format, target], opts);
}

export function dockerContainerInspectFormat(
  format: string,
  containerName: string,
  opts: DockerCaptureOptions = {},
): string {
  return dockerCapture(["inspect", "--type", "container", "--format", format, containerName], opts);
}
