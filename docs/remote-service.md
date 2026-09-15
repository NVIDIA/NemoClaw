<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configure an SSH Model Service

[remote-vllm.yaml](../examples/remote-vllm.yaml) manages a Docker inference service through SSH while an existing native OpenShell gateway owns Podman sandboxes.
`service.placement` selects the SSH engine and its private Docker network.
`service.publication` declares the private host address and inference URL that OpenShell can reach.
Existing `providerRef` routes remain unchanged.
No engine registry or per-sandbox placement override is required.

Replace the example SSH alias, gateway endpoint, and private publication address with your hosts.
Publication currently requires a private IPv4 address, the service's port and `/v1` path.
It uses HTTP without model credentials.

The remote host must meet the existing Linux ARM64 DGX Spark hardware profile and have Docker, Python 3 and `nvidia-smi`.
Configure SSH authentication and host trust beforehand.
Managed volume observation uses that daemon's reported data root, including a non-default root; it never substitutes the client host's storage path.

Load the pinned runtime image into the selected Docker daemon; the example's experiment image has not been published.
Load the sandbox image into Podman.

Use a fresh deployment UID and a dedicated state directory.
From the repository root, preview and apply the configuration:

```sh
nemoclaw plan --state-dir .local/remote examples/remote-vllm.yaml
nemoclaw apply --state-dir .local/remote examples/remote-vllm.yaml
```

Apply creates retained model storage and the inference network/container on the SSH target, checks preparation receipts and readiness there, then configures the sandbox's OpenShell route.
Plan reads remote capacity and resource state without creating runtime resources.
Changing a bound engine endpoint requires migration and is rejected.

Failed observations never authorize recreation.
Destroy retains model data and network.

The bundled fixture lifecycle and a live two-daemon DGX Spark test are qualified.
The live test used a second Docker daemon in a network namespace, SSH control, rootless Podman sandboxes, and actual OpenClaw replies through OpenShell.
See [the validation evidence](validation/rust-dual-daemon-linux-arm64.json).

Both daemons shared the physical host and GPU; a separate-host deployment and other hardware remain qualification gates.

A successful apply includes an agent response through OpenShell.
On failure, retain the configuration and state directory for [explicit recovery](usage.md#updates-and-recovery).
Use [the destroy procedure](usage.md#destroy) when retiring the deployment.
