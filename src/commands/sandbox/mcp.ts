// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { NemoClawCommand } from "../../lib/cli/nemoclaw-oclif-command";

export default class SandboxMcpCommand extends NemoClawCommand {
  static id = "sandbox:mcp";
  static customHelp = true;
  static strict = false;
  static summary = "Manage MCP servers for a sandbox";
  static description =
    "Manage OpenShell-enforced MCP Streamable HTTP servers for a sandbox. Credentials are registered as OpenShell providers and appear in sandbox config only as openshell:resolve:env placeholders.";
  static usage = ["<name> <add|list|status|restart|remove|migrate> [args...]"];
  static examples = [
    "<%= config.bin %> sandbox mcp alpha list",
    "<%= config.bin %> sandbox mcp alpha add github --url https://api.githubcopilot.com/mcp/ --env GITHUB_MCP_TOKEN",
    "<%= config.bin %> sandbox mcp alpha status github --json",
    "<%= config.bin %> sandbox mcp alpha remove github",
    "<%= config.bin %> sandbox mcp alpha migrate --apply",
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
        ["Usage: nemoclaw <sandbox> mcp <add|list|status|restart|remove|migrate> [args...]"],
        2,
      );
      return;
    }
    const [{ dispatchMcpBridgeCommand }, { rebuildSandbox }] = await Promise.all([
      import("../../lib/actions/sandbox/mcp-bridge"),
      import("../../lib/actions/sandbox/rebuild"),
    ]);
    await dispatchMcpBridgeCommand(sandboxName, actionArgs, {
      rebuildForMigration: (name) => rebuildSandbox(name, ["--yes"], { throwOnError: true }),
    });
  }
}
