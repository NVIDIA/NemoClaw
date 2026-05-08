// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";
import { destroySandbox } from "../../actions/sandbox/runtime";

export default class DestroyCliCommand extends NemoClawCommand {
  static id = "sandbox:destroy";
  static strict = true;
  static summary = "Stop NIM and delete sandbox";
  static description = "Destroy a sandbox and remove its local registry entry.";
  static usage = ["<name> [--yes|-y|--force]"];
  static examples = ["<%= config.bin %> sandbox destroy alpha", "<%= config.bin %> sandbox destroy alpha --yes"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DestroyCliCommand);
    await destroySandbox(args.sandboxName, {
      force: flags.force === true,
      yes: flags.yes === true,
    });
  }
}
