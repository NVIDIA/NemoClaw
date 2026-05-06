// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import { printShareUsageAndExit } from "../../share-command";
import { sandboxNameArg } from "./common";

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
