// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { runShareMount, ShareCommandError } from "../../../lib/share-command";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class ShareMountCommand extends NemoClawCommand {
  static id = "sandbox:share:mount";
  static strict = true;
  static summary = "Mount sandbox filesystem on the host";
  static description = "Mount a sandbox path on the host using SSHFS over OpenShell's SSH proxy.";
  static usage = ["<name> [sandbox-path] [local-mount-point]"];
  static examples = [
    "<%= config.bin %> sandbox share mount alpha",
    "<%= config.bin %> sandbox share mount alpha /workspace ~/mnt/alpha",
  ];
  static args = {
    sandboxName: sandboxNameArg,
    sandboxPath: Args.string({
      name: "sandbox-path",
      description: "Path inside the sandbox to mount",
      required: false,
    }),
    localMountPoint: Args.string({
      name: "local-mount-point",
      description: "Host path for the SSHFS mount",
      required: false,
    }),
  };
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShareMountCommand);
    try {
      await runShareMount({
        sandboxName: args.sandboxName,
        remotePath: args.sandboxPath,
        localMount: args.localMountPoint,
      });
    } catch (error) {
      if (error instanceof ShareCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
