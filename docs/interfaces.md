<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Access Agent Interfaces

The OpenShell gateway manages sandbox access.
The OpenClaw gateway runs inside an OpenClaw sandbox and serves its agent and optional dashboard.

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
Provisioning a new authenticated profile, including its issuer or mTLS client certificates, remains **TBD** pending a qualified operator procedure.

For an existing plaintext loopback gateway instead, select its actual endpoint directly:

```sh
unset OPENSHELL_GATEWAY
export OPENSHELL_GATEWAY_ENDPOINT=http://127.0.0.1:17671
```

Replace the example port with the one in your YAML.
Use this variant only when that gateway is already listening on the client host's loopback interface.
Do not replace an authenticated remote endpoint with plaintext or disable TLS verification to make access work.

The workspace name comes from `metadata.uid`, not the deployment or sandbox name.
Paste the exact UID from the applied YAML at the prompt:

```sh
python3 -c 'import hashlib; uid = input("Deployment metadata.uid: ").strip(); print("nc-" + hashlib.sha256(uid.encode()).hexdigest()[:16])'
export OPENSHELL_WORKSPACE=REPLACE_WITH_PRINTED_WORKSPACE
```

This matches the SDK's [workspace derivation](../crates/nemoclaw-sdk/src/config/mod.rs).
The gateway selectors follow the [pinned OpenShell CLI parser and resolver](https://github.com/NVIDIA/OpenShell/blob/1fe79f53991debf32776853a60f0cbd4e127dcfb/crates/openshell-cli/src/main.rs).
The forward or sandbox command below verifies access to the selected workspace; setting an environment variable alone does not.
On an authentication or missing-sandbox error, check the endpoint, workspace, sandbox name, and operator-provided credentials before changing deployment state.

## OpenClaw Dashboard

The selected Fabric adapter owns interface settings, authentication, and native process startup.
NemoClaw preserves these settings and manages sandbox access through OpenShell.
The [dashboard example](../examples/openclaw-dashboard.yaml) declares OpenClaw's native gateway configuration under `harness.settings.native_config.gateway`.
Use the exact adapter identifier `nvidia.fabric.openclaw`; `harness.interfaces` is no longer a configuration field.

A native listener does not publish a host port automatically.
Keep host forwarding bound to loopback and follow the adapter's authentication requirements.
The selected image's canonical Fabric descriptor validates native settings during planning and again before runtime startup.
Missing image metadata leaves compatibility unverified.

## Build and Apply

From the repository root, build the matching image and its installed Fabric metadata:

```sh
python3 image/build_fabric.py --platform linux/arm64 openclaw
```

Select `linux/amd64` on an AMD64 builder.
Follow the [image prerequisites](inference.md#build-an-image-with-the-configuration-interface), including image availability on the sandbox compute daemon.
Replace the dashboard example's image digest, deployment UID, endpoint, and model values, then use the [desired-state workflow](usage.md).
Changes to public Fabric configuration reconcile through the owned agent-configuration resource and restart the runtime inside its existing sandbox.
Image or sandbox policy changes retain the ordinary replacement protections.
These operations do not migrate retained native data from older images.

## Connect through OpenShell

First [select the gateway and workspace](#select-the-gateway-and-workspace).
For the example's port, forward from a private terminal on the client host:

```sh
openshell forward service assistant --target-port 18800 --local 127.0.0.1:18800
```

The foreground command forwards through the authenticated OpenShell connection to the sandbox's loopback service.
Open `http://127.0.0.1:18800` in your browser after verifying that the native service is ready.
Stop forwarding with Ctrl-C.

Native token provisioning, browser pairing, and token rotation belong to the selected Fabric adapter.
A qualified browser-access procedure for the migrated adapter is **TBD**; older NemoClaw token-file paths and `interfaces.py` commands are not part of this runtime contract.
Do not disable native authentication to work around an incomplete procedure.
Keep credentials out of YAML, command arguments, recorded terminals, and shared URLs.

## Diagnose Failures

Check gateway authorization, the UID-derived workspace, sandbox name, native service state, and the configured target port independently.
Inspect the [native logs](troubleshooting.md#read-native-service-logs) through the retained sandbox binding.
A working forward does not establish that the native UI has valid authentication or a working model connection.

NemoClaw compares the retained public Fabric configuration with the runtime host's configuration and preserves resource identities on failure.
Fabric owns native file validation and service diagnostics.
Correct the reported conflict before reapplying; do not delete retained state to hide drift.
Offline configuration tests do not qualify browser rendering or public dashboard access.

## Hermes API, Dashboard, and Browser TUI

The [Hermes interface example](../examples/hermes-interfaces.yaml) selects `nvidia.fabric.hermes` and declares native interface settings in `harness.settings`:

```yaml
settings:
  mode: service
  interfaces:
    api:
      port: 8643
    dashboard:
      enabled: true
      port: 18800
      internalPort: 19120
      tui:
        enabled: true
```

Fabric's descriptor and adapter own accepted ports, defaults, authentication, and the relationship between API and dashboard sessions.
NemoClaw does not select a different adapter because tracing or search is configured.
Native interface and telemetry options must be accepted by the exact adapter installed in the selected image.
See [native controls](agents.md#native-controls-at-initialization) for their ownership boundary.

### Build and Connect

Follow the [image prerequisites](inference.md#build-an-image-with-the-configuration-interface) and build from the repository root:

```sh
python3 image/build_fabric.py --platform linux/arm64 hermes
```

Replace the example's image digest and deployment-specific values, then apply using the [desired-state workflow](usage.md).
After [selecting the gateway and workspace](#select-the-gateway-and-workspace), run each required forward in its own terminal:

```sh
openshell forward service assistant --target-port 18800 --local 127.0.0.1:18800
openshell forward service assistant --target-port 8643 --local 127.0.0.1:8643
```

Keep forwarding bound to loopback.
Follow the installed Fabric adapter's authentication contract before using either service.
Native browser login, session continuity, and credential rotation for this migration remain **TBD** pending qualification.
Stopping a client forward does not stop the managed sandbox or Fabric runtime.
