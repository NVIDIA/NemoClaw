// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { quietFlag } from "../../../lib/cli/common-flags";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import { GatewayTokenCommandError, runGatewayTokenCommand } from "../../../lib/gateway-token-command";

type GatewayTokenRuntimeBridge = {
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
  getSandboxAgent: (sandboxName: string) => string | null;
};

let runtimeBridgeFactory = (): GatewayTokenRuntimeBridge => {
  const onboard = require("../../../lib/onboard") as Pick<
    GatewayTokenRuntimeBridge,
    "fetchGatewayAuthTokenFromSandbox"
  >;
  const registry = require("../../../lib/state/registry") as {
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

export default class GatewayTokenCliCommand extends NemoClawCommand {
  static id = "sandbox:gateway:token";
  static strict = true;
  static summary = "Print the OpenClaw gateway auth token to stdout";
  static description = "Print the OpenClaw gateway auth token for a running sandbox to stdout.";
  static usage = ["<name> [--quiet|-q]"];
  static examples = [
    "<%= config.bin %> sandbox gateway token alpha",
    "<%= config.bin %> sandbox gateway token alpha --quiet",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    quiet: quietFlag("Suppress the stderr security warning"),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(GatewayTokenCliCommand);
    // Suppress EPIPE traces when the consumer closes the pipe early
    // (e.g. `... | head -c 0`). The token has already been written.
    process.stdout.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        this.setExitCode(0);
        return;
      }
      throw err;
    });

    const runtime = getRuntimeBridge();
    try {
      runGatewayTokenCommand(
        args.sandboxName,
        { quiet: flags.quiet === true },
        {
          fetchToken: runtime.fetchGatewayAuthTokenFromSandbox,
          getSandboxAgent: runtime.getSandboxAgent,
        },
      );
      // CodeRabbit #3182: if a prior run() left process.exitCode = 1, a later
      // successful invocation must still report success. Always overwrite.
      this.setExitCode(0);
    } catch (error) {
      if (error instanceof GatewayTokenCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
