// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import {
  printShareUsageAndExit,
  runShareMount,
  runShareStatus,
  runShareUnmount,
} from "./share-command";

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export default class ShareCommand extends Command {
  static id = "sandbox:share";
  static strict = true;
  static summary = "Mount/unmount sandbox filesystem on the host via SSHFS";
  static description = "Share files between host and sandbox using SSHFS over OpenShell's SSH proxy.";
  static usage = ["<name> share <mount|unmount|status>"];
  static examples = [
    "<%= config.bin %> alpha share mount",
    "<%= config.bin %> alpha share unmount",
    "<%= config.bin %> alpha share status",
  ];
  static args = {
    sandboxName: sandboxNameArg,
  };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    await this.parse(ShareCommand);
    printShareUsageAndExit(1);
  }
}

export class ShareMountCommand extends Command {
  static id = "sandbox:share:mount";
  static strict = true;
  static summary = "Mount sandbox filesystem on the host";
  static description = "Mount a sandbox path on the host using SSHFS over OpenShell's SSH proxy.";
  static usage = ["<name> share mount [sandbox-path] [local-mount-point]"];
  static examples = [
    "<%= config.bin %> alpha share mount",
    "<%= config.bin %> alpha share mount /workspace ~/mnt/alpha",
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

export class ShareUnmountCommand extends Command {
  static id = "sandbox:share:unmount";
  static strict = true;
  static summary = "Unmount a shared sandbox filesystem";
  static description = "Unmount a previously mounted sandbox filesystem from the host.";
  static usage = ["<name> share unmount [local-mount-point]"];
  static examples = [
    "<%= config.bin %> alpha share unmount",
    "<%= config.bin %> alpha share unmount ~/mnt/alpha",
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

export class ShareStatusCommand extends Command {
  static id = "sandbox:share:status";
  static strict = true;
  static summary = "Show sandbox share mount status";
  static description = "Check whether a sandbox filesystem share is currently mounted on the host.";
  static usage = ["<name> share status [local-mount-point]"];
  static examples = [
    "<%= config.bin %> alpha share status",
    "<%= config.bin %> alpha share status ~/mnt/alpha",
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
