// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { stopSandbox } from "../../lib/actions/sandbox/stop";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxStopCommand extends NemoClawCommand {
  static id = "sandbox:stop";
  static strict = true;
  static summary = "Stop the sandbox container, preserving workspace state";
  static description =
    "Stop a sandbox's Docker container without deleting anything. Workspace files, credentials, and the registry entry are preserved; restart later with 'start'. Use 'destroy' to delete the sandbox instead.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox stop alpha"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStopCommand);
    this.applyExitResult(await stopSandbox(args.sandboxName));
  }
}
