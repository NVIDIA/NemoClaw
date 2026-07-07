// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../shell-probe.ts";

export { shellQuote } from "../../../../src/lib/core/shell-quote.ts";

export interface CommandRunner {
  run(command: TrustedShellCommand, options?: ShellProbeRunOptions): Promise<ShellProbeResult>;
}

export interface CommandResultText {
  stdout: string;
  stderr: string;
}

export interface CommandExitResult extends CommandResultText {
  exitCode: number | null;
  signal?: NodeJS.Signals | null;
}

export function resultText(result: CommandResultText): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

export function outputContainsSandbox(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
  sandboxName: string,
): boolean {
  const escaped = sandboxName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|\\s)${escaped}(\\s|$)`, "m").test(resultText(result));
}

export function outputContainsReadySandbox(
  result: Pick<ShellProbeResult, "stdout" | "stderr">,
  sandboxName: string,
): boolean {
  return resultText(result)
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const [name] = trimmed.split(/\s+/);
      return name === sandboxName && /\bReady\b/i.test(trimmed);
    });
}

export function assertExitZero(result: CommandExitResult, label: string): void {
  if (result.exitCode === 0) return;
  const fallback = result.signal
    ? `signal=${result.signal}`
    : `exit=${result.exitCode ?? "unknown"}`;
  const detail = resultText(result).trim() || fallback;
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
