// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapters covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import * as shields from "./shields";

const sandboxNameArg = Args.string({
  name: "sandbox",
  description: "Sandbox name",
  required: true,
});

export class ShieldsDownCommand extends Command {
  static id = "sandbox:shields:down";
  static hidden = true;
  static strict = true;
  static summary = "Lower sandbox security shields";
  static description = "Temporarily lower sandbox shields.";
  static usage = ["<name> shields down [--timeout 5m] [--reason <text>] [--policy permissive]"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
    help: Flags.help({ char: "h" }),
    timeout: Flags.string({ description: "Duration before shields are restored" }),
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

export class ShieldsUpCommand extends Command {
  static id = "sandbox:shields:up";
  static hidden = true;
  static strict = true;
  static summary = "Raise sandbox security shields";
  static description = "Restore sandbox shields from the saved snapshot.";
  static usage = ["<name> shields up"];
  static args = { sandboxName: sandboxNameArg };
  static flags = {
    help: Flags.help({ char: "h" }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ShieldsUpCommand);
    shields.shieldsUp(args.sandboxName);
  }
}

export class ShieldsStatusCommand extends Command {
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
