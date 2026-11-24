<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Remote AMD64 Inference

[nemotron-amd64.yaml](nemotron-amd64.yaml) runs OpenClaw on an existing Podman-backed gateway and manages Nemotron Lightning through a remote Docker engine over SSH.
The GPU host is AMD64, with compute capability at least 9.0, at least 96,000,000,000 GPU-memory bytes, and driver major 580 or newer.

Follow [SSH placement setup](../../../../../../docs/agents-inference/remote-service.md) and the [image build guide](../../../../../../docs/build-deploy/build.md).
Build the runtime for AMD64 and the agent image for the sandbox host.
Copy the YAML, assign a new UID, and replace the gateway endpoint, image references, SSH alias, private network, and published inference address.
Keep the model revision pinned and use an address reachable by the gateway.

Use the [shared run procedure](../../../../../README.md#prepare-and-run-a-yaml-example).
Expect one remote managed model service and one agent on the external gateway.
Send an OpenClaw request, check unchanged apply and export/reapply, and destroy only the owned workloads.
The external gateway remains, and model storage is retained under the storage contract.

The file receives schema, round-trip, and compiler checks.
Remote Docker inference with a Podman gateway remains subject to the [documented untested placement boundary](../../../../../../docs/resources/limits.md#platforms-models-and-placement); no new live evidence is claimed.
