// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- thin oclif adapter covered through CLI integration tests. */

import { Args, Command, Flags } from "@oclif/core";

import { runGatewayTokenCommand } from "./gateway-token-command";

const { fetchGatewayAuthTokenFromSandbox } = require("./onboard") as {
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
};

export default class GatewayTokenCliCommand extends Command {
  static id = "sandbox:gateway-token";
  static strict = true;
  static summary = "Print the OpenClaw gateway auth token to stdout";
  static description = "Print the OpenClaw gateway auth token for a running sandbox to stdout.";
  static usage = ["<name> gateway-token [--quiet|-q]"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    help: Flags.help({ char: "h" }),
    quiet: Flags.boolean({ char: "q", description: "Suppress the stderr security warning" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayTokenCliCommand);
    // Suppress EPIPE traces when the consumer closes the pipe early
    // (e.g. `... | head -c 0`). The token has already been written.
    process.stdout.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") process.exit(0);
    });

    const exitCode = runGatewayTokenCommand(
      args.sandboxName,
      { quiet: flags.quiet === true },
      { fetchToken: fetchGatewayAuthTokenFromSandbox },
    );
    if (exitCode !== 0) this.exit(exitCode);
  }
}
