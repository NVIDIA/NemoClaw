// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { destroySandbox } from "./sandbox-runtime-actions";

export default class DestroyCliCommand extends Command {
  static id = "sandbox:destroy";
  static strict = true;
  static summary = "Stop NIM and delete sandbox";
  static description = "Destroy a sandbox and remove its local registry entry.";
  static usage = ["<name> destroy [--yes|--force]"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    yes: Flags.boolean({ description: "Skip the confirmation prompt" }),
    force: Flags.boolean({ description: "Skip the confirmation prompt" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DestroyCliCommand);
    const legacyArgs: string[] = [];
    if (flags.yes) legacyArgs.push("--yes");
    if (flags.force) legacyArgs.push("--force");
    await destroySandbox(args.sandboxName, legacyArgs);
  }
}
