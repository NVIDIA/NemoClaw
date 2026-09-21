<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configure an SSH Model Service

[remote-vllm.yaml](../examples/spark/remote-vllm.yaml) manages a Docker inference service through SSH while an existing native OpenShell gateway owns Podman sandboxes.
The pinned OpenShell Podman supervisor currently has a [TLS initialization bug](https://github.com/NVIDIA/OpenShell/issues/3427) that blocks provider traffic.
Use an existing Docker gateway with `runtime.provider: docker` to exercise SSH inference while that Podman issue remains open.
Declare the service under `spec.services.<name>` and select it from an inference provider with `serviceRef`.
Its `placement.engine` selects the SSH Docker endpoint, and the rest of `placement` selects its private Docker network.
Its `publication` declares the private host address and inference URL that OpenShell can reach.
Existing `providerRef` routes remain unchanged.
No engine registry or per-sandbox placement override is required.

Replace the example SSH alias, gateway endpoint, and private publication address with your hosts.
Publication currently requires a private IPv4 address, the service's port and `/v1` path.
It uses private HTTP; enable [managed bearer authentication](inference.md#authenticate-a-managed-vllm-service) with `authentication: bearer` on the service.
Omission preserves unauthenticated serving.

The remote host must satisfy its service's hardware contract and provide Docker with NVIDIA container GPU access.
The runtime image performs hardware and memory observation inside the container; normal deployment does not require the SDK's Python SSH capacity collector.
The existing example uses Linux ARM64 DGX Spark; [the Nemotron example](models.md#configure-nemotron-on-an-amd64-gpu-host) declares an AMD64 GPU with dedicated memory.
Configure SSH authentication and host trust beforehand.
Docker resolves named cache and credential mounts in the selected daemon's storage namespace; it never substitutes the client host's storage path.

Load the pinned runtime image into the selected Docker daemon; the example's runtime image has not been published.
Load the sandbox image into Podman.

Use a fresh deployment UID and a dedicated state directory.
From the repository root, preview and apply the configuration:

```sh
nemoclaw plan --state-dir .local/remote examples/spark/remote-vllm.yaml
nemoclaw apply --state-dir .local/remote examples/spark/remote-vllm.yaml
```

Apply creates retained model storage and provider-managed inference compute on the SSH target, waits for application readiness, then configures the sandbox's OpenShell route.
Plan reads provider resource state without collecting host capacity or model inventories.
Hardware, startup memory, and preparation failures are reported by the runtime during apply.
Bound credentials cannot move to another engine through ordinary apply.
Cache and compute use native Docker-provider reconciliation; a cross-host transfer is not qualified, so use a fresh deployment and state for another host.

Failed observations stop the operation; confirmed missing service compute can be recreated during explicit apply.
Destroy retains model data and credentials and removes the service-owned network.

The earlier custom-controller lifecycle was qualified by a live two-daemon DGX Spark test.
That retained result does not qualify the current Docker-provider path on GPU hardware.
The live test used a second Docker daemon in a network namespace, SSH control, rootless Podman sandboxes, and actual OpenClaw replies through OpenShell.
See [the recorded test results](validation/rust-dual-daemon-linux-arm64.json).

Both daemons shared the physical host and GPU; a separate-host deployment and other hardware remain qualification gates.

A successful apply establishes configuration and readiness.
Verify an agent response through OpenShell separately using [inference verification](inference.md#verify-the-result).
On failure, retain the configuration and state directory for [explicit recovery](usage.md#updates-and-recovery).
Use [the destroy procedure](usage.md#destroy) when retiring the deployment.
