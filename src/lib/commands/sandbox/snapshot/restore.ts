// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { getSnapshotRuntimeBridge, sandboxNameArg } from "./common";

export default class SnapshotRestoreCommand extends Command {
  static id = "sandbox:snapshot:restore";
  static strict = true;
  static summary = "Restore state from a snapshot";
  static description = "Restore sandbox workspace state from a snapshot.";
  static usage = ["<name> snapshot restore [selector] [--to <dst>]"];
  static examples = [
    "<%= config.bin %> alpha snapshot restore",
    "<%= config.bin %> alpha snapshot restore v2",
    "<%= config.bin %> alpha snapshot restore before-upgrade --to beta",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    selector: Args.string({
      name: "selector",
      description: "Snapshot version, name, or timestamp",
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    to: Flags.string({ description: "Restore into another sandbox" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(SnapshotRestoreCommand);
    const subArgs = ["restore"];
    if (args.selector) subArgs.push(args.selector);
    if (flags.to) subArgs.push("--to", flags.to);
    await getSnapshotRuntimeBridge().sandboxSnapshot(args.sandboxName, subArgs);
  }
}
