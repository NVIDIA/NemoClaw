// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif wrapper covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { showSandboxLogs } from "./sandbox-runtime-actions";

let runtimeBridgeFactory = () => ({ sandboxLogs: showSandboxLogs });

export function setSandboxLogsRuntimeBridgeFactoryForTest(
  factory: () => { sandboxLogs: (sandboxName: string, follow: boolean) => void },
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
  static usage = ["<name> logs [--follow]"];
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
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SandboxLogsCommand);
    getRuntimeBridge().sandboxLogs(args.sandboxName, flags.follow === true);
  }
}
