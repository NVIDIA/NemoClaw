<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NemoClaw Docs MCP Server

An [MCP](https://modelcontextprotocol.io/) server that exposes NemoClaw documentation, source code, blueprint configuration, network policies, and NIM model catalog as tools for AI assistants.

## Tools

| Tool | Description |
|---|---|
| `list_docs` | List all documentation pages |
| `read_doc` | Read a specific doc page by path |
| `search` | Full-text search across docs, source code, policies, scripts, and configs |
| `get_blueprint_config` | Blueprint YAML with inference profiles and sandbox config |
| `get_baseline_policy` | Baseline sandbox network and filesystem policy |
| `list_policy_presets` | Available network policy presets with endpoints |
| `get_policy_preset` | Full YAML for a specific policy preset |
| `get_nim_models` | NIM container image catalog with GPU memory requirements |
| `read_source_file` | Read any source file from the repo |
| `list_source_files` | Browse indexed source files by category |
| `get_architecture_overview` | Architecture summary with components, flows, and models |
| `get_dockerfile` | Sandbox container Dockerfile |

## Usage with Claude Code

Create a `.mcp.json` file in the project root:

```json
{
  "mcpServers": {
    "nemoclaw-docs": {
      "command": "node",
      "args": ["mcp-docs-server/index.js"]
    }
  }
}
```

Then restart Claude Code. The server starts automatically.

## Usage with Other MCP Clients

Run the server over stdio:

```console
$ cd /path/to/NemoClaw
$ node mcp-docs-server/index.js
```

The server communicates over stdin/stdout using the MCP JSON-RPC protocol.

## Install Dependencies

```console
$ cd mcp-docs-server
$ npm install
```

Requires Node.js 20 or later.
