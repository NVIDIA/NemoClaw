// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";

export interface CommandRunner {
  run(command: string, options?: ShellProbeRunOptions): Promise<ShellProbeResult>;
}

export function assertExitZero(result: ShellProbeResult, label: string): void {
  if (result.exitCode === 0) return;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit=${result.exitCode}`;
  throw new Error(`${label} failed: ${detail}`);
}
