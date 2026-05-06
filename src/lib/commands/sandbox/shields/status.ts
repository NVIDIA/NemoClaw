// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import * as shields from "../../../shields";
import { sandboxNameArg } from "../common";

export default class ShieldsStatusCommand extends Command {
  static id = "sandbox:shields:status";
  static hidden = true;
  static strict = true;
  static summary = "Show current shields state";
  static description = "Show current sandbox shields state.";
  static usage = ["<name> shields status"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsStatusCommand);
    shields.shieldsStatus(args.sandboxName);
  }
}
