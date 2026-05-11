// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { runShareMount } from "../../../share-command";
import { sandboxNameArg } from "../common";

export default class ShareMountCommand extends Command {
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
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShareMountCommand);
    await runShareMount({
      sandboxName: args.sandboxName,
      remotePath: args.sandboxPath,
      localMount: args.localMountPoint,
    });
  }
}
