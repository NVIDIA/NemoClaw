// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { runShareUnmount, ShareCommandError } from "../../../lib/share-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class ShareUnmountCommand extends NemoClawCommand {
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
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShareUnmountCommand);
    try {
      runShareUnmount({ sandboxName: args.sandboxName, localMount: args.localMountPoint });
    } catch (error) {
      if (error instanceof ShareCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
