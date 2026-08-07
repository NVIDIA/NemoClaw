// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  dockerArgv as commandDockerArgv,
  dockerCapture as commandDockerCapture,
  dockerRun as commandDockerRun,
  type DockerCaptureOptions,
  type DockerRunOptions,
  type DockerRunResult,
} from "./command";

export type { DockerCaptureOptions, DockerRunOptions, DockerRunResult };

// Keep own exports so CommonJS consumers can replace these functions.
export function dockerArgv(args: readonly string[]): string[] {
  return commandDockerArgv(args);
}

export function dockerRun(args: readonly string[], opts: DockerRunOptions = {}): DockerRunResult {
  return commandDockerRun(args, opts);
}

export function dockerCapture(args: readonly string[], opts: DockerCaptureOptions = {}): string {
  return commandDockerCapture(args, opts);
}
