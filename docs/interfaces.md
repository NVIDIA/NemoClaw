<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Access Agent Interfaces

Declare OpenClaw dashboard settings on the first agent in a sandbox.
All agents share its native gateway; secondary agents must omit `interfaces`.

```yaml
interfaces:
  dashboard:
    port: 18800
    bind: 127.0.0.1
```

Declaring `dashboard` enables the native control UI with token authentication.
At least one setting is required; omitted port defaults to 18789 and omitted bind defaults to loopback.
Ports 8642 through 8652 are reserved for Hermes.
Binding `0.0.0.0` listens on the sandbox's interfaces; it does not publish a host port.
Omitting `interfaces` preserves the previous headless gateway behavior.

## Build and Apply

Build a fresh OpenClaw image from the repository root with `python3 image/fabric/build.py --harness openclaw`.
Follow the [image prerequisites](inference.md#build-an-image-with-the-configuration-interface), including image availability on the sandbox compute daemon.
Use its immutable digest in the [dashboard example](../examples/openclaw-dashboard.yaml), replacing the zero-digest placeholder, deployment UID, endpoint, and model values.
Apply with the [desired-state workflow](usage.md).
Changing interface settings or images requires a new deployment with a fresh UID and state directory; ordinary apply refuses to replace the sandbox.
Verify the new deployment before separately retiring the old one with its retained state.

The adapter creates a random token in `/sandbox/.openclaw/interface-token`, readable only by the sandbox user.
Native configuration refers to a process environment variable; the actual token is absent from YAML, OpenTofu state, and exported configuration.
The adapter reuses the retained token across process restarts and refuses a missing or insecure token beside existing configuration.
Readiness verifies the native settings and performs an authenticated gateway health RPC.

## Connect through OpenShell

Use an OpenShell 0.0.116 CLI configured for the deployment's gateway and workspace, with that gateway's required authentication.
From the client host, forward the same local and target ports:

```sh
openshell forward service assistant --target-port 18800 --local 127.0.0.1:18800
```

The foreground command forwards through the authenticated OpenShell connection to the sandbox's loopback service.
Open `http://127.0.0.1:18800` in your browser.
Display the token in a private terminal and enter it into the native UI's token field:

```sh
openshell sandbox exec -n assistant -- cat /sandbox/.openclaw/interface-token
```

This command displays a credential; avoid recorded or shared terminal sessions.
Treat it as a credential: do not paste it into YAML, command arguments, logs, or shared URLs.
The generated configuration keeps native device pairing enabled.
If prompted, list pending requests and approve only the request belonging to your browser:

```sh
openshell sandbox exec -n assistant -- /opt/fabric/bin/python /opt/nemoclaw/interfaces.py devices list
openshell sandbox exec -n assistant -- /opt/fabric/bin/python /opt/nemoclaw/interfaces.py devices approve REQUEST_ID
```

The helper supplies the token through the native CLI environment, without putting it into command arguments.
Browser origins are restricted to `localhost` and `127.0.0.1` at the declared port.

Stop forwarding with Ctrl-C.
The adapter stops its owned gateway when Fabric stops; forwarding has a separate client lifetime.
The token remains with retained native state and is removed when that state is deleted.
Do not edit or rotate the token file while the gateway is running.
This version has no token-rotation command; use a new deployment when replacing a compromised credential.

## Diagnose Failures

Configuration drift, a missing token, invalid file permissions, or failed authenticated health checks stop readiness or export.
NemoClaw retains established resource identities and does not overwrite the native configuration to hide drift.
Inspect the owned gateway logs and retained files, restore the intended settings and credential permissions, and reapply.

Offline fixtures exercise the real native gateway and local protocol endpoints.
They do not establish browser compatibility or qualify a public dashboard deployment.
