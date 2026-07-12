// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type DockerCaptureOptions, type DockerRunOptions, dockerCapture, dockerRun } from "./run";

export function dockerInspect(args: readonly string[], opts: DockerRunOptions = {}) {
  return dockerRun(["inspect", ...args], opts);
}

export function dockerImageInspect(target: string, opts: DockerRunOptions = {}) {
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

// Capture `docker manifest inspect <ref>` (registry manifest, not a local image).
// For a multi-arch tag this is the OCI image index JSON; callers parse it to
// resolve a per-arch digest. Returns "" on failure when ignoreError is set.
export function dockerManifestInspect(imageRef: string, opts: DockerCaptureOptions = {}): string {
  return dockerCapture(["manifest", "inspect", imageRef], opts);
}
