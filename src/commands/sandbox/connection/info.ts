// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";

import type { AgentDefinition } from "../../../lib/agent/defs";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";
import {
  ConnectionInfoCommandError,
  runConnectionInfoCommand,
} from "../../../lib/connection-info-command";
import type { SandboxEntry } from "../../../lib/state/registry";

type PrintDashboardFn = (
  sandboxName: string,
  model: string,
  provider: string,
  nimContainer: string | null,
  agent: AgentDefinition | null,
  ready: boolean,
) => void;

type ConnectionInfoRuntimeBridge = {
  getSandbox: (sandboxName: string) => SandboxEntry | null;
  fetchToken: (sandboxName: string) => string | null;
  loadAgent: (agentName: string) => AgentDefinition | null;
  isTerminalAgent: (agent: AgentDefinition) => boolean;
  printDashboard: PrintDashboardFn;
};

let runtimeBridgeFactory = (): ConnectionInfoRuntimeBridge => {
  const onboard = require("../../../lib/onboard") as {
    fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
    printDashboard: PrintDashboardFn;
  };
  const registry = require("../../../lib/state/registry") as {
    getSandbox: (name: string) => SandboxEntry | null;
  };
  const defs = require("../../../lib/agent/defs") as {
    loadAgent: (name: string) => AgentDefinition;
    isTerminalAgent: (agent: AgentDefinition) => boolean;
  };
  return {
    getSandbox: (sandboxName: string) => {
      try {
        return registry.getSandbox(sandboxName);
      } catch {
        return null;
      }
    },
    fetchToken: onboard.fetchGatewayAuthTokenFromSandbox,
    loadAgent: (agentName: string) => defs.loadAgent(agentName),
    isTerminalAgent: (agent: AgentDefinition) => defs.isTerminalAgent(agent),
    printDashboard: onboard.printDashboard,
  };
};

export function setConnectionInfoRuntimeBridgeFactoryForTest(
  factory: () => ConnectionInfoRuntimeBridge,
): void {
  runtimeBridgeFactory = factory;
}

function getRuntimeBridge(): ConnectionInfoRuntimeBridge {
  return runtimeBridgeFactory();
}

export default class ConnectionInfoCliCommand extends NemoClawCommand {
  static id = "sandbox:connection:info";
  static strict = true;
  static summary = "Print the connection details";
  static description =
    "Reprint the connection block shown at the end of onboarding for a running sandbox: dashboard URL, terminal connect command, and management commands.";
  static usage = ["<name>"];
  static examples = ["<%= config.bin %> sandbox connection info alpha"];
  static args = {
    sandboxName: Args.string({
      name: "sandbox",
      description: "Sandbox name",
      required: true,
    }),
  };

  public async run(): Promise<void> {
    const { args } = await this.parse(ConnectionInfoCliCommand);
    process.stdout.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EPIPE") {
        this.setExitCode(0);
        return;
      }
      throw err;
    });

    const runtime = getRuntimeBridge();
    try {
      runConnectionInfoCommand(args.sandboxName, {
        getSandbox: runtime.getSandbox,
        fetchToken: runtime.fetchToken,
        loadAgent: runtime.loadAgent,
        isTerminalAgent: runtime.isTerminalAgent,
        printDashboard: runtime.printDashboard,
        log: (message: string) => console.log(message),
      });
      this.setExitCode(0);
    } catch (error) {
      if (error instanceof ConnectionInfoCommandError) {
        this.failWithLines(error.lines, error.exitCode);
        return;
      }
      throw error;
    }
  }
}
