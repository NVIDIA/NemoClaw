---
title:
  page: "Set Up the NemoClaw Signal Bridge for Remote Agent Chat"
  nav: "Set Up Signal Bridge"
description: "Forward messages between Signal and the sandboxed OpenClaw agent."
keywords: ["nemoclaw signal bridge", "signal-cli openclaw agent"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "signal", "deployment", "nemoclaw"]
content:
  type: how_to
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Set Up the Signal Bridge

Forward messages between a Signal account and the OpenClaw agent running inside the sandbox.
The Signal bridge is an auxiliary service managed by `nemoclaw start`.

## Prerequisites

- A running NemoClaw sandbox, either local or remote.
- A Signal account registered with `signal-cli`.

## Register with signal-cli

NemoClaw uses `signal-cli` to interact with the Signal service.
If you haven't registered your number, follow the [signal-cli registration guide](https://github.com/AsamK/signal-cli/wiki/Registration-with-captcha).

Verify that `signal-cli` is working by receiving a message:

```console
$ signal-cli -u +1234567890 receive
```

## Set the Environment Variable

Export your registered Signal phone number as an environment variable:

```console
$ export SIGNAL_PHONE_NUMBER=+1234567890
```

## Start Auxiliary Services

Start the Signal bridge and other auxiliary services:

```console
$ nemoclaw start
```

The `start` command launches the following services:

- The Signal bridge forwards messages between Signal and the agent.
- The cloudflared tunnel provides external access to the sandbox.

The Signal bridge starts only when the `SIGNAL_PHONE_NUMBER` environment variable is set and `signal-cli` is installed.

## Verify the Services

Check that the Signal bridge is running:

```console
$ nemoclaw status
```

The output shows the status of all auxiliary services.

## Send a Message

Open Signal on your phone and send a message to the number registered with `signal-cli`.
The bridge forwards the message to the OpenClaw agent inside the sandbox and returns the agent response.

## Restrict Access by ID

To restrict which Signal accounts can interact with the agent, set the `ALLOWED_IDS` environment variable to a comma-separated list of E.164 phone numbers, Signal UUIDs, or Signal usernames:

```console
$ export ALLOWED_IDS="+1234567890,uuid:0d244741-...,username:myuser"
$ nemoclaw start
```

## Stop the Services

To stop the Signal bridge and all other auxiliary services:

```console
$ nemoclaw stop
```

## Related Topics

- [Deploy NemoClaw to a Remote GPU Instance](deploy-to-remote-gpu.md) for remote deployment with Signal support.
- [Set Up the Telegram Bridge](set-up-telegram-bridge.md) to interact with the agent through Telegram.
- [Commands](../reference/commands.md) for the full `start` and `stop` command reference.
