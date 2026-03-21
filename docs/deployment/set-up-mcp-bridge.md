---
title:
  page: "Bridge MCP Servers into a NemoClaw Sandbox"
  nav: "Set Up MCP Bridge"
description: "Bridge host-side MCP servers into the sandbox so the OpenClaw agent can use external tools without exposing API keys."
keywords: ["NemoClaw mcp bridge", "mcp server sandbox", "mcporter OpenClaw", "model context protocol"]
topics: ["generative_ai", "ai_agents"]
tags: ["OpenClaw", "OpenShell", "mcp", "mcporter", "deployment", "NemoClaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: draft
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Bridge MCP Servers into a NemoClaw Sandbox

Bridge stdio-based MCP servers from the host into a NemoClaw sandbox so the OpenClaw agent can call external tools without exposing API keys inside the sandbox.

## Prerequisites

- A running NemoClaw sandbox.
- An MCP server command, for example `npx @modelcontextprotocol/server-github`.
- The required API key exported as an environment variable on the host.

## Install mcporter in the Sandbox

OpenClaw uses [mcporter](https://github.com/steipete/mcporter) to connect to MCP servers.
The sandbox image does not include mcporter, so install it to the writable layer.

```console
$ nemoclaw <name> connect
sandbox@<name>:~$ npm install --prefix /sandbox/.local mcporter
sandbox@<name>:~$ echo 'export PATH="/sandbox/.local/node_modules/.bin:$PATH"' >> /sandbox/.bash_profile
sandbox@<name>:~$ source /sandbox/.bash_profile
sandbox@<name>:~$ mcporter --version
```

This persists across sandbox restarts.
It is lost only if the sandbox is destroyed and recreated.

## Add an MCP Server

### Set the Environment Variable

Export the API key on the host.
The bridge reads the variable from the host environment and passes it to the MCP server process.
The key never enters the sandbox.

```console
$ export GITHUB_TOKEN=<your-token>
```

### Start the Proxy and Forward the Port

Start the stdio-to-HTTP proxy on the host.
The proxy spawns the MCP server as a subprocess and exposes it over HTTP on a local port.

```console
$ node scripts/mcp-proxy.js \
    --command "npx @modelcontextprotocol/server-github" \
    --env GITHUB_TOKEN \
    --port 3101 &
```

Forward the port into the sandbox.

```console
$ openshell forward start 3101 <name> &
```

### Register the Server in the Sandbox

Connect to the sandbox and add the server to the mcporter configuration.

```console
$ nemoclaw <name> connect
sandbox@<name>:~$ mcporter config add github --url http://localhost:3101 --scope home
```

### Verify

List available tools to confirm the connection.

```console
sandbox@<name>:~$ mcporter list github
```

If the tool list is returned, the bridge is working.
The OpenClaw agent can now use the MCP tools through the `mcporter` skill.

## Manage the Bridge

### List Active Bridges

Check which proxy processes are running on the host.

```console
$ ls /tmp/nemoclaw-services-<name>/mcp-*.pid
```

### Stop a Bridge

Kill the proxy process and stop the port forward.

```console
$ kill $(cat /tmp/nemoclaw-services-<name>/mcp-github.pid)
$ openshell forward stop 3101
```

### Restart After Reboot

The proxy processes do not survive a host reboot.
Restart them and the port forwards.
The mcporter configuration inside the sandbox persists and does not need to be reconfigured.

## CLI Commands

The `nemoclaw <name> mcp` subcommands automate the manual steps above.

### Add a stdio MCP server

Bridge a host-side MCP server into the sandbox.

```console
$ export GITHUB_TOKEN=<your-token>
$ nemoclaw <name> mcp add --name github \
    --command "npx @modelcontextprotocol/server-github" \
    --env GITHUB_TOKEN
```

This command:

1. Starts the stdio-to-HTTP proxy on the host with the named environment variables.
2. Forwards the port into the sandbox via `openshell forward`.
3. Installs mcporter in the sandbox if not already present.
4. Registers the server in the sandbox mcporter configuration.

### List bridges

List all MCP bridges for a sandbox with their running status.

```console
$ nemoclaw <name> mcp list
```

```text
MCP Bridges for sandbox "my-assistant":

  ● github      :3101  npx @modelcontextprotocol/server-github      env: GITHUB_TOKEN
  ● slack       :3102  npx @anthropic/mcp-server-slack               env: SLACK_TOKEN
```

### Remove a bridge

Stop the proxy, stop the port forward, and remove the server from the sandbox mcporter configuration.

```console
$ nemoclaw <name> mcp remove github
```

### Restart after reboot

Restart all proxy processes and port forwards from the saved configuration.
The sandbox-side mcporter configuration persists and does not need to be rewritten.

```console
$ nemoclaw <name> mcp restart
```

## Future Work

:::{note}
The following features are planned but not yet implemented.
:::

### Remote HTTP MCP servers

Route a remote MCP server through a host-side reverse proxy so the sandbox connects to `localhost` and no egress policy is needed.

```console
$ nemoclaw <name> mcp add --name linear --url https://mcp.linear.app/mcp
```

### Import from Claude Code or Cursor

Read MCP server definitions by name from editor configuration files.
This extracts the command and environment variable names only, never values.

```console
$ nemoclaw <name> mcp import github --from claude
```

### Integration with nemoclaw start

MCP bridges managed alongside the Telegram bridge and other auxiliary services.

```console
$ nemoclaw start
```

## Security

| Layer | Protection |
|-------|-----------|
| API keys | Stay in host environment variables. Never written to sandbox filesystem. |
| Proxy binding | Listens on `127.0.0.1` only. Not reachable from the network. |
| Port forward | OpenShell maps the host port to sandbox localhost. No egress policy needed. |
| Sandbox isolation | Filesystem, network, and process policies still enforced by OpenShell. |

## Next Steps

- [Set Up Telegram Bridge](set-up-telegram-bridge.md) for another auxiliary service pattern.
- [Commands](../reference/commands.md) for the full CLI reference.
- [Network Policies](../reference/network-policies.md) for egress control.
