// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { run, runCapture } from "../../runner";

export type DockerRunOptions = Parameters<typeof run>[1];
export type DockerCaptureOptions = Parameters<typeof runCapture>[1];

export function dockerArgv(args: readonly string[]): string[] {
  return ["docker", ...args];
}

export function dockerRun(args: readonly string[], opts: DockerRunOptions = {}) {
  return run(dockerArgv(args), opts);
}

export function dockerCapture(args: readonly string[], opts: DockerCaptureOptions = {}): string {
  return runCapture(dockerArgv(args), opts);
}
