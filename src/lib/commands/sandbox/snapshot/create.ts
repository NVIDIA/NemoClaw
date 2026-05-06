// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { getSnapshotRuntimeBridge, sandboxNameArg } from "./common";

export default class SnapshotCreateCommand extends Command {
  static id = "sandbox:snapshot:create";
  static strict = true;
  static summary = "Create a snapshot of sandbox state";
  static description = "Create an auto-versioned snapshot of sandbox workspace state.";
  static usage = ["<name> snapshot create [--name <label>]"];
  static examples = [
    "<%= config.bin %> alpha snapshot create",
    "<%= config.bin %> alpha snapshot create --name before-upgrade",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    name: Flags.string({ description: "Optional snapshot label" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotCreateCommand);
    const subArgs = ["create"];
    if (flags.name) {
      subArgs.push("--name", flags.name);
    }
    await getSnapshotRuntimeBridge().sandboxSnapshot(args.sandboxName, subArgs);
  }
}
