---
name: "nemoclaw-user-manage-policy"
description: "Reviews and approves blocked agent network requests in the TUI. Use when approving or denying sandbox egress requests, managing blocked network calls, or using the approval TUI. Trigger keywords - nemoclaw approve network requests, sandbox egress approval tui, customize nemoclaw network policy, sandbox egress policy configuration."
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Approve or Deny NemoClaw Agent Network Requests

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

Review and act on network requests that the agent makes to endpoints not listed in the sandbox policy.
OpenShell intercepts these requests and presents them in the TUI for operator approval.

## Step 1: Open the TUI

Start the OpenShell terminal UI to monitor sandbox activity:

```console
$ openshell term
```

For a remote sandbox, pass the instance name:

```console
$ ssh my-gpu-box 'cd ~/nemoclaw && . .env && openshell term'
```

The TUI displays the sandbox state, active inference provider, and a live feed of network activity.

## Step 2: Trigger a Blocked Request

When the agent attempts to reach an endpoint that is not in the baseline policy, OpenShell blocks the connection and displays the request in the TUI.
The blocked request includes the following details:

- **Host and port** of the destination.
- **Binary** that initiated the request.
- **HTTP method** and path, if available.

## Step 3: Approve or Deny the Request

The TUI presents an approval prompt for each blocked request.

- **Approve** the request to add the endpoint to the running policy for the current session.
- **Deny** the request to keep the endpoint blocked.

Approved endpoints remain in the running policy until the sandbox stops.
They are not persisted to the baseline policy file.

## Step 4: Run the Walkthrough

To observe the approval flow in a guided session, run the walkthrough script:

```console
$ ./scripts/walkthrough.sh
```

This script opens a split tmux session with the TUI on the left and the agent on the right.
The walkthrough requires tmux and the `NVIDIA_API_KEY` environment variable.

## References

- **Load [references/customize-network-policy.md](references/customize-network-policy.md)** when customizing network policy, changing egress rules, or configuring sandbox endpoint access. Adds, removes, or modifies allowed endpoints in the sandbox policy.

## Related Skills

- `nemoclaw-user-reference` — Network Policies (use the `nemoclaw-user-reference` skill) for the full baseline policy reference
- `nemoclaw-user-monitor-sandbox` — Monitor Sandbox Activity (use the `nemoclaw-user-monitor-sandbox` skill) for general sandbox monitoring
