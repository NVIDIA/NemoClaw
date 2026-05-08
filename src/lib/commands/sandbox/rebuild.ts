// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Flags } from "@oclif/core";

import { NemoClawCommand } from "../../cli/nemoclaw-oclif-command";
import { rebuildSandbox } from "../../actions/sandbox/runtime";

export default class RebuildCliCommand extends NemoClawCommand {
  static id = "sandbox:rebuild";
  static strict = true;
  static summary = "Upgrade sandbox to current agent version";
  static description = "Back up, recreate, and restore a sandbox using the current agent image.";
  static usage = ["<name> [--yes|-y|--force] [--verbose|-v]"];
  static examples = [
    "<%= config.bin %> sandbox rebuild alpha",
    "<%= config.bin %> sandbox rebuild alpha --yes --verbose",
  ];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    yes: Flags.boolean({ char: "y", description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
    verbose: Flags.boolean({ char: "v", description: "Show verbose rebuild diagnostics" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RebuildCliCommand);
    await rebuildSandbox(args.sandboxName, {
      force: flags.force === true,
      verbose: flags.verbose === true,
      yes: flags.yes === true,
    });
  }
}
