// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { runShareStatus } from "../../../share-command";
import { sandboxNameArg } from "../common";

export default class ShareStatusCommand extends Command {
  static id = "sandbox:share:status";
  static strict = true;
  static summary = "Show sandbox share mount status";
  static description = "Check whether a sandbox filesystem share is currently mounted on the host.";
  static usage = ["<name> [local-mount-point]"];
  static examples = [
    "<%= config.bin %> sandbox share status alpha",
    "<%= config.bin %> sandbox share status alpha ~/mnt/alpha",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    localMountPoint: Args.string({
      name: "local-mount-point",
      description: "Host mount path to check",
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShareStatusCommand);
    runShareStatus({ sandboxName: args.sandboxName, localMount: args.localMountPoint });
  }
}
