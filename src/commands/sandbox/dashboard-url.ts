// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import { quietFlag } from "../../lib/cli/common-flags";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";
import {
  DashboardUrlCommandError,
  runDashboardUrlCommand,
} from "../../lib/dashboard-url-command";
import type { SandboxEntry } from "../../lib/state/registry";

type DashboardUrlRuntimeBridge = {
  fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
  getSandbox: (sandboxName: string) => Pick<SandboxEntry, "agent" | "dashboardPort"> | null;
  getAccessUrl?: (port: number) => string | null;
};

let runtimeBridgeFactory = (): DashboardUrlRuntimeBridge => {
  const onboard = require("../../lib/onboard") as Pick<
    DashboardUrlRuntimeBridge,
    "fetchGatewayAuthTokenFromSandbox"
  >;
  const registry = require("../../lib/state/registry") as {
    getSandbox: (name: string) => SandboxEntry | null;
  };
  const dashboardAccess =
    require("../../lib/onboard/dashboard-access") as typeof import("../../lib/onboard/dashboard-access");
  const runner = require("../../lib/runner") as Pick<typeof import("../../lib/runner"), "runCapture">;
  return {
    fetchGatewayAuthTokenFromSandbox: onboard.fetchGatewayAuthTokenFromSandbox,
    getSandbox: (sandboxName: string) => {
      try {
        return registry.getSandbox(sandboxName);
      } catch {
        return null;
      }
    },
    getAccessUrl: (port: number) =>
      dashboardAccess.buildDashboardChain(`http://127.0.0.1:${port}`, {
        runCapture: runner.runCapture,
      }).accessUrl,
  };
};

export function setDashboardUrlRuntimeBridgeFactoryForTest(
  factory: () => DashboardUrlRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): DashboardUrlRuntimeBridge {
  return runtimeBridgeFactory();
}

export default class DashboardUrlCliCommand extends NemoClawCommand {
  static id = "sandbox:dashboard-url";
  static strict = true;
  static summary = "Print the dashboard URL";
  static description = "Print the browser-facing dashboard URL for a running sandbox.";
  static usage = ["<name> [--quiet|-q]"];
  static examples = [
    "<%= config.bin %> sandbox dashboard-url alpha",
    "<%= config.bin %> sandbox dashboard-url alpha --quiet",
  ];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };
  static flags = {
    quiet: quietFlag("Print only the URL"),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(DashboardUrlCliCommand);
    process.stdout.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        this.setExitCode(0);
        return;
      }
      throw err;
    });

    const runtime = getRuntimeBridge();
    try {
      runDashboardUrlCommand(
        args.sandboxName,
        { quiet: flags.quiet === true },
        {
          fetchToken: runtime.fetchGatewayAuthTokenFromSandbox,
          getSandbox: runtime.getSandbox,
          getAccessUrl: runtime.getAccessUrl,
        },
      );
      this.setExitCode(0);
    } catch (error) {
      if (error instanceof DashboardUrlCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
