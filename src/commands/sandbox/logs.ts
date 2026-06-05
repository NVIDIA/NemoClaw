// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";
import { showSandboxLogs } from "../../lib/actions/sandbox/logs";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

import { logsSinceDurationFlag } from "../../lib/cli/duration-flags";
import { DEFAULT_SANDBOX_LOG_LINES } from "../../lib/domain/sandbox/log-options";

const DEFAULT_SANDBOX_LOG_LINE_COUNT = Number(DEFAULT_SANDBOX_LOG_LINES);

export default class SandboxLogsCommand extends NemoClawCommand {
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
    showSandboxLogs(args.sandboxName, {
      follow: flags.follow === true,
      lines: String(flags.tail),
      since: flags.since ?? null,
    });
  }
}
