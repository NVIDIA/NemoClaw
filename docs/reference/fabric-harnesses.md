<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Harnesses

Choose a harness before selecting an image, inference API, and management mode.
The table lists maintained examples, not a closed set of supported identifiers or live qualification of every model and host.
Available adapters and native settings constraints come from canonical Fabric descriptors packaged in the selected image.
Without target metadata, the bundled catalog provides provisional suggestions and compatibility remains unknown.
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

Managed inference means an accepted Ollama or vLLM service configuration, with that mode's prerequisites.
It does not promise arbitrary model compatibility.
The selected adapter’s settings schema supplies native constraints.
The current Fabric descriptor contract does not establish API-subtype compatibility for every adapter; missing claims remain unknown.
Apply verifies configuration and readiness without generating a model response.
The external Ollama proxy uses OpenAI Completions; Fabric metadata determines adapter compatibility.
The inference provider stays `management: external`, while NemoClaw manages only the proxy and its credential storage.
External services remain operated by their owners; NemoClaw still owns its deployment's provider registration, endpoint profile, and sandbox.

Build an image for the selected harness using [the Fabric image procedure](../inference.md#build-an-image-with-the-configuration-interface).
Replace example identities, endpoints, and local/placeholder image digests with your own values.
Keep the image, schema, and bundle matched to the desired configuration.
Hermes service mode is selected explicitly through its Fabric settings; [Relay tracing](../agents.md#hermes-relay-tracing) does not change the adapter identifier.

The [configuration validator](../../crates/nemoclaw-sdk/src/config/validation.rs) checks deployment structure and transport contracts.
[Fabric compatibility assessment](../../crates/nemoclaw-sdk/src/fabric_capabilities.rs) checks the advertised native constraints for both onboarding and OpenTofu planning.
[Recorded test results](../validation/README.md) distinguish native protocol fixtures from live inference at specific revisions.
Complete first-message procedures and a release-qualified harness/model/platform matrix: **TBD**.
