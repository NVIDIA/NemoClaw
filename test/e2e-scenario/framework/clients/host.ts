// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildAvailabilityProbeEnv } from "../availability-env.ts";
import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { trustedShellCommand } from "../shell-probe.ts";
import { artifactLabel, assertExitZero, type CommandRunner } from "./command.ts";

export interface HostClientOptions {
  cliPath?: string;
  cwd?: string;
}

export class HostCliClient {
  private readonly runner: CommandRunner;
  private readonly cliPath: string;
  private readonly cwd?: string;

  constructor(runner: CommandRunner, options: HostClientOptions = {}) {
    this.runner = runner;
    this.cliPath = options.cliPath ?? process.env.NEMOCLAW_CLI_BIN ?? "nemoclaw";
    this.cwd = options.cwd;
  }

  get commandPath(): string {
    return this.cliPath;
  }

  command(command: string, args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    const merged: ShellProbeRunOptions = { ...options };
    if (this.cwd && !merged.cwd) {
      merged.cwd = this.cwd;
    }
    return this.runner.run(
      trustedShellCommand({
        command,
        args,
        reason: `run host command ${command}`,
      }),
      merged,
    );
  }

  nemoclaw(args: string[] = [], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.command(this.cliPath, args, {
      artifactName: `nemoclaw-${artifactLabel(args.join("-") || "default")}`,
      ...options,
    });
  }

  async expectNemoclawAvailable(): Promise<ShellProbeResult> {
    const result = await this.nemoclaw(["--version"], {
      artifactName: "nemoclaw-version",
      env: buildAvailabilityProbeEnv(),
    });
    assertExitZero(result, "nemoclaw --version");
    return result;
  }
}
