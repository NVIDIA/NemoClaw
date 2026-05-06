// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { runGatewayTokenCommand } from "../gateway-token-command";

type GatewayTokenRuntimeBridge = {
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
};

/* v8 ignore next -- source tests inject this bridge; CLI subprocess tests cover the real onboard module. */
let runtimeBridgeFactory = (): GatewayTokenRuntimeBridge => {
  const onboard = require("../onboard") as GatewayTokenRuntimeBridge;
  return { fetchGatewayAuthTokenFromSandbox: onboard.fetchGatewayAuthTokenFromSandbox };
};

export function setGatewayTokenRuntimeBridgeFactoryForTest(
  factory: () => GatewayTokenRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): GatewayTokenRuntimeBridge {
  return runtimeBridgeFactory();
}

export default class GatewayTokenCliCommand extends Command {
  static id = "sandbox:gateway:token";
  static strict = true;
  static summary = "Print the OpenClaw gateway auth token to stdout";
  static description = "Print the OpenClaw gateway auth token for a running sandbox to stdout.";
  static usage = ["<name> gateway-token [--quiet|-q]"];
  static examples = [
    "<%= config.bin %> alpha gateway-token",
    "<%= config.bin %> alpha gateway-token --quiet",
  ];
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
    process.stdout.on("error", /* v8 ignore next -- pipe-close behavior is covered by CLI usage. */ (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") process.exit(0);
    });

    const runtime = getRuntimeBridge();
    const exitCode = runGatewayTokenCommand(
      args.sandboxName,
      { quiet: flags.quiet === true },
      { fetchToken: runtime.fetchGatewayAuthTokenFromSandbox },
    );
    if (exitCode !== 0) this.exit(exitCode);
  }
}
