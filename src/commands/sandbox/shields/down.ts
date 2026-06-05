// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Flags } from "@oclif/core";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { shieldsTimeoutDurationFlag } from "../../../lib/cli/duration-flags";
import * as shields from "../../../lib/shields/index";
import { sandboxNameArg } from "../../../lib/sandbox/command-support";

export default class ShieldsDownCommand extends NemoClawCommand {
  static id = "sandbox:shields:down";
  static hidden = true;
  static strict = true;
  static summary = "Lower sandbox security shields";
  static description = "Temporarily lower sandbox shields.";
  static usage = ["<name> [--timeout 5m] [--reason <text>] [--policy permissive]"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
    timeout: shieldsTimeoutDurationFlag({ description: "Duration before shields are restored" }),
    reason: Flags.string({ description: "Reason for lowering shields" }),
    policy: Flags.string({ description: "Policy to apply while shields are down" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ShieldsDownCommand);
    shields.shieldsDown(args.sandboxName, {
      timeout: flags.timeout ?? null,
      reason: flags.reason ?? null,
      policy: flags.policy ?? "permissive",
    });
  }
}
