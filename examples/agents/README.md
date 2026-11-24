<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Examples

Each file runs one agent using an existing Docker-backed OpenShell gateway and model endpoint.
For a managed gateway and hosted inference, start with the [Docker example](../platforms/docker/README.md).

## Choose an Agent

| Configuration | Purpose and additional setup |
|---|---|
| [fabric-openclaw.yaml](fabric-openclaw.yaml) | OpenClaw with one model route |
| [local.yaml](local.yaml) | OpenClaw using an existing local endpoint |
| [openclaw.yaml](openclaw.yaml) | OpenClaw with explicit Docker image inspection, Responses API, and an output-token limit |
| [fabric-hermes.yaml](fabric-hermes.yaml) | Hermes with one model route; select a model and context size that meet the [Hermes requirements](../../docs/agents-inference/inference.md#sizing-the-context-for-hermes) |
| [fabric.yaml](fabric.yaml) | LangChain Deep Agents with one model route |
| [fabric-claude.yaml](fabric-claude.yaml) | Claude with an Anthropic Messages-compatible endpoint |
| [fabric-codex.yaml](fabric-codex.yaml) | Codex with an OpenAI Responses-compatible endpoint |
| [fabric-mini-swe-agent.yaml](fabric-mini-swe-agent.yaml) | Mini SWE Agent with its cost-tracking setting |
| [fabric-nooa.yaml](fabric-nooa.yaml) | Nooa with the coding-agent workflow target |
| [fabric-nooa-bench.yaml](fabric-nooa-bench.yaml) | Nooa Bench adapter |
| [fabric-opencode.yaml](fabric-opencode.yaml) | OpenCode running on Bun inside its agent image |
| [fabric-pi.yaml](fabric-pi.yaml) | Pi with explicit model context, input, and cost metadata |
| [fabric-remote-agent.yaml](fabric-remote-agent.yaml) | Fabric's Remote Agent adapter; replace both the inference endpoint and the harness's `settings.base_url` |

## Prepare and Verify

Build the selected harness image and native bundle using the [build guide](../../docs/build-deploy/build.md).
The existing gateway must have access to that image and a compatible model endpoint.
Replace the deployment UID, gateway endpoint, image reference, inference endpoint, and model ID in a private copy.
Add an inference credential environment reference if your endpoint requires one.
The [harness reference](../../docs/references/fabric-harnesses.md) defines protocol compatibility and adapter limits.

Follow the [YAML run procedure](../README.md#prepare-and-run-a-yaml-example), then send a request to the selected agent.
Expect one sandbox and one ready runtime; a completed invocation establishes an answer separately.
Destroy removes the owned agent resources while the external gateway and model service remain.

All files receive the [shared configuration checks](../README.md#verification-status).
Adapter fixture contracts check maintained mappings, not the availability of the example's development images or a live model response.
No new live evidence is claimed for these configurations.
