<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuring an SSH Model Service

The [remote-vllm.yaml](../../examples/platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml) example manages a Docker inference service through SSH while an existing native NVIDIA OpenShell gateway owns Podman sandboxes.
Declare the service under `spec.services.<name>` and select it from an inference provider with `serviceRef`.
Its `placement.engine` selects the SSH Docker endpoint, and the rest of `placement` selects its private Docker network.
Its `publication` declares the private host address and inference URL that OpenShell can reach.
Existing `providerRef` routes remain unchanged.
No engine registry or per-sandbox placement override is required.

Replace the example SSH alias, gateway endpoint, and private publication address with your hosts.
Publication currently requires a private IPv4 address, the service's port, and the `/v1` path.
It uses private HTTP.
Enable [managed bearer authentication](inference.md#authenticating-a-managed-vllm-service) with `authentication: bearer` on the service.
Omission preserves unauthenticated serving.

The remote host must satisfy its service's hardware contract and provide Docker with NVIDIA container GPU access.
The runtime image performs hardware and memory observation inside the container.
Normal deployment doesn't require the provider's optional SSH capacity collector.
The existing example uses Linux ARM64 NVIDIA DGX Spark.
[The Nemotron example](models.md#configuring-nemotron-on-an-amd64-gpu-host) declares an AMD64 GPU with dedicated memory.
Configure SSH authentication and host trust beforehand.
Docker resolves named cache and credential mounts in the selected daemon's storage namespace.
It never substitutes the client host's storage path.

Load the pinned runtime image into the selected Docker daemon.
The example's runtime image hasn't been published.
Load the sandbox image into Podman.

Use a fresh deployment UID and a dedicated state directory.
From the repository root, preview and apply the configuration:

```sh
nemoclaw plan --state-dir .local/remote examples/platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml
nemoclaw apply --state-dir .local/remote examples/platforms/podman/vllm/remote/dgx-spark/remote-vllm.yaml
```

Apply creates retained model storage and provider-managed inference compute on the SSH target, waits for application readiness, then configures the sandbox's OpenShell route.
Plan reads provider resource state without collecting host capacity or model inventories.
The runtime reports hardware, startup memory, and preparation failures during apply.
Bound credentials can't move to another engine through apply.
Cache and compute use native Docker-provider reconciliation.
A cross-host transfer isn't qualified, so use a fresh deployment and state for another host.

Failed observations stop the operation.
Confirmed missing service compute can be recreated during explicit apply.
Destroy retains model data and credentials and removes the service-owned network.
To remove that retained data, follow [Removing Retained Resources](../build-deploy/usage.md#removing-retained-resources) on the SSH engine.

No live test places a model service through SSH on GPU hardware.
A separate-host deployment and other hardware remain qualification gates ([#12641](https://github.com/NVIDIA/NemoClaw/issues/12641)).

A successful apply establishes configuration and readiness.
Verify an agent response through OpenShell separately using [inference verification](inference.md#verifying-the-result).
On failure, retain the configuration and state directory for [explicit recovery](../build-deploy/usage.md#updates-and-recovery).
Use [the destroy procedure](../build-deploy/usage.md#destroying) when retiring the deployment.
