// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import * as shields from "../../../lib/shields/index";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class ShieldsUpCommand extends NemoClawCommand {
  static id = "sandbox:shields:up";
  static hidden = true;
  static strict = true;
  static summary = "Raise sandbox security shields";
  static description = "Restore sandbox shields from the saved snapshot.";
  static usage = ["<name>"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {};

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsUpCommand);
    shields.shieldsUp(args.sandboxName);
  }
}
