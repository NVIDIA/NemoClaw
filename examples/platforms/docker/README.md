<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Docker Examples

| Scenario | Examples |
|---|---|
| Hosted inference without a local GPU | [OpenClaw starter](../../onboarding/openclaw.yaml), with the procedure in this README |
| Managed Ollama on DGX Spark | [OpenClaw and Hermes](ollama/dgx-spark/README.md) |
| Managed vLLM on DGX Spark | [One or several agents and model services](vllm/dgx-spark/README.md) |
| Managed vLLM on DGX Station | [Qwen and Nemotron configurations](vllm/dgx-station/README.md) |
| Managed vLLM on RTX Spark through WSL2 | [Nemotron variants](vllm/rtx-spark-wsl2/README.md) |
| Remote AMD64 vLLM with a local Docker gateway | [Three OpenClaw sandboxes and a shared policy](vllm/remote/amd64/README.md) |

## OpenClaw with Hosted Inference

[openclaw.yaml](../../onboarding/openclaw.yaml) creates a managed Docker gateway and one OpenClaw sandbox using NVIDIA hosted inference.
It starts no local model service and needs no local GPU.
This is also the starter configuration consumed by the authoring tools.

## Prepare and Run

1. Complete the [native bundle and agent-image build prerequisites](../../../docs/build-deploy/build.md).
   Build the OpenClaw image for the Linux architecture of the Docker engine that will run the sandbox, and make its immutable reference available there.
2. Copy `examples/onboarding/openclaw.yaml` into a private deployment directory using the [shared procedure](../../README.md#prepare-and-run-a-yaml-example).
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
