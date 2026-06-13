// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Trusted command descriptor + NUL-byte guard shared by every E2E
 * TypeScript spawn site.
 *
 * Spec ownership: command shape validation is FIXTURE INFRASTRUCTURE,
 * not a per-helper concern. Whether the spawn site is the fixture layer
 * (ShellProbe), the phase orchestrator (PhaseOrchestrator.runAction /
 * runShellStep), or the probe helpers (spawnBash, runHostCmd, docs /
 * diagnostics probes), they all reach the same single source of truth
 * for "command is trusted" and "no NUL byte sneaks into argv".
 *
 * Build descriptors from constants or typed fixture helpers. Do not
 * pass scenario, manifest, PR, or other untrusted values as the
 * executable command. Put command-specific argument validation in
 * `validate` when arguments include values derived from scenario data.
 */

const trustedShellCommandBrand: unique symbol = Symbol("TrustedShellCommand");

export interface TrustedShellCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly reason: string;
  readonly [trustedShellCommandBrand]: true;
}

export interface TrustedShellCommandInput {
  command: string;
  args?: readonly string[];
  reason: string;
  validate?: (command: string, args: readonly string[]) => void;
}

export function validateShellToken(value: string, label: string): string {
  if (value.includes("\0")) {
    throw new Error(`shell ${label} cannot contain NUL bytes`);
  }
  return value;
}

export function trustedShellCommand(input: TrustedShellCommandInput): TrustedShellCommand {
  const command = validateShellToken(input.command.trim(), "command");
  if (!command) {
    throw new Error("shell command is required");
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("shell trusted command reason is required");
  }
  const args = (input.args ?? []).map((arg) => validateShellToken(arg, "argument"));
  input.validate?.(command, args);
  return {
    command,
    args,
    reason,
    [trustedShellCommandBrand]: true,
  };
}
