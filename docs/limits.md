<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Limits

v1 is in development and has no release.
This page lists what it does not do yet or has not tested, with the GitHub issue that tracks each.
Other pages state a limit where it affects a procedure and link the same issue.

## Installation and Releases

| Limit | Issue |
|---|---|
| No release, installer or release downloads; build the bundle from source | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| The SDK and provider packages are not published | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| No support policy or enterprise deployment qualification | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |

## Platforms, Models, and Placement

| Limit | Issue |
|---|---|
| Linux AMD64 deployment has not reached an agent reply end to end | [#11997](https://github.com/NVIDIA/NemoClaw/issues/11997) |
| No general DGX Station setup procedure; most Station configurations are untested | [#12122](https://github.com/NVIDIA/NemoClaw/issues/12122) |
| Managed Ollama with OpenClaw on DGX Station | [#12154](https://github.com/NVIDIA/NemoClaw/issues/12154) |
| AMD64 Nemotron image and GPU inference | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Local GPU deployment on Windows/WSL or macOS | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A model service on a separate physical SSH host | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Distributed inference across several Sparks or Stations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Podman beyond a local rootless Linux gateway: managed inference, rootful operation and remote engines | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| OpenShift admitting the gateway and sandbox pods; kind runs the OpenShift profile but does not enforce its security constraints | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| [Managed vLLM and Ollama on Kubernetes or OpenShift](kubernetes.md#run-a-managed-model-service) have no general inference qualification beyond the [reported GB300 run](design/cluster-inference-compatibility.md#openclaw-context-budget); external gateways, host IPC, PVC adoption/resize, and distributed serving are unsupported | [#12732](https://github.com/NVIDIA/NemoClaw/issues/12732) |
| A managed Kubernetes gateway authenticating through an existing identity provider; only the development profile exists | [#12692](https://github.com/NVIDIA/NemoClaw/issues/12692) |
| Images from private registries; every runtime pulls anonymously, so images must be public or already present | [#12709](https://github.com/NVIDIA/NemoClaw/issues/12709) |
| Managed Ollama tool execution and GPU/model combinations beyond the [reported GB300 OpenClaw reply](design/cluster-inference-compatibility.md#openclaw-context-budget) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Gated repositories, custom remote-code models, GGUF in vLLM, and nested Hugging Face checkpoints | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A tested matrix of harness, model, provider and platform combinations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |

## Inference

| Limit | Issue |
|---|---|
| Real Fabric adapters report health as unsupported, so [apply fails at agent readiness](usage.md#fabric-health-during-apply) | [#12443](https://github.com/NVIDIA/NemoClaw/issues/12443) |
| Managed llama.cpp, Model Router and Gemini | [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035) |
| Guides for named hosted providers such as NVIDIA, OpenAI, Anthropic, OpenRouter and Nous | [#12038](https://github.com/NVIDIA/NemoClaw/issues/12038) |
| Managed NVIDIA NIM service | [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649) |
| Vendor model catalogs during onboarding | [#12650](https://github.com/NVIDIA/NemoClaw/issues/12650) |

## Agents and Integrations

| Limit | Issue |
|---|---|
| Messaging channels | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) |
| Managed MCP servers | [#12137](https://github.com/NVIDIA/NemoClaw/issues/12137) |
| Hermes OAuth and managed tools | [#12042](https://github.com/NVIDIA/NemoClaw/issues/12042) |
| Collector provisioning, production collector troubleshooting and Deep Agents trace export | [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144) |
| Tavily and Brave search have not been tested live through OpenShell | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |

## Access and Diagnostics

| Limit | Issue |
|---|---|
| Native login, browser pairing and token rotation, rehearsed from apply to a first reply for each harness | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |
| A headless request walkthrough, and Hermes Relay tracing with retained sessions | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |
| Log collection for other harnesses, Hermes dashboard logs and an inaccessible sandbox | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |
| Creating an authenticated OpenShell CLI profile for an external gateway | [#12642](https://github.com/NVIDIA/NemoClaw/issues/12642) |

## Data and Cleanup

| Limit | Issue |
|---|---|
| Backup, restore, snapshots and transfer of native agent data | [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639) |
| File locations for harnesses other than OpenClaw, Hermes and Pi | [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639) |
| Moving data from the earlier product to v1 and back | [#12639](https://github.com/NVIDIA/NemoClaw/issues/12639) |
| A purge command or verified procedure to remove retained resources | [#12640](https://github.com/NVIDIA/NemoClaw/issues/12640) |

## Security

| Limit | Issue |
|---|---|
| A threat model, host-specific security qualification and hardening profiles | [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643) |
| Corporate CA provisioning across the client, image builds, gateway and native runtimes | [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643) |
| A rotation runbook for every credential type | [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643) |
| Privacy review and retention guidance for production tracing | [#12643](https://github.com/NVIDIA/NemoClaw/issues/12643) |
| Okta and Entra runtime identity | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652) |
| Interactive network-request approval, named policy presets, and explaining policy to an agent | [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651) |

## SDK and Provider

| Limit | Issue |
|---|---|
| A compatibility policy for the SDK, provider, schema and state across releases | [#12645](https://github.com/NVIDIA/NemoClaw/issues/12645) |
| A hosted Rust API reference | [#12645](https://github.com/NVIDIA/NemoClaw/issues/12645) |
| Supported HCL examples, import, adoption and remote-state backends | [#12645](https://github.com/NVIDIA/NemoClaw/issues/12645) |
| Typed HCL schemas for gateway and Kubernetes resources, which take one SDK-compiled `spec` string | [#12782](https://github.com/NVIDIA/NemoClaw/issues/12782) |

## Documentation Site

| Limit | Issue |
|---|---|
| Public publication of the combined documentation site, with a check of its legacy routes | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| Search and docs MCP scoped to v1 | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| Packaged installation of the documentation skill for assistant clients | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
