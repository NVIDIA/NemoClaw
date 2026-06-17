// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dispatch as mcpDispatch } from "../../lib/actions/sandbox/mcp-bridge";
import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxMcpCommand extends NemoClawCommand {
  static id = "sandbox:mcp";
  static strict = false;
  static summary = "Bridge host MCP servers into the sandbox";
  static description =
    "Manage stdio-to-HTTP MCP bridges for a sandbox (`add`, `list`, `remove`, `restart`). The proxy runs on the host with the user's API keys; the sandbox reaches it through host.docker.internal via a scoped OpenShell egress rule, so credentials never enter the sandbox. With no subcommand, lists the configured bridges.";
  static usage = ["<name> <add|list|remove|restart> [args...]"];
  static examples = [
    "<%= config.bin %> sandbox mcp list alpha",
    "<%= config.bin %> sandbox mcp add alpha --name github -e GITHUB_TOKEN=ghp_xxx -- npx -y @modelcontextprotocol/server-github",
    "<%= config.bin %> sandbox mcp remove alpha github",
    "<%= config.bin %> sandbox mcp restart alpha",
  ];

  public async run(): Promise<void> {
    this.parsed = true;
    const [sandboxName, ...actionArgs] = this.argv;
    if (!sandboxName || sandboxName.trim() === "") {
      this.failWithLines(["Missing required sandbox name for mcp."], 2);
      return;
    }
    await mcpDispatch(sandboxName, actionArgs);
  }
}
