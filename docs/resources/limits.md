<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Limits

v1 is in development and has no release.
This page lists what it does not do yet or has not tested, with the GitHub issue that tracks each.
Other pages state a limit where it affects a procedure and link the same issue.

## Installation and Releases

The source-build workflow does not supply an installer or a published package; keep the matching bundle for an existing deployment.

| Limit | Issue |
|---|---|
| No release, installer or release downloads; build the bundle from source | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| The SDK and provider packages are not published | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |
| No support policy or enterprise deployment qualification | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) |

## Platforms, Models, and Placement

Accepted platform and model declarations are not a tested matrix; verify the exact host and runtime combination before relying on a reply.

| Limit | Issue |
|---|---|
| No general DGX Station setup procedure; most Station configurations are untested | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Managed Ollama with OpenClaw on DGX Station | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| AMD64 Nemotron image and GPU inference | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Local GPU deployment on Windows/WSL or macOS | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A model service on a separate physical SSH host | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Serving one model across several GPUs on one host: `container.gpuDevices` takes one entry, so vLLM refuses a [parallel layout](../agents-inference/models.md#set-the-parallel-layout) larger than one GPU | [#14384](https://github.com/NVIDIA/NemoClaw/issues/14384) |
| Distributed inference across several Sparks or Stations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Podman beyond a local rootless Linux gateway: managed inference, rootful operation and remote engines | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| OpenShift beyond [OpenShift Local runs by hand](../build-deploy/kubernetes.md); no automated run covers OpenShift, and kind can't run a managed `openshift` gateway, which needs OpenShift to assign its `fsGroup` | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A managed OpenShift gateway needs `runtime.provider: openshift`: the pinned chart doesn't leave the gateway's UID and `fsGroup` to OpenShift by itself, so NemoClaw sets both to `null` on that value. This has run by hand on one OpenShift Local 4.22.14 node (linux/amd64) | [#13828](https://github.com/NVIDIA/NemoClaw/issues/13828), [NVIDIA/OpenShell#5483](https://github.com/NVIDIA/OpenShell/issues/5483) |
| Changing a managed Kubernetes or OpenShift gateway's CPU and memory: NemoClaw sets the chart's `resources` to requests of 250m CPU and 256Mi and limits of 1 CPU and 2Gi | [#13835](https://github.com/NVIDIA/NemoClaw/issues/13835) |
| Choosing the StorageClass of a managed Kubernetes or OpenShift gateway's own volume: it uses the cluster's default, because NemoClaw doesn't pass the chart's `server.dataStorageClass` | [#13829](https://github.com/NVIDIA/NemoClaw/issues/13829) |
| Putting a managed Kubernetes or OpenShift gateway behind an ingress or an OpenShift Route: NemoClaw doesn't pass the chart's `grpcRoute` or `openshiftRoute` values; use [an external gateway behind an ingress](../build-deploy/kubernetes.md#reach-an-external-gateway-through-an-ingress) instead | [#14307](https://github.com/NVIDIA/NemoClaw/issues/14307) |
| Model services that NemoClaw places with a Kubernetes or OpenShift gateway; sandboxes can use [a server you run in the cluster](../build-deploy/kubernetes.md#use-a-model-server-in-the-cluster) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| [A model server you run in the cluster](../build-deploy/kubernetes.md#use-a-model-server-in-the-cluster) has been tried on one kind cluster with NemoClaw's vLLM runtime behind a key ([#13546](https://github.com/NVIDIA/NemoClaw/issues/13546)) and its Ollama runtime, and with Ollama on one OpenShift Local node; vLLM on OpenShift and other network plugins are untested | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A gateway published through [`gateway.kubernetes.expose`](../build-deploy/kubernetes.md#publish-the-gateway-outside-the-cluster) on a cluster other than kind | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| NemoClaw's own plan, apply and destroy dialing a [published gateway](../build-deploy/kubernetes.md#publish-the-gateway-outside-the-cluster) instead of port forwards, so they still need `pods/portforward` | [#14422](https://github.com/NVIDIA/NemoClaw/issues/14422) |
| A managed gateway published through a `LoadBalancer` Service: the pinned OpenShell chart's Service takes no annotations or source ranges, and listens on the gateway's own port | [#14421](https://github.com/NVIDIA/NemoClaw/issues/14421) |
| Tool use through managed Ollama, managed Ollama with harnesses other than Hermes, and managed Ollama on GPUs and hosts other than CI's Linux AMD64 [GPU runner](../../internal-docs/contributing/live-tests.md#hcl-e2e-scenarios) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| Gated repositories, custom remote-code models, GGUF in vLLM, and nested Hugging Face checkpoints | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| A tested matrix of harness, model, provider and platform combinations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |

## Inference

A configured connection or ready container does not establish successful model responses.

| Limit | Issue |
|---|---|
| Hermes doesn't reject a managed Ollama window below its 64,000-token minimum; see [sizing the context for Hermes](../agents-inference/inference.md#size-the-context-for-hermes) | [NousResearch/hermes-agent#141641](https://github.com/NousResearch/hermes-agent/issues/141641) |
| Managed llama.cpp, Model Router and Gemini | [#12035](https://github.com/NVIDIA/NemoClaw/issues/12035) |
| Guides for named hosted providers such as NVIDIA, OpenAI, Anthropic, OpenRouter and Nous | [#12038](https://github.com/NVIDIA/NemoClaw/issues/12038) |
| Managed NVIDIA NIM service; use NIM as an external OpenAI-compatible endpoint | Not planned ([#12649](https://github.com/NVIDIA/NemoClaw/issues/12649)) |
| More than 32 providers attached to one sandbox: OpenShell refuses more, and its inference providers, its web search and each `api` integration count one each | By design: OpenShell's limit per sandbox |

## Agents and Integrations

Select the adapter and image together, then verify its integrations and native request path separately from apply.

| Limit | Issue |
|---|---|
| Messaging channels | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) |
| Managed MCP servers | [#12137](https://github.com/NVIDIA/NemoClaw/issues/12137) |
| Hermes OAuth and managed tools | [#12042](https://github.com/NVIDIA/NemoClaw/issues/12042) |
| Agent interfaces are reached by Fabric's P0 conventions; runtime handles don't report them yet | [NVIDIA/NeMo-Fabric#565](https://github.com/NVIDIA/NeMo-Fabric/issues/565) |
| Interface tokens that the agent's own tools can't read, an interface health check, and exposed service URLs for Hermes's dashboard | [NVIDIA/NeMo-Fabric#566](https://github.com/NVIDIA/NeMo-Fabric/issues/566) |
| OpenClaw's Brave and Tavily web search plugins | [#13361](https://github.com/NVIDIA/NemoClaw/issues/13361) |
| Collector provisioning, production collector troubleshooting and Deep Agents trace export | [#12144](https://github.com/NVIDIA/NemoClaw/issues/12144) |
| Tavily and Brave search have not been tested live through OpenShell | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |

## Access and Diagnostics

Access paths and diagnostic signals depend on the gateway and harness in use.

| Limit | Issue |
|---|---|
| The OpenClaw request walkthrough, rehearsed once OpenClaw starts in a sandbox | [#13372](https://github.com/NVIDIA/NemoClaw/issues/13372) |
| A live rehearsal against an external gateway that requires an issuer or mTLS client certificates | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| An error holds at most 16 KiB of a command's OpenTofu diagnostics, such as several managed services' [stop details](../agents-inference/models.md#diagnose-and-recover-a-stopped-runtime): it lists the whole diagnostics that fit, then the next one's summary and a count of the rest; a diagnostic longer than 16 KiB keeps as much of its detail as fits | By design: bounds the error's size |
| An error shows `child output exceeds the supported limit` in place of a command's output when OpenTofu writes more than 16 KiB to standard error, as a provider crash can, or more than 64 MiB to standard output: cut output can end inside a credential that redaction no longer recognizes | By design: keeps credentials out of errors |
| A managed Kubernetes gateway with the `development` profile gives you no `openshell` access of your own; the `oidc` profile [reaches it from the OpenShell CLI](../build-deploy/kubernetes.md#reach-the-gateway-from-the-openshell-cli), which no automated test covers | By design: the development issuer serves only NemoClaw |
| [Service URLs](../agents-inference/interfaces.md#expose-a-service-through-the-gateway) on a managed Kubernetes or OpenShift gateway name `openshell.localhost` and the gateway pod's port, 8080, so they don't open as printed; reach them through a port forward to the gateway, sending the URL's host name and the gateway's client certificate | [#14316](https://github.com/NVIDIA/NemoClaw/issues/14316) |

## Data and Cleanup

Preserve state and native data before attempting a destructive operation.

| Limit | Issue |
|---|---|
| Native conversation continuity across runtime replacement | [Per-harness limits](../build-deploy/state.md#choose-what-to-retain-for-each-harness); depends on Fabric and the selected harness |
| Backup, restore, snapshots and transfer of mounted agent data | [Platform-owned storage](../build-deploy/state.md#keep-agent-files-on-mounted-volumes); no NemoClaw command |
| Moving data from the earlier product to v1 and back | No NemoClaw procedure; native data belongs to the harness and moving its storage to the platform ([migration](../get-started/migration.md)) |

## Security

Sandbox policy and credential routing depend on OpenShell and the host's controls; assess their trust boundaries for your deployment.

| Limit | Issue |
|---|---|
| Host-specific security qualification | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) |
| An inference endpoint whose certificate comes from a CA that OpenShell's supervisor image doesn't trust; OpenShell's provider registrations take no CA ([custom CA trust](../agents-inference/inference.md#trust-a-custom-certificate-authority)) | [#13834](https://github.com/NVIDIA/NemoClaw/issues/13834), [NVIDIA/OpenShell#3295](https://github.com/NVIDIA/OpenShell/issues/3295) |
| A corporate CA for OpenShell's gateway and sandbox egress, managed model downloads, and image builds | [Corporate CA](../security/security.md#trust-a-corporate-certificate-authority) |
| [Proxy](../security/sandbox-network.md#use-an-upstream-proxy) credentials for a managed Docker or Podman gateway: OpenShell reads them only from a file on the gateway (`proxy_auth_file`), which NemoClaw doesn't mount | [#13835](https://github.com/NVIDIA/NemoClaw/issues/13835) |
| A proxy CA (`proxy_ca_bundle`) for any managed gateway: Docker and Podman read it from a file on the gateway, and the chart mounts it only from its `upstreamProxy.caBundle.configMapName` value, which NemoClaw doesn't set | [#13835](https://github.com/NVIDIA/NemoClaw/issues/13835) |
| OAuth-refresh credentials have no NemoClaw YAML wrapper; use [operator-managed OpenShell providers](../agents-inference/oauth-refresh.md), with separate sandbox attachments | [#12652](https://github.com/NVIDIA/NemoClaw/issues/12652) |
| Interactive network-request approval and explaining policy to an agent; OpenShell's policy advisor owns both | Not planned ([#12651](https://github.com/NVIDIA/NemoClaw/issues/12651)) |
| Named policy presets; named [`grants`](../security/sandbox-network.md#choose-a-policy) extend the isolated preset instead | Not planned ([#12651](https://github.com/NVIDIA/NemoClaw/issues/12651)) |

## SDK and Provider

Keep the SDK, bundled providers, and their state format matched when integrating or recovering a deployment.

| Limit | Issue |
|---|---|
| Configuration or state migration between releases | Not during alpha; see [compatibility](../references/compatibility.md) |
| A hosted Rust API reference | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| `tofu import`, adoption, and remote state for CLI and SDK deployments | Not supported; see [compatibility](../references/compatibility.md) |

## Documentation Site

Select the v1 guide explicitly and match its source revision to the bundle before using hosted instructions.

| Limit | Issue |
|---|---|
| Public publication of the combined documentation site, with a check of its legacy routes | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| Search and docs MCP scoped to v1 | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
| Packaged installation of the documentation skill for assistant clients | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) |
