// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { rebuildSandbox } from "./sandbox-runtime-actions";

export default class RebuildCliCommand extends Command {
  static id = "sandbox:rebuild";
  static strict = true;
  static summary = "Upgrade sandbox to current agent version";
  static description = "Back up, recreate, and restore a sandbox using the current agent image.";
  static usage = ["<name> rebuild [--yes|--force] [--verbose|-v]"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
    verbose: Flags.boolean({ char: "v", description: "Show verbose rebuild diagnostics" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(RebuildCliCommand);
    const legacyArgs: string[] = [];
    if (flags.yes) legacyArgs.push("--yes");
    if (flags.force) legacyArgs.push("--force");
    if (flags.verbose) legacyArgs.push("--verbose");
    await rebuildSandbox(args.sandboxName, legacyArgs);
  }
}
