// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ShellProbeResult, ShellProbeRunOptions } from "../shell-probe.ts";
import { assertExitZero, type CommandRunner } from "./command.ts";

export class ProviderClient {
  private readonly runner: CommandRunner;

  constructor(runner: CommandRunner) {
    this.runner = runner;
  }

  curl(args: string[], options: ShellProbeRunOptions = {}): Promise<ShellProbeResult> {
    return this.runner.run("curl", {
      artifactName: `curl-${args[args.length - 1] ?? "request"}`,
      ...options,
      args,
    });
  }

  async getJson<T = unknown>(url: string, options: ShellProbeRunOptions = {}): Promise<T> {
    const result = await this.curl(["-fsSL", url], options);
    assertExitZero(result, `curl ${url}`);
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`provider response was not JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
