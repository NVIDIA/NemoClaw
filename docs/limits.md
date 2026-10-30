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
| Managed vLLM or Ollama on a host with two or more GPUs, using `container.gpu` to pick one, and the capacity data sources' `gpu`, have not been run on such a host | [#13743](https://github.com/NVIDIA/NemoClaw/issues/13743) |
| AMD64 Nemotron image and GPU inference | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Local GPU deployment on Windows/WSL or macOS | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A model service on a separate physical SSH host | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Distributed inference across several Sparks or Stations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Podman beyond a local rootless Linux gateway: managed inference, rootful operation and remote engines | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| OpenShift beyond [one OpenShift Local node qualified by hand](kubernetes.md); no automated run enforces OpenShift's security constraints, since kind runs the OpenShift profile without them | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Changing a managed Kubernetes or OpenShift gateway's CPU and memory: NemoClaw sets the chart's `resources` to requests of 250m CPU and 256Mi and limits of 1 CPU and 1Gi | [#13835](https://github.com/NVIDIA/NemoClaw/issues/13835) |
| Choosing the StorageClass of a managed Kubernetes or OpenShift gateway's own volume: it uses the cluster's default, because NemoClaw doesn't pass the chart's `server.dataStorageClass` | [#13829](https://github.com/NVIDIA/NemoClaw/issues/13829) |
| Model services that NemoClaw places with a Kubernetes or OpenShift gateway; sandboxes can use [a server you run in the cluster](kubernetes.md#use-a-model-server-in-the-cluster) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| [A model server you run in the cluster](kubernetes.md#use-a-model-server-in-the-cluster) has been tried on one kind cluster with NemoClaw's vLLM runtime behind a key ([#13546](https://github.com/NVIDIA/NemoClaw/issues/13546)) and its Ollama runtime, and with Ollama on one OpenShift Local node; vLLM on OpenShift and other network plugins are untested | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Live GPU inference, tools and replies through managed Ollama | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Gated repositories, custom remote-code models, GGUF in vLLM, and nested Hugging Face checkpoints | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A tested matrix of harness, model, provider and platform combinations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |

## Inference

| Limit | Issue |
|---|---|
| Fabric reports a harness process that exited as unknown rather than stopped, so plan doesn't [start it again](usage.md#agent-runtimes-during-apply); the runtime is found at its next invocation | [NVIDIA/NeMo-Fabric#298](https://github.com/NVIDIA/NeMo-Fabric/issues/298) |
| Hermes doesn't reject a managed Ollama window below its 64,000-token minimum, because Ollama reports the model's native window; see [sizing the context for Hermes](inference.md#size-the-context-for-hermes) | [NousResearch/hermes-agent#141641](https://github.com/NousResearch/hermes-agent/issues/141641) |
| Managed llama.cpp, Model Router and Gemini | [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035) |
| Guides for named hosted providers such as NVIDIA, OpenAI, Anthropic, OpenRouter and Nous | [#12038](https://github.com/NVIDIA/NemoClaw/issues/12038) |
| Managed NVIDIA NIM service | [#12649](https://github.com/NVIDIA/NemoClaw/issues/12649) |

## Agents and Integrations

| Limit | Issue |
|---|---|
| Messaging channels | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) |
| Managed MCP servers | [#12137](https://github.com/NVIDIA/NemoClaw/issues/12137) |
| Hermes OAuth and managed tools | [#12042](https://github.com/NVIDIA/NemoClaw/issues/12042) |
| Hermes's native API server, dashboard and browser TUI | [#13321](https://github.com/NVIDIA/NemoClaw/issues/13321) |
| OpenClaw's dashboard | [#13360](https://github.com/NVIDIA/NemoClaw/issues/13360) |
| OpenClaw's Brave and Tavily web search plugins | [#13361](https://github.com/NVIDIA/NemoClaw/issues/13361) |
| Collector provisioning, production collector troubleshooting and Deep Agents trace export | [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144) |
| Tavily and Brave search have not been tested live through OpenShell | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |

## Access and Diagnostics

| Limit | Issue |
|---|---|
| The OpenClaw request walkthrough, rehearsed once OpenClaw starts in a sandbox | [#13372](https://github.com/NVIDIA/NemoClaw/issues/13372) |
| A live rehearsal against an external gateway that requires an issuer or mTLS client certificates | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A managed Kubernetes gateway with the `development` profile gives you no `openshell` access of your own; the `oidc` profile [reaches it from the OpenShell CLI](kubernetes.md#reach-the-gateway-from-the-openshell-cli), and those steps have not been run on a cluster | By design: the development issuer serves only NemoClaw |

## Data and Cleanup

| Limit | Issue |
|---|---|
| Native conversation continuity across runtime replacement | [Per-harness limits](state.md#choose-what-to-retain-for-each-harness); depends on Fabric and the selected harness |
| Backup, restore, snapshots and transfer of mounted agent data | [Platform-owned storage](state.md#keep-agent-files-on-mounted-volumes); no NemoClaw command |
| Moving data from the earlier product to v1 and back | No NemoClaw procedure; native data belongs to the harness and moving its storage to the platform ([migration](migration.md)) |
| Verified removal of retained objects on SSH engines; the [Docker procedure](usage.md#remove-retained-resources) covers them | [#12640](https://github.com/NVIDIA/NemoClaw/issues/12640) |

## Security

| Limit | Issue |
|---|---|
| Host-specific security qualification | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| An inference endpoint whose certificate comes from a CA that OpenShell's supervisor image doesn't trust; OpenShell's provider registrations take no CA ([custom CA trust](inference.md#trust-a-custom-certificate-authority)) | [#13834](https://github.com/NVIDIA/NemoClaw/issues/13834), [NVIDIA/OpenShell#3295](https://github.com/NVIDIA/OpenShell/issues/3295) |
| A corporate CA for OpenShell's gateway and sandbox egress, managed model downloads, and image builds | [Corporate CA](security.md#trust-a-corporate-certificate-authority) |
| [Proxy](sandbox-network.md#use-an-upstream-proxy) credentials for a managed Docker or Podman gateway: OpenShell reads them only from a file on the gateway (`proxy_auth_file`), which NemoClaw doesn't mount | [#13835](https://github.com/NVIDIA/NemoClaw/issues/13835) |
| A proxy CA (`proxy_ca_bundle`) for any managed gateway: Docker and Podman read it from a file on the gateway, and the chart mounts it only from its `upstreamProxy.caBundle.configMapName` value, which NemoClaw doesn't set | [#13835](https://github.com/NVIDIA/NemoClaw/issues/13835) |
| OAuth-refresh credentials have no NemoClaw YAML wrapper; use [operator-managed OpenShell providers](oauth-refresh.md), with separate sandbox attachments | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652) |
| Interactive network-request approval, named policy presets, and explaining policy to an agent | [#12651](https://github.com/NVIDIA/NemoClaw/issues/12651) |

## SDK and Provider

| Limit | Issue |
|---|---|
| Configuration or state migration between releases | Not during alpha; see [compatibility](compatibility.md) |
| A hosted Rust API reference | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| `tofu import`, adoption, and remote state for CLI and SDK deployments | Not supported; see [compatibility](compatibility.md) |

## Documentation Site

| Limit | Issue |
|---|---|
| Public publication of the combined documentation site, with a check of its legacy routes | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| Search and docs MCP scoped to v1 | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| Packaged installation of the documentation skill for assistant clients | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
