// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dispatchMcpBridgeCommand } from "../../lib/actions/sandbox/mcp-bridge";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxMcpCommand extends NemoClawCommand {
  static id = "sandbox:mcp";
  static strict = false;
  static summary = "Manage MCP servers for a sandbox";
  static description =
    "Manage OpenShell-enforced MCP Streamable HTTP servers for a sandbox. Credentials are registered as OpenShell providers and appear in sandbox config only as openshell:resolve:env placeholders.";
  static usage = ["<name> <add|list|status|restart|remove> [args...]"];
  static examples = [
    "<%= config.bin %> sandbox mcp alpha list",
    "<%= config.bin %> sandbox mcp alpha add github --url https://api.githubcopilot.com/mcp/ --env GITHUB_MCP_TOKEN",
    "<%= config.bin %> sandbox mcp alpha status github --json",
    "<%= config.bin %> sandbox mcp alpha remove github",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...actionArgs] = this.argv;
    if (
      !sandboxName ||
      sandboxName.trim() === "" ||
      sandboxName === "--help" ||
      sandboxName === "-h"
    ) {
      this.failWithLines(
        ["Usage: nemoclaw <sandbox> mcp <add|list|status|restart|remove> [args...]"],
        2,
      );
      return;
    }
    await dispatchMcpBridgeCommand(sandboxName, actionArgs);
  }
}
