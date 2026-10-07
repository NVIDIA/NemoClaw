// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  cleanupCachedPatchedFixture,
  cleanupPackageFixtures,
  createPatchedPackageFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);
afterAll(cleanupCachedPatchedFixture);

describe("Deep Agents managed MCP configuration layers", () => {
  it("excludes user, project, and plugin MCP configuration from managed discovery", () => {
    const tempDir = createPatchedPackageFixture();
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import asyncio
import json
import os
from pathlib import Path
from deepagents_code import mcp_tools

home = Path.cwd() / "home"
project = Path.cwd() / "project"
os.environ["HOME"] = str(home)
for config_path in (
    home / ".deepagents" / ".mcp.json",
    project / ".deepagents" / ".mcp.json",
    project / ".mcp.json",
):
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps({"mcpServers": {
        "unmanaged": {"command": "unmanaged-command", "args": []}
    }}))
os.chdir(project)
assert mcp_tools.discover_mcp_configs() == []
assert asyncio.run(mcp_tools.resolve_and_load_mcp_tools()) == []
plugin_configs = ({"mcpServers": {
    "plugin_process": {"command": "unmanaged-command", "args": []},
    "plugin_network": {"type": "http", "url": "https://unmanaged.example/mcp/"},
}},)
assert asyncio.run(mcp_tools.resolve_and_load_mcp_tools(additional_configs=plugin_configs)) == []
assert asyncio.run(mcp_tools.resolve_and_load_mcp_tools(
    additional_configs=plugin_configs, no_mcp=True,
)) == ([], None, [])
print("unmanaged MCP servers excluded")
`,
      ],
      {
        cwd: tempDir,
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("unmanaged MCP servers excluded");
  });
});
