// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { getSnapshotRuntimeBridge, sandboxNameArg } from "./common";

export default class SnapshotListCommand extends Command {
  static id = "sandbox:snapshot:list";
  static strict = true;
  static summary = "List available snapshots";
  static description = "List available snapshots for a sandbox.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox snapshot list alpha"];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SnapshotListCommand);
    await getSnapshotRuntimeBridge().sandboxSnapshot(args.sandboxName, ["list"]);
  }
}
