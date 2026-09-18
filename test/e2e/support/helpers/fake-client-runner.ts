// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CommandRunner } from "../../fixtures/clients/index.ts";
import type {
  ShellProbeResult,
  ShellProbeRunOptions,
  TrustedShellCommand,
} from "../../fixtures/shell-probe.ts";

interface RunnerCall {
  command: string;
  args: string[];
  options?: ShellProbeRunOptions;
}

type FakeRunnerResponse = Partial<
  Pick<ShellProbeResult, "exitCode" | "signal" | "stderr" | "stdout" | "timedOut">
>;

export class FakeRunner implements CommandRunner {
  readonly calls: RunnerCall[] = [];
  readonly responses: FakeRunnerResponse[] = [];
  stdout = "";
  stderr = "";
  exitCode: number | null = 0;
  signal: NodeJS.Signals | null = null;

  enqueue(response: FakeRunnerResponse): void {
    this.responses.push(response);
  }

  async run(
    command: TrustedShellCommand,
    options?: ShellProbeRunOptions,
  ): Promise<ShellProbeResult> {
    this.calls.push({
      command: command.command,
      args: [...command.args],
      options,
    });
    const response = this.responses.shift();
    return {
      command: [command.command, ...command.args],
      exitCode: response?.exitCode === undefined ? this.exitCode : response.exitCode,
      signal: response?.signal === undefined ? this.signal : response.signal,
      timedOut: response?.timedOut ?? false,
      stdout: response?.stdout ?? this.stdout,
      stderr: response?.stderr ?? this.stderr,
      artifacts: {
        stdout: "/tmp/stdout.txt",
        stderr: "/tmp/stderr.txt",
        result: "/tmp/result.json",
      },
    };
  }
}
