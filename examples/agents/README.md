<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Agent Examples

Each file runs one agent using an existing Docker-backed OpenShell gateway and model endpoint.
For a managed gateway and hosted inference, start with the [Docker example](../platforms/docker/README.md).

## Choose an Agent

| Configuration | Purpose and additional setup |
|---|---|
| [openclaw.yaml](openclaw.yaml) | OpenClaw with one model route |
| [hermes.yaml](hermes.yaml) | Hermes with one model route; select a model and context size that meet the [Hermes requirements](../../docs/agents-inference/inference.md#sizing-the-context-for-hermes) |
| [deepagents.yaml](deepagents.yaml) | LangChain Deep Agents with one model route |
| [claude.yaml](claude.yaml) | Claude with an Anthropic Messages-compatible endpoint |
| [codex.yaml](codex.yaml) | Codex with an OpenAI Responses-compatible endpoint |
| [mini-swe-agent.yaml](mini-swe-agent.yaml) | Mini SWE Agent with its cost-tracking setting |
| [nooa.yaml](nooa.yaml) | Nooa with the coding-agent workflow target |
| [nooa-bench.yaml](nooa-bench.yaml) | Nooa Bench adapter |
| [opencode.yaml](opencode.yaml) | OpenCode running on Bun inside its agent image |
| [pi.yaml](pi.yaml) | Pi with explicit model context, input, and cost metadata |
| [remote-agent.yaml](remote-agent.yaml) | Fabric's Remote Agent adapter; replace both the inference endpoint and the harness's `settings.base_url` |

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
