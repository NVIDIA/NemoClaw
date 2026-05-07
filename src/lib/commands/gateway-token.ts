// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args, Command, Flags } from "@oclif/core";

import { runGatewayTokenCommand } from "../gateway-token-command";

type GatewayTokenRuntimeBridge = {
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
  getSandboxAgent: (sandboxName: string) => string | null;
};

/* v8 ignore next -- source tests inject this bridge; CLI subprocess tests cover the real onboard module. */
let runtimeBridgeFactory = (): GatewayTokenRuntimeBridge => {
  const onboard = require("../onboard") as Pick<
    GatewayTokenRuntimeBridge,
    "fetchGatewayAuthTokenFromSandbox"
  >;
  const registry = require("../state/registry") as {
    getSandbox: (name: string) => { agent?: string | null } | null;
  };
  return {
    fetchGatewayAuthTokenFromSandbox: onboard.fetchGatewayAuthTokenFromSandbox,
    getSandboxAgent: (sandboxName: string) => {
      try {
        return registry.getSandbox(sandboxName)?.agent ?? null;
      } catch {
        return null;
      }
    },
  };
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
      {
        fetchToken: runtime.fetchGatewayAuthTokenFromSandbox,
        getSandboxAgent: runtime.getSandboxAgent,
      },
    );
    // NCQ #3180: avoid this.exit(code), which throws @oclif/core ExitError.
    // The legacy `nemoclaw <name> gateway-token` dispatch did not catch the
    // throw, leaking a raw JS stack trace to the user. Always assigning
    // process.exitCode keeps the diagnostic output clean and prevents a
    // stale non-zero code from a prior run() in the same process from
    // bleeding through on a successful invocation.
    process.exitCode = exitCode;
  }
}
