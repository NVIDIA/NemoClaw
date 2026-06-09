// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { artifactLabel, assertExitZero, type CommandRunner } from "./command.ts";

export interface SandboxClientOptions {
  openshellPath?: string;
}

export class SandboxClient {
  private readonly runner: CommandRunner;
  private readonly openshellPath: string;

  constructor(runner: CommandRunner, options: SandboxClientOptions = {}) {
    this.runner = runner;
    this.openshellPath = options.openshellPath ?? process.env.OPENSHELL_BIN ?? "openshell";
  }

  openshell(args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.runner.run(
      trustedShellCommand({
        command: this.openshellPath,
        args,
        reason: "run OpenShell sandbox command",
      }),
      {
        artifactName: `openshell-${artifactLabel(args.join("-") || "default")}`,
        ...options,
      },
    );
  }

  list(): Promise<ShellProbeResult> {
    return this.openshell(["sandbox", "list"], { artifactName: "sandbox-list" });
  }

  status(name: string): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "status", name], { artifactName: `sandbox-status-${name}` });
  }

  exec(name: string, command: string[], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    validateSandboxName(name);
    return this.openshell(["sandbox", "exec", name, "--", ...command], {
      artifactName: `sandbox-exec-${name}`,
      ...options,
    });
  }

  async expectRunning(name: string): Promise<ShellProbeResult> {
    const result = await this.status(name);
    assertExitZero(result, `openshell sandbox status ${name}`);
    return result;
  }
}

export function validateSandboxName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`sandbox name is invalid for fixture client: ${name}`);
  }
}
