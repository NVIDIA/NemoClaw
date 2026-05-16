// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../../cli/nemoclaw-oclif-command";

import * as shields from "../../../shields";
import { sandboxNameArg } from "../common";

export default class ShieldsStatusCommand extends NemoClawCommand {
  static id = "sandbox:shields:status";
  static hidden = true;
  static strict = true;
  static summary = "Show current shields state";
  static description = "Show current sandbox shields state.";
  static usage = ["<name>"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsStatusCommand);
    shields.shieldsStatus(args.sandboxName);
  }
}
