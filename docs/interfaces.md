<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Access Agent Interfaces

The OpenShell gateway manages sandbox access.
Agents run inside their sandboxes; you reach them through OpenShell commands, not published host ports.

## Select the Gateway and Workspace

Use the pinned OpenShell development CLI at the revision in [versions.json](../versions.json) on the client host.
These selectors choose an existing OpenShell gateway and deployment; they do not create services or provision credentials.
Run them in every terminal used for forwarding or sandbox commands, from any directory.

For an existing authenticated gateway profile supplied by its operator:

```sh
unset OPENSHELL_GATEWAY_ENDPOINT
export OPENSHELL_GATEWAY=REPLACE_WITH_PROFILE_NAME
```

The profile's endpoint must match `spec.gateway.endpoint` in the deployment YAML.
Its stored authentication must grant access to the deployment workspace.
The endpoint override takes precedence over the profile, which is why this example clears it.
NemoClaw's YAML credential and TLS environment references do not configure the OpenShell CLI's stored profile or credentials.
Creating a new authenticated profile, including its issuer or mTLS client certificates, is tracked in [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642).

For an existing plaintext loopback gateway instead, select its actual endpoint directly:

```sh
unset OPENSHELL_GATEWAY
export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
```

Replace the example port with the one in your YAML.
Use this variant only when that gateway is already listening on the client host's loopback interface.
Do not replace an authenticated remote endpoint with plaintext or disable TLS verification to make access work.

Copy the **OpenShell gateway** and **OpenShell workspace** selectors from the plan or apply result.
To print them again without changing runtime resources, run from the directory containing the applied YAML, with the same state directory and credential environment:

```sh
nemoclaw plan deployment.yaml --state-dir .nemoclaw --non-interactive
```

The workspace derives from `metadata.uid`; copy the reported value into each client terminal:

```sh
export OPENSHELL_WORKSPACE=REPLACE_WITH_REPORTED_WORKSPACE
```

JSON results expose the same values as `connection.gatewayEndpoint` and `connection.workspace`.
These selectors describe the configured target, including when a plan is incomplete; they do not establish access or create an authenticated OpenShell CLI profile.
The gateway selectors follow the [pinned OpenShell CLI parser and resolver](https://github.com/NVIDIA/OpenShell/blob/5a7728c304b5528e954e9ae900cf21f84e1a12b1/crates/openshell-cli/src/main.rs).
The forward or sandbox command below verifies access to the selected workspace; setting an environment variable alone does not.
On an authentication or missing-sandbox error, check the endpoint, workspace, sandbox name, and operator-provided credentials before changing deployment state.

## Invoke an Agent

After [selecting the gateway and workspace](#select-the-gateway-and-workspace), send requests through `openshell sandbox exec`.
[Run one request](agents.md#run-one-deep-agents-or-pi-request) shows the command and its input.
The selected Fabric adapter owns how the harness handles the request.

## Forward a Native Service

An adapter that serves a native listener inside the sandbox can be reached by forwarding it from a private terminal on the client host:

```sh
openshell forward service REPLACE_WITH_SANDBOX --target-port REPLACE_WITH_PORT --local 127.0.0.1:REPLACE_WITH_PORT
```

The foreground command forwards through the authenticated OpenShell connection to the sandbox's loopback service.
Keep forwarding bound to loopback, follow the adapter's authentication requirements, and stop forwarding with Ctrl-C.
Stopping a client forward does not stop the sandbox or its Fabric runtime.

No bundled adapter's Fabric configuration currently enables a browser interface.
OpenClaw's dashboard ([#13360](https://github.com/NVIDIA/NemoClaw/issues/13360)) and Hermes's API, dashboard, and browser TUI ([#13321](https://github.com/NVIDIA/NemoClaw/issues/13321)) return when Fabric's adapters support configuring them.

## Diagnose Failures

Check gateway authorization, the UID-derived workspace, sandbox name, and native service state independently.
Inspect the [native logs](troubleshooting.md#read-native-service-logs) through the retained sandbox binding.
A working forward does not establish that the native service has valid authentication or a working model connection.

NemoClaw compares the retained public Fabric configuration with the runtime host's configuration and preserves resource identities on failure.
Fabric owns configuration validation and native diagnostics.
Configuration failures name the sandbox and report a fixed stage, code, and runtime state.
Fabric's own message is left out of the output, because it can repeat what the harness printed, including secrets NemoClaw can't recognize to redact.
NemoClaw keeps it in `diagnostics/fabric-SANDBOX.json` in the deployment's state directory, and the error names that file: `Fabric's message is in PATH`.
On Linux and macOS, only the state directory's owner can read the file.
Inspect it privately before sharing excerpts; a later failure in the same sandbox replaces it.
Correct the reported conflict before reapplying; do not delete retained state to hide drift.
