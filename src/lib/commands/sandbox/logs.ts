// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { logsSinceDurationFlag } from "../../duration-flags";
import type { SandboxLogsOptions } from "../../domain/sandbox/log-options";
import { DEFAULT_SANDBOX_LOG_LINES } from "../../domain/sandbox/log-options";
import { showSandboxLogs } from "../../actions/sandbox/runtime";

type SandboxLogsRuntimeBridge = {
  sandboxLogs: (sandboxName: string, options: SandboxLogsOptions) => void;
};

const DEFAULT_SANDBOX_LOG_LINE_COUNT = Number(DEFAULT_SANDBOX_LOG_LINES);

let runtimeBridgeFactory = (): SandboxLogsRuntimeBridge => ({ sandboxLogs: showSandboxLogs });

export function setSandboxLogsRuntimeBridgeFactoryForTest(
  factory: () => SandboxLogsRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge() {
  return runtimeBridgeFactory();
}

export default class SandboxLogsCommand extends Command {
  static id = "sandbox:logs";
  static strict = true;
  static summary = "Stream sandbox logs";
  static description = "Show OpenClaw gateway logs and OpenShell audit logs for a sandbox.";
  static usage = ["<name> [--follow] [--tail <lines>|-n <lines>] [--since <duration>]"];
  static examples = [
    "<%= config.bin %> sandbox logs alpha",
    "<%= config.bin %> sandbox logs alpha --tail 100",
    "<%= config.bin %> sandbox logs alpha --since 5m",
    "<%= config.bin %> sandbox logs alpha --follow",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    follow: Flags.boolean({ description: "Follow logs until interrupted" }),
    tail: Flags.integer({
      char: "n",
      default: DEFAULT_SANDBOX_LOG_LINE_COUNT,
      description: "Number of log lines to return",
      min: 1,
    }),
    since: logsSinceDurationFlag({
      description: "Only show logs from this duration ago, such as 5m, 1h, or 30s",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxLogsCommand);
    getRuntimeBridge().sandboxLogs(args.sandboxName, {
      follow: flags.follow === true,
      lines: String(flags.tail),
      since: flags.since ?? null,
    });
  }
}
