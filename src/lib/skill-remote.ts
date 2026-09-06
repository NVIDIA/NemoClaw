// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { openshellSandboxSshHost } from "./adapters/openshell/sandbox-ssh-host";
import { shellQuote } from "./core/shell-quote";

export { shellQuote };

export interface SshContext {
  configFile: string;
  knownHostsFile?: string;
  sandboxName: string;
}

export interface SshResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Run a command on the sandbox via SSH with optional stdin content.
 * Uses the same SSH flags as executeSandboxCommand in sandbox-process-recovery-action.ts.
 */
export function sshExec(
  ctx: SshContext,
  command: string,
  opts: { acceptNewHostKey?: boolean; input?: string | Buffer; timeout?: number } = {},
): SshResult | null {
  try {
    const hostKeyChecking = ctx.knownHostsFile
      ? opts.acceptNewHostKey
        ? "accept-new"
        : "yes"
      : "no";
    const knownHostsFile = ctx.knownHostsFile ?? "/dev/null";
    const result = spawnSync(
      "ssh",
      [
        "-F",
        ctx.configFile,
        "-o",
        `StrictHostKeyChecking=${hostKeyChecking}`,
        "-o",
        `UserKnownHostsFile=${knownHostsFile}`,
        "-o",
        "ConnectTimeout=10",
        "-o",
        "LogLevel=ERROR",
        openshellSandboxSshHost(ctx.sandboxName),
        command,
      ],
      {
        encoding: "utf-8",
        stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        input: opts.input,
        timeout: opts.timeout ?? 30_000,
      },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  }
}
