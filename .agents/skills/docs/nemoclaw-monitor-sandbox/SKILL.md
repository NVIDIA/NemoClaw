---
name: nemoclaw-monitor-sandbox
description: Inspects sandbox health, trace agent behavior, and diagnose problems. Use when debug nemoclaw agent issues, monitor nemoclaw sandbox, monitor nemoclaw sandbox activity, monitoring, nemoclaw, openclaw, openshell, troubleshooting.
---

# Nemoclaw Monitor Sandbox

Inspect sandbox health, trace agent behavior, and diagnose problems.

## Prerequisites

- A running NemoClaw sandbox.
- The OpenShell CLI on your `PATH`.

Use the NemoClaw status, logs, and TUI tools together to inspect sandbox health, trace agent behavior, and diagnose problems.

## Step 1: Check Sandbox Health

Run the status command to view the sandbox state, blueprint run information, and active inference configuration:

```console
$ nemoclaw <name> status
```

Key fields in the output include the following:

- Sandbox state, which indicates whether the sandbox is running, stopped, or in an error state.
- Blueprint run ID, which is the identifier for the most recent blueprint execution.
- Inference provider, which shows the active provider, model, and endpoint.

Run `nemoclaw <name> status` on the host to check sandbox state. Use `openshell sandbox list` for the underlying sandbox details.

## Step 2: View Blueprint and Sandbox Logs

Stream the most recent log output from the blueprint runner and sandbox:

```console
$ nemoclaw <name> logs
```

To follow the log output in real time:

```console
$ nemoclaw <name> logs -f
```

## Step 3: Monitor Network Activity in the TUI

Open the OpenShell terminal UI for a live view of sandbox network activity and egress requests:

```console
$ openshell term
```

For a remote sandbox, SSH to the instance and run `openshell term` there.

The TUI shows the following information:

- Active network connections from the sandbox.
- Blocked egress requests awaiting operator approval.
- Inference routing status.

Refer to Approve or Deny Agent Network Requests (see the `nemoclaw-manage-policy` skill) for details on handling blocked requests.

## Step 4: Test Inference

Run a test inference request to verify that the provider is responding:

```console
$ nemoclaw my-assistant connect
$ openclaw agent --agent main --local -m "Test inference" --session-id debug
```

If the request fails, check the following:

1. Run `nemoclaw <name> status` to confirm the active provider and endpoint.
2. Run `nemoclaw <name> logs -f` to view error messages from the blueprint runner.
3. Verify that the inference endpoint is reachable from the host.

## Related Skills

- `nemoclaw-reference` — Troubleshooting for common issues and resolution steps
- `nemoclaw-manage-policy` — Approve or Deny Agent Network Requests for the operator approval flow
- `nemoclaw-configure-inference` — Switch Inference Providers to change the active provider
