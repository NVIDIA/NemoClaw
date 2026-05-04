// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { CLI_NAME } from "./branding";
import { connectSandbox } from "./sandbox-runtime-actions";

export default class ConnectCliCommand extends Command {
  static id = "sandbox:connect";
  static strict = true;
  static summary = "Shell into a running sandbox";
  static description = "Connect to a running sandbox.";
  static usage = ["<name> connect [--probe-only]"];
  static args = {
    sandboxName: Args.string({ name: "sandbox", description: "Sandbox name", required: true }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    "probe-only": Flags.boolean({ description: "Recover and check the sandbox without opening SSH" }),
    "dangerously-skip-permissions": Flags.boolean({ hidden: true }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(ConnectCliCommand);
    if (flags["dangerously-skip-permissions"]) {
      console.error("  --dangerously-skip-permissions was removed; use shields commands instead.");
      console.error(`  Usage: ${CLI_NAME} <name> connect [--probe-only]`);
      process.exit(1);
    }
    await connectSandbox(args.sandboxName, {
      probeOnly: Boolean(flags["probe-only"]),
    });
  }
}
