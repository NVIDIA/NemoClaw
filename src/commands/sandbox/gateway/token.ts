// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Args } from "@oclif/core";
import type { AgentDefinition } from "../../../lib/agent/defs";
import { quietFlag } from "../../../lib/cli/common-flags";
import { NemoClawCommand } from "../../../lib/cli/nemoclaw-oclif-command";

import {
  GatewayTokenCommandError,
  runGatewayTokenCommand,
} from "../../../lib/gateway-token-command";

type GatewayTokenRuntimeBridge = {
  /** Agent-appropriate token fetcher, resolved per sandbox. */
  fetchToken: (sandboxName: string) => string | null;
  getSandboxAgent: (sandboxName: string) => string | null;
  /** Whether the resolved agent exposes a retrievable auth token. */
  agentExposesToken: (agentName: string | null) => boolean;
};

let runtimeBridgeFactory = (): GatewayTokenRuntimeBridge => {
  const onboard = require("../../../lib/onboard") as {
    fetchGatewayAuthTokenFromSandbox: (sandboxName: string) => string | null;
    fetchAgentWebAuthTokenFromSandbox: (
      sandboxName: string,
      agent: AgentDefinition,
    ) => string | null;
  };
  const registry = require("../../../lib/state/registry") as {
    getSandbox: (name: string) => { agent?: string | null } | null;
  };
  const { loadAgent } = require("../../../lib/agent/defs") as {
    loadAgent: (name: string) => AgentDefinition;
  };

  const getSandboxAgent = (sandboxName: string): string | null => {
    try {
      return registry.getSandbox(sandboxName)?.agent ?? null;
    } catch {
      return null;
    }
  };

  // null / "openclaw" → OpenClaw gateway token. Otherwise the agent must
  // declare web_auth_method: bearer_token (e.g. Hermes' API_SERVER_KEY).
  const resolveBearerAgent = (agentName: string | null): AgentDefinition | null => {
    if (!agentName || agentName === "openclaw") return null;
    try {
      const agent = loadAgent(agentName);
      return agent.webAuth.method === "bearer_token" && agent.webAuth.env ? agent : null;
    } catch {
      return null;
    }
  };

  return {
    getSandboxAgent,
    agentExposesToken: (agentName: string | null): boolean => {
      if (!agentName || agentName === "openclaw") return true;
      return resolveBearerAgent(agentName) !== null;
    },
    fetchToken: (sandboxName: string): string | null => {
      const agentName = getSandboxAgent(sandboxName);
      const bearerAgent = resolveBearerAgent(agentName);
      if (bearerAgent) {
        return onboard.fetchAgentWebAuthTokenFromSandbox(sandboxName, bearerAgent);
      }
      return onboard.fetchGatewayAuthTokenFromSandbox(sandboxName);
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
  static summary = "Print the sandbox agent's auth token to stdout";
  static description =
    "Print the running sandbox agent's auth token to stdout: the OpenClaw gateway token, " +
    "or a bearer_token agent's web-auth key (e.g. Hermes' API_SERVER_KEY for the OpenAI-compatible API).";
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
          fetchToken: runtime.fetchToken,
          getSandboxAgent: runtime.getSandboxAgent,
          agentExposesToken: runtime.agentExposesToken,
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
