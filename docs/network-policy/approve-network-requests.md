---
title:
  page: "Approve or Deny NemoClaw Agent Network Requests"
  nav: "Approve Network Requests"
description:
  main: "Review and approve blocked agent network requests in the TUI."
  agent: "Reviews and approves blocked agent network requests in the TUI. Use when approving or denying sandbox egress requests, managing blocked network calls, or using the approval TUI."
keywords: ["nemoclaw approve network requests", "sandbox egress approval tui"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "network_policy", "security", "nemoclaw"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer", "security_engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Approve or Deny Agent Network Requests

Review and act on network requests that the agent makes to endpoints not listed in the sandbox policy.
OpenShell intercepts these requests and presents them in the TUI for operator approval.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

## Open the TUI

Start the OpenShell terminal UI to monitor sandbox activity:

```console
$ openshell term
```

For a remote sandbox, pass the instance name:

```console
$ ssh my-gpu-box 'cd /home/ubuntu/nemoclaw && . .env && openshell term'
```

The TUI displays the sandbox state, active inference provider, and a live feed of network activity.

## Trigger a Blocked Request

When the agent attempts to reach an endpoint that is not in the baseline policy, OpenShell blocks the connection and displays the request in the TUI.
The blocked request includes the following details:

- **Host and port** of the destination.
- **Binary** that initiated the request.
- **HTTP method** and path, if available.

## Approve or Deny the Request

The TUI presents an approval prompt for each blocked request.

- **Approve** the request to add the endpoint to the running policy for the current session.
- **Deny** the request to keep the endpoint blocked.

Approved endpoints remain in the running policy until the sandbox stops.
They are not persisted to the baseline policy file.

## Run the Walkthrough

To observe the approval flow in a guided session, run the walkthrough script:

```console
$ ./scripts/walkthrough.sh
```

This script opens a split tmux session with the TUI on the left and the agent on the right.
The walkthrough requires tmux and the `NVIDIA_API_KEY` environment variable.

## Related Topics

- [Customize the Sandbox Network Policy](customize-network-policy.md) to add endpoints permanently.
- [Network Policies](../reference/network-policies.md) for the full baseline policy reference.
- [Monitor Sandbox Activity](../monitoring/monitor-sandbox-activity.md) for general sandbox monitoring.
