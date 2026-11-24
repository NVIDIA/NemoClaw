<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw on Docker with Hosted Inference

[openclaw-hosted.yaml](openclaw-hosted.yaml) creates a managed Docker gateway and one OpenClaw sandbox using NVIDIA hosted inference.
It starts no local model service and needs no local GPU.
This is also the starter configuration consumed by the authoring tools.

## Prepare and Run

1. Complete the [native bundle and agent-image build prerequisites](../../../docs/build-deploy/build.md).
   Build the OpenClaw image for the Linux architecture of the Docker engine that will run the sandbox, and make its immutable reference available there.
2. Copy `examples/platforms/docker/openclaw-hosted.yaml` into a private deployment directory using the [shared procedure](../../README.md#prepare-and-run-a-yaml-example).
3. Replace the deployment UID and agent image reference, and select the Docker engine if its default socket does not apply.
   Keep the hosted endpoint and model, or select a compatible model available to your account.
4. Supply `NVIDIA_API_KEY` to the applying process through a protected environment facility.
   Requests can incur cloud inference charges; follow [credential storage and ownership](../../../docs/build-deploy/usage.md#configuration-and-credentials).
5. Run the shared plan, apply, request, export/reapply, and destroy steps.

Expect one managed gateway and one ready OpenClaw runtime.
Send a [headless request](../../../docs/agents-inference/agents.md#running-one-headless-openclaw-request) to verify that the model answers.
An unchanged apply should make no resource changes.
Destroy retains gateway storage under the documented retention contract.

## Verification Status

The YAML receives schema, round-trip, and compiler checks, and authoring tests use it as their starter document.
Those checks do not establish that its hosted model answers from your environment.
No new live deployment or model-response evidence is claimed for this example.
