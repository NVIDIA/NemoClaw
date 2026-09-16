<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fabric Harnesses

Choose a harness before selecting an image, inference API, and management mode.
This matrix describes accepted configuration combinations, not live qualification of every model or host.
Use [inference API selection](../inference.md#choose-the-request-api) for the protocol restrictions and [agent access](../agents.md#choose-native-access) for interaction and session behavior.

| `harness.kind` | Agents per sandbox | Gateway and inference management | Maintained example |
|---|---|---|---|
| `openclaw` | One or more; per-agent model choices | External or managed | [OpenClaw](../../examples/fabric-openclaw.yaml) |
| `hermes` | One | External or managed | [Hermes](../../examples/fabric-hermes.yaml), [managed Hermes](../../examples/managed-hermes.yaml) |
| `deepagents` | One | External only | [Deep Agents](../../examples/fabric.yaml) |
| `claude` | One | External only | [Claude](../../examples/fabric-claude.yaml) |
| `codex` | One | External only | [Codex](../../examples/fabric-codex.yaml) |
| `mini-swe-agent` | One | External only | [Mini SWE Agent](../../examples/fabric-mini-swe-agent.yaml) |
| `nooa` | One | External only | [Nooa](../../examples/fabric-nooa.yaml) |
| `nooa-bench` | One | External only | [Nooa Bench](../../examples/fabric-nooa-bench.yaml) |
| `remote-agent` | One | External only | [Remote Agent](../../examples/fabric-remote-agent.yaml) |
| `pi` | One | External only | [Pi](../../examples/fabric-pi.yaml) |

Managed inference means an accepted Ollama or vLLM service configuration, with that mode's prerequisites.
It does not promise arbitrary model compatibility.
OpenClaw and Hermes also accept external Ollama with a managed proxy; the inference provider stays `management: external`, while NemoClaw manages only the proxy and its credential storage.
External services remain operated by their owners; NemoClaw still owns its deployment's provider registration, endpoint profile, and sandbox.

Build an image for the selected harness using [the Fabric image procedure](../inference.md#build-an-image-with-the-configuration-interface).
Replace example identities, endpoints, and local/placeholder image digests with your own values.
Keep the image, schema, and bundle matched to the desired configuration.
Hermes uses the local API/dashboard adapter by default; experimental [Relay tracing](../agents.md#hermes-relay-tracing) selects an upstream adapter without those interfaces.

The [configuration validator](../../crates/nemoclaw-sdk/src/config/validation.rs) enforces the harness restrictions.
[Retained evidence](../validation/README.md) distinguishes native protocol fixtures from live inference at specific revisions.
Complete first-message procedures and a release-qualified harness/model/platform matrix: **TBD**.
