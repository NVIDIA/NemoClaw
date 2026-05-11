// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { runShareUnmount } from "../../../share-command";
import { sandboxNameArg } from "../common";

export default class ShareUnmountCommand extends Command {
  static id = "sandbox:share:unmount";
  static strict = true;
  static summary = "Unmount a shared sandbox filesystem";
  static description = "Unmount a previously mounted sandbox filesystem from the host.";
  static usage = ["<name> [local-mount-point]"];
  static examples = [
    "<%= config.bin %> sandbox share unmount alpha",
    "<%= config.bin %> sandbox share unmount alpha ~/mnt/alpha",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    localMountPoint: Args.string({
      name: "local-mount-point",
      description: "Host mount path to unmount",
      required: false,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShareUnmountCommand);
    runShareUnmount({ sandboxName: args.sandboxName, localMount: args.localMountPoint });
  }
}
