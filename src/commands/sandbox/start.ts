// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import { startSandbox } from "../../lib/actions/sandbox/start";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxStartCommand extends NemoClawCommand {
  static id = "sandbox:start";
  static strict = true;
  static summary = "Restart a stopped sandbox container";
  static description =
    "Start a sandbox container that was stopped with 'stop' (or by a host reboot), then repair the in-sandbox gateway and host forwards the same way 'recover' does.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox start alpha"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(SandboxStartCommand);
    this.applyExitResult(await startSandbox(args.sandboxName));
  }
}
