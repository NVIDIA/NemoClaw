---
title:
  page: "Bridge MCP Servers into a NemoClaw Sandbox"
  nav: "Set Up MCP Bridge"
description: "Bridge host-side MCP servers into the sandbox so the OpenClaw agent can use external tools without exposing API keys."
keywords: ["nemoclaw mcp bridge", "mcp server sandbox", "mcporter openclaw", "model context protocol"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "mcp", "mcporter", "deployment", "nemoclaw"]
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

Bridge stdio-based MCP servers from the host into a NemoClaw sandbox so the OpenClaw agent can call external tools (GitHub, Slack, databases, etc.) without exposing API keys inside the sandbox.

## How It Works

MCP servers typically run as stdio subprocesses on the host, spawned by tools like Claude Code or Cursor. The sandbox cannot run these directly because the API keys would need to be inside the sandbox.

The MCP bridge solves this by running a lightweight HTTP proxy on the host that wraps the stdio MCP server. The proxy port is forwarded into the sandbox via OpenShell, where mcporter connects to it as a standard HTTP MCP server.

```text
Host                                Sandbox
┌────────────────────────┐         ┌───────────────────────┐
│  stdio MCP server      │         │  mcporter             │
│    ↕                   │ forward │    ↕                  │
│  stdio→HTTP proxy :3101├─────────┤  localhost:3101       │
│                        │         │                       │
│  API keys stay here    │         │  OpenClaw agent       │
└────────────────────────┘         │    (no API keys)      │
                                   └───────────────────────┘
```

## Prerequisites

- A running NemoClaw sandbox.
- An MCP server command (for example, `npx @modelcontextprotocol/server-github`).
- The required API key exported as an environment variable on the host.

## Install mcporter in the Sandbox

OpenClaw uses [mcporter](https://github.com/steipete/mcporter) to connect to MCP servers. The sandbox image does not include mcporter, so install it to the writable layer:

```console
$ nemoclaw <name> connect
sandbox@my-assistant:~$ npm install --prefix /sandbox/.local mcporter
sandbox@my-assistant:~$ echo 'export PATH="/sandbox/.local/node_modules/.bin:$PATH"' >> /sandbox/.bash_profile
sandbox@my-assistant:~$ source /sandbox/.bash_profile
sandbox@my-assistant:~$ mcporter --version
```

This persists across sandbox restarts. It is only lost if the sandbox is destroyed and recreated.

## Add an MCP Server

### Set the Environment Variable

Export the API key on the host. The bridge reads the variable from the host environment and passes it to the MCP server process. The key never enters the sandbox.

```console
$ export GITHUB_TOKEN=<your-token>
```

### Start the Proxy and Forward the Port

Start the stdio→HTTP proxy on the host. The proxy spawns the MCP server as a subprocess and exposes it over HTTP on a local port:

```console
$ node scripts/mcp-proxy.js \
    --command "npx @modelcontextprotocol/server-github" \
    --env GITHUB_TOKEN \
    --port 3101 &
```

Forward the port into the sandbox:

```console
$ openshell forward start 3101 <name> &
```

### Register the Server in the Sandbox

Connect to the sandbox and add the server to the mcporter configuration:

```console
$ nemoclaw <name> connect
sandbox@my-assistant:~$ mcporter config add github --url http://localhost:3101 --scope home
```

### Verify

List available tools to confirm the connection:

```console
sandbox@my-assistant:~$ mcporter list github
```

If the tool list is returned, the bridge is working. The OpenClaw agent can now use the MCP tools through the `mcporter` skill.

## Manage the Bridge

### List Active Bridges

Check which proxy processes are running on the host:

```console
$ ls /tmp/nemoclaw-services-<name>/mcp-*.pid
```

### Stop a Bridge

Kill the proxy process and stop the port forward:

```console
$ kill $(cat /tmp/nemoclaw-services-<name>/mcp-github.pid)
$ openshell forward stop 3101
```

### Restart After Reboot

The proxy processes do not survive a host reboot. Restart them and the port forwards. The mcporter configuration inside the sandbox persists and does not need to be reconfigured.

## Security

| Layer | Protection |
|-------|-----------|
| API keys | Stay in host environment variables. Never written to sandbox filesystem. |
| Proxy binding | Listens on `127.0.0.1` only. Not reachable from the network. |
| Port forward | OpenShell maps the host port to sandbox localhost. No egress policy needed. |
| Sandbox isolation | Filesystem, network, and process policies still enforced by OpenShell. |

## Related Topics

- [Set Up Telegram Bridge](set-up-telegram-bridge.md) for another auxiliary service pattern.
- [Commands](../reference/commands.md) for the full CLI reference.
- [Network Policies](../reference/network-policies.md) for egress control.
