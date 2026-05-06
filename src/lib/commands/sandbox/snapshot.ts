// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command } from "@oclif/core";

import { getSnapshotRuntimeBridge, sandboxNameArg } from "./snapshot/common";

export default class SnapshotCommand extends Command {
  static id = "sandbox:snapshot";
  static strict = true;
  static summary = "Show snapshot usage";
  static description = "Show snapshot usage for create, list, and restore subcommands.";
  static usage = ["<name> snapshot <create|list|restore>"];
  static examples = [
    "<%= config.bin %> alpha snapshot create",
    "<%= config.bin %> alpha snapshot list",
    "<%= config.bin %> alpha snapshot restore",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(SnapshotCommand);
    await getSnapshotRuntimeBridge().sandboxSnapshot(args.sandboxName, []);
  }
}
