// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../shell-probe.ts";

export interface CommandRunner {
  run(command: TrustedShellCommand, options?: ShellProbeRunOptions): Promise<ShellProbeResult>;
}

export function resultText(result: Pick<ShellProbeResult, "stdout" | "stderr">): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function outputContainsSandbox(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
  sandboxName: string,
): boolean {
  const escaped = sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "m").test(resultText(result));
}

export function assertExitZero(result: ShellProbeResult, label: string): void {
  if (result.exitCode === 0) return;
  const fallback = result.signal
    ? `signal=${result.signal}`
    : `exit=${result.exitCode ?? "unknown"}`;
  const detail = result.stderr.trim() || result.stdout.trim() || fallback;
  throw new Error(`${label} failed: ${detail}`);
}

export function artifactLabel(raw: string): string {
  const label = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return label || "request";
}
