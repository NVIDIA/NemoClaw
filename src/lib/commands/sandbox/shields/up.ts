// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Command, Flags } from "@oclif/core";

import * as shields from "../../../shields";
import { sandboxNameArg } from "../common";

export default class ShieldsUpCommand extends Command {
  static id = "sandbox:shields:up";
  static hidden = true;
  static strict = true;
  static summary = "Raise sandbox security shields";
  static description = "Restore sandbox shields from the saved snapshot.";
  static usage = ["<name>"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsUpCommand);
    shields.shieldsUp(args.sandboxName);
  }
}
