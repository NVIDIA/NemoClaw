<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Monitor Sandbox Activity and Debug Issues

Use the NemoClaw status, logs, and TUI tools together to inspect sandbox health, trace agent behavior, and diagnose problems.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

## Check Sandbox Health

Run the status command to view the sandbox state, blueprint run information, and active inference configuration:

```console
$ openclaw nemoclaw status
```

For machine-readable output, add the `--json` flag:

```console
$ openclaw nemoclaw status --json
```

Key fields in the output include the following:

- Sandbox state, which indicates whether the sandbox is running, stopped, or in an error state.
- Blueprint run ID, which is the identifier for the most recent blueprint execution.
- Inference provider, which shows the active provider, model, and endpoint.

## View Blueprint and Sandbox Logs

Stream the most recent log output from the blueprint runner and sandbox:

```console
$ openclaw nemoclaw logs
```

To follow the log output in real time:

```console
$ openclaw nemoclaw logs -f
```

To display a specific number of log lines:

```console
$ openclaw nemoclaw logs -n 100
```

To view logs for a specific blueprint run instead of the most recent one:

```console
$ openclaw nemoclaw logs --run-id <id>
```

## Monitor Network Activity in the TUI

Open the OpenShell terminal UI for a live view of sandbox network activity and egress requests:

```console
$ openshell term
```

For a remote sandbox:

```console
$ nemoclaw term <instance-name>
```

The TUI shows the following information:

- Active network connections from the sandbox.
- Blocked egress requests awaiting operator approval.
- Inference routing status.

Refer to [Approve or Deny Agent Network Requests](../network-policy/approve-network-requests.md) for details on handling blocked requests.

## Test Inference

Run a test inference request to verify that the provider is responding:

```console
$ nemoclaw connect
$ openclaw agent --agent main --local -m "Test inference" --session-id debug
```

If the request fails, check the following:

1. Run `openclaw nemoclaw status` to confirm the active provider and endpoint.
2. Run `openclaw nemoclaw logs -f` to view error messages from the blueprint runner.
3. Verify that the inference endpoint is reachable from the host.
   For local vLLM or NIM, confirm that the server is running.

## Common Issues

The following table lists common problems and their resolution steps:

| Symptom | Resolution |
|---|---|
| Sandbox shows as stopped | Run `nemoclaw setup` to recreate the sandbox. |
| Inference requests time out | Verify the provider endpoint is reachable. Check `openclaw nemoclaw status` for the active endpoint. |
| Agent cannot reach an external host | Open the TUI with `openshell term` and approve the blocked request, or add the endpoint to the policy. |
| Blueprint run failed | Run `openclaw nemoclaw logs --run-id <id>` to view the error output for the failed run. |

## Related Topics

- [Commands](../reference/commands.md) for the full CLI reference.
- [Approve or Deny Agent Network Requests](../network-policy/approve-network-requests.md) for the operator approval flow.
- [Switch Inference Providers](../inference/switch-inference-providers.md) to change the active provider.
