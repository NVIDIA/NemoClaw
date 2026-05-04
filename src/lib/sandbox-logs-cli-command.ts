// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif wrapper covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import type { SandboxLogsOptions } from "./sandbox-logs-options";
import { DEFAULT_SANDBOX_LOG_LINES } from "./sandbox-logs-options";
import { showSandboxLogs } from "./sandbox-runtime-actions";

type SandboxLogsRuntimeBridge = {
  sandboxLogs: (sandboxName: string, options: SandboxLogsOptions) => void;
};

const LOGS_SINCE_DURATION_RE = /^[1-9]\d*(?:ms|s|m|h|d)$/i;
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
  static usage = ["<name> logs [--follow] [--tail <lines>|-n <lines>] [--since <duration>]"];
  static examples = [
    "<%= config.bin %> alpha logs",
    "<%= config.bin %> alpha logs --tail 100",
    "<%= config.bin %> alpha logs --since 5m",
    "<%= config.bin %> alpha logs --follow",
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
    since: Flags.string({
      description: "Only show logs from this duration ago, such as 5m, 1h, or 30s",
    }),
  };

  private normalizeSinceDuration(since: string | undefined): string | null {
    if (since === undefined) {
      return null;
    }
    const trimmed = since.trim();
    if (!LOGS_SINCE_DURATION_RE.test(trimmed)) {
      this.error("--since requires a positive duration like 5m, 1h, or 30s", { exit: 2 });
    }
    return trimmed;
  }

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxLogsCommand);
    getRuntimeBridge().sandboxLogs(args.sandboxName, {
      follow: flags.follow === true,
      lines: String(flags.tail),
      since: this.normalizeSinceDuration(flags.since),
    });
  }
}
