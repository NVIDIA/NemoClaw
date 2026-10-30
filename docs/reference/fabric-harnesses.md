<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Harnesses

Choose a harness before selecting an image, inference API, and management mode.
The table lists maintained examples, not a closed set of supported identifiers or live qualification of every model and host.
Available adapters and native settings constraints come from canonical Fabric descriptors packaged in the selected image.
Onboarding offers choices from the bundled catalog; without target metadata, compatibility remains unknown.
Use [inference API selection](../inference.md#choose-the-request-api) for the protocol restrictions and [agent access](../agents.md#choose-native-access) for interaction and session behavior.

| `harness.kind` | Agents per sandbox | Gateway and inference management | Maintained example |
|---|---|---|---|
| `nvidia.fabric.openclaw` | One; named model choices | External or managed | [OpenClaw](../../examples/fabric-openclaw.yaml) |
| `nvidia.fabric.hermes` | One | External or managed | [Hermes](../../examples/fabric-hermes.yaml), [managed Hermes](../../examples/managed-hermes.yaml) |
| `nvidia.fabric.langchain.deepagents` | One | External or managed, subject to API compatibility | [Deep Agents](../../examples/fabric.yaml) |
| `nvidia.fabric.claude` | One | External or managed, subject to Anthropic Messages compatibility | [Claude](../../examples/fabric-claude.yaml) |
| `nvidia.fabric.codex` | One | External or managed, subject to API compatibility | [Codex](../../examples/fabric-codex.yaml) |
| `nvidia.fabric.mini-swe-agent` | One | External or managed, subject to API compatibility | [Mini SWE Agent](../../examples/fabric-mini-swe-agent.yaml) |
| `nvidia.fabric.nooa` | One | External or managed, subject to API compatibility | [Nooa](../../examples/fabric-nooa.yaml) |
| `nvidia.fabric.nooa.bench-agent` | One | External or managed, subject to API compatibility | [Nooa Bench](../../examples/fabric-nooa-bench.yaml) |
| `nvidia.fabric.remote-agent` | One | External or managed, subject to API compatibility | [Remote Agent](../../examples/fabric-remote-agent.yaml) |
| `nvidia.fabric.pi` | One | External or managed, subject to API compatibility | [Pi](../../examples/fabric-pi.yaml) |
| `nvidia.fabric.opencode` | One | External or managed, subject to API compatibility | [OpenCode](../../examples/fabric-opencode.yaml) |
| `nvidia.fabric.langchain.deepagents-code` | One | External or managed, subject to API compatibility | [Deep Agents Code](../../examples/fabric-deepagents-code.yaml) |

Managed inference means an accepted Ollama or vLLM service configuration, with that mode's prerequisites.
It does not promise arbitrary model compatibility.
The selected adapter’s settings schema supplies native constraints.
The current Fabric descriptor contract does not establish API-subtype compatibility for every adapter; missing claims remain unknown.
OpenCode and Deep Agents Code refuse a plain-HTTP model endpoint outside loopback unless `harness.settings.insecure_http_model_hosts` lists its host, and Claude Code, Codex, and Pi do the same when NeMo Relay is enabled.
For an adapter whose settings declare `insecure_http_model_hosts`, NemoClaw adds the host of each such endpoint the deployment sends, and keeps any hosts you list.
Apply verifies configuration and readiness without generating a model response.
The external Ollama proxy uses OpenAI Completions; Fabric metadata determines adapter compatibility.
The inference provider stays `management: external`, while NemoClaw manages only the proxy and its credential storage.
External services remain operated by their owners; NemoClaw still owns its deployment's provider registration, endpoint profile, and sandbox.

Build an image for the selected harness using [the agent image procedure](../build.md#build-agent-images).
Replace example identities, endpoints, and local/placeholder image digests with your own values.
Keep the image, schema, and bundle matched to the desired configuration.
[Relay tracing](../agents.md#hermes-relay-tracing) does not change Hermes's adapter identifier.

The [configuration validator](../../crates/nemoclaw-sdk/src/config/validation.rs) checks deployment structure and transport contracts.
[Fabric compatibility assessment](../../crates/nemoclaw-fabric/src/capabilities.rs) checks the advertised native constraints for both onboarding and OpenTofu planning.
The [first-request procedure](../agents.md#run-one-deep-agents-or-pi-request) has been rehearsed with Hermes, Deep Agents, Pi and OpenCode; a tested harness, model and platform matrix is tracked in [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641).
