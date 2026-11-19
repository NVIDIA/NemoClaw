<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Limits

v1 is in development and has no release.
This page lists what it does not do or has not tested, with the open GitHub issue that tracks each where one exists.
Other pages state a limit where it affects a procedure and link the same issue.

The **Last verified** column links the `v1` commit each row was last checked against, then what was checked.
That commit's `versions.json` pins the upstream sources, and its `image/fabric/Dockerfile` pins the OpenClaw image:

- **code**: NemoClaw's source, tests and E2E cases.
- **OpenShell**: OpenShell's source and Helm chart.
- **Fabric**: NeMo Fabric's source.
- **Hermes**: Hermes Agent's source.
- **OpenClaw**: the OpenClaw image.
- **issue**: the linked issues are open, and no fix has landed in these pins.
- **docs**: the page the row links.

A row marked **not verified** names the run that would check it.

## Installation and Releases

Release archives exist only on draft releases; there is no installer or published package. Keep the matching bundle for an existing deployment.

| Limit | Issue | Last verified |
|---|---|---|
| No published release: the [release archives](../get-started/install.md) are on draft releases, which only maintainers see; others [build the bundle from source](../build-deploy/build.md#build-a-native-bundle) | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | [`291723b`][v1-291723b]: issue; only draft releases exist |
| The release executables are neither signed nor notarized for macOS or Windows | [#14621](https://github.com/NVIDIA/NemoClaw/issues/14621) | [`291723b`][v1-291723b]: code, issue |
| The SDK and provider packages are not published | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| No support policy or enterprise deployment qualification | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | [`cb8ef25`][v1-cb8ef25]: issue |

## Platforms, Models, and Placement

Accepted platform and model declarations are not a tested matrix; verify the exact host and runtime combination before relying on a reply.

| Limit | Issue | Last verified |
|---|---|---|
| No general DGX Station setup procedure; most Station configurations are untested | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Managed Ollama with OpenClaw on DGX Station | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| [Nemotron on an AMD64 GPU host](../agents-inference/models.md#configure-nemotron-on-an-amd64-gpu-host): its runtime image and GPU inference | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, docs, issue |
| Deploying from a Windows client: the CLI can't connect to a local Docker or Podman engine or read hidden credential input, and [deployment planning requires a Unix client](../build-deploy/usage.md) | No open issue | [`b1b4730`][v1-b1b4730]: code, docs |
| Local GPU deployment on Windows/WSL or macOS | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A model service on a separate physical SSH host | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Serving one model across several GPUs on one host: `container.gpuDevices` takes one entry, so vLLM refuses a [parallel layout](../agents-inference/models.md#set-the-parallel-layout) larger than one GPU | [#14384](https://github.com/NVIDIA/NemoClaw/issues/14384) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Distributed inference across several Sparks or Stations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Podman beyond a local rootless Linux gateway: rootful operation, remote engines, and model services on the Podman host; a Podman gateway can use one on a Docker host through [SSH placement](../agents-inference/remote-service.md) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, docs, issue |
| OpenShift beyond [OpenShift Local runs by hand](../build-deploy/kubernetes.md); no automated run covers OpenShift, and kind can't run a managed `openshift` gateway, which needs OpenShift to assign its `fsGroup` | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A managed OpenShift gateway needs `runtime.provider: openshift`: the pinned chart doesn't leave the gateway's UID and `fsGroup` to OpenShift by itself, so NemoClaw sets both to `null` on that value. This has run by hand on one OpenShift Local 4.22.14 node (linux/amd64) | [#13828](https://github.com/NVIDIA/NemoClaw/issues/13828), [NVIDIA/OpenShell#5483](https://github.com/NVIDIA/OpenShell/issues/5483) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| Changing a managed Kubernetes or OpenShift gateway's CPU and memory: NemoClaw sets the chart's `resources` to requests of 250m CPU and 256Mi and limits of 1 CPU and 2Gi | [#14588](https://github.com/NVIDIA/NemoClaw/issues/14588) | [`cb8ef25`][v1-cb8ef25]: code |
| Choosing the StorageClass of a managed Kubernetes or OpenShift gateway's own volume: it uses the cluster's default, because NemoClaw doesn't pass the chart's `server.dataStorageClass` | [#14588](https://github.com/NVIDIA/NemoClaw/issues/14588) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell |
| Putting a managed Kubernetes or OpenShift gateway behind a Gateway API ingress: TLS would end at the Gateway, which conflicts with NemoClaw's mTLS; use [an external gateway behind an ingress](../build-deploy/kubernetes.md#reach-an-external-gateway-through-an-ingress) instead | Not planned ([#14307](https://github.com/NVIDIA/NemoClaw/issues/14307)) | [`cb8ef25`][v1-cb8ef25]: docs |
| Model services that NemoClaw places with a Kubernetes or OpenShift gateway; sandboxes can use [a server you run in the cluster](../build-deploy/kubernetes.md#use-a-model-server-in-the-cluster) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| [A model server you run in the cluster](../build-deploy/kubernetes.md#use-a-model-server-in-the-cluster) has been tried on one kind cluster with NemoClaw's vLLM runtime behind a key ([#13546](https://github.com/NVIDIA/NemoClaw/issues/13546)) and its Ollama runtime, and with Ollama on one OpenShift Local node; vLLM on OpenShift and other network plugins are untested | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: docs, issue |
| A gateway published through [`gateway.kubernetes.expose`](../build-deploy/kubernetes.md#publish-the-gateway-outside-the-cluster) on a cluster other than kind, including any OpenShift Route | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| NemoClaw's own plan, apply and destroy dialing a [published gateway](../build-deploy/kubernetes.md#publish-the-gateway-outside-the-cluster) instead of port forwards, so they still need `pods/portforward` | [#14422](https://github.com/NVIDIA/NemoClaw/issues/14422) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A managed gateway published through a `LoadBalancer` Service: `expose.service` takes only `NodePort`, because the pinned OpenShell chart's Service takes no annotations or source ranges, and listens on the gateway's own port | [#14421](https://github.com/NVIDIA/NemoClaw/issues/14421) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| Tool use through managed Ollama, managed Ollama with harnesses other than Hermes, and managed Ollama on GPUs and hosts other than CI's Linux AMD64 [GPU runner](../../internal-docs/contributing/live-tests.md#hcl-e2e-scenarios) | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Gated repositories, custom remote-code models, GGUF in vLLM, and nested Hugging Face checkpoints | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A tested matrix of harness, model, provider and platform combinations | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: issue |

## Inference

A configured connection or ready container does not establish successful model responses.

| Limit | Issue | Last verified |
|---|---|---|
| Hermes doesn't reject a managed Ollama window below its 64,000-token minimum; see [sizing the context for Hermes](../agents-inference/inference.md#size-the-context-for-hermes) | [NousResearch/hermes-agent#141641](https://github.com/NousResearch/hermes-agent/issues/141641) | [`cb8ef25`][v1-cb8ef25]: Hermes, issue |
| Hermes with an `anthropic` provider whose endpoint's path doesn't end in `/anthropic` or `/anthropic/v1` and whose host isn't Anthropic's, Claude's or Azure's: Hermes sends the requests to `https://api.anthropic.com`, which OpenShell refuses; see [pointing Hermes at an Anthropic endpoint](../agents-inference/inference.md#point-hermes-at-an-anthropic-endpoint) | [#14538](https://github.com/NVIDIA/NemoClaw/issues/14538), [NVIDIA/NeMo-Fabric#666](https://github.com/NVIDIA/NeMo-Fabric/issues/666) | [`cb8ef25`][v1-cb8ef25]: Hermes, issue |
| Managed llama.cpp and NVIDIA NIM services; use either as an external OpenAI-compatible endpoint | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Model Router | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| A provider that uses Gemini's native API; onboarding's Google Gemini preset connects through Gemini's OpenAI-compatible endpoint | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Guides for named hosted providers such as NVIDIA, OpenAI, Anthropic, OpenRouter and Nous | No open issue | [`cb8ef25`][v1-cb8ef25]: docs |
| More than 32 providers attached to one sandbox: OpenShell refuses more, and its inference providers, its web search and each `api` integration count one each | By design: OpenShell's limit per sandbox | [`cb8ef25`][v1-cb8ef25]: code, OpenShell |

## Agents and Integrations

Select the adapter and image together, then verify its integrations and native request path separately from apply.

| Limit | Issue | Last verified |
|---|---|---|
| Messaging channels | [#12037](https://github.com/NVIDIA/NemoClaw/issues/12037) | [`cb8ef25`][v1-cb8ef25]: code, Fabric, issue |
| Managed MCP servers: NemoClaw passes the agent's `mcp` section to Fabric, but doesn't run the servers or grant them network access or credentials | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Hermes OAuth and managed tools | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Agent interfaces are reached by Fabric's P0 conventions; runtime handles don't report them yet | [NVIDIA/NeMo-Fabric#565](https://github.com/NVIDIA/NeMo-Fabric/issues/565) | [`cb8ef25`][v1-cb8ef25]: Fabric, issue |
| Interface tokens that the agent's own tools can't read, an interface health check, and exposed service URLs for Hermes's dashboard | [NVIDIA/NeMo-Fabric#566](https://github.com/NVIDIA/NeMo-Fabric/issues/566) | [`cb8ef25`][v1-cb8ef25]: issue |
| Native tools and plugins from a mounted volume: no Fabric adapter field loads or enables them from a location you supply. NemoClaw doesn't download or install plugins | [NVIDIA/NeMo-Fabric#661](https://github.com/NVIDIA/NeMo-Fabric/issues/661), [NVIDIA/NeMo-Fabric#665](https://github.com/NVIDIA/NeMo-Fabric/issues/665) | [`cb8ef25`][v1-cb8ef25]: code, Fabric, issue |
| Plugins bundled in the Hermes or OpenClaw image, and plugins the agent installs: Fabric's tests don't show them loading, or staying usable after a restart or sandbox replacement | [NVIDIA/NeMo-Fabric#660](https://github.com/NVIDIA/NeMo-Fabric/issues/660), [NVIDIA/NeMo-Fabric#664](https://github.com/NVIDIA/NeMo-Fabric/issues/664), [NVIDIA/NeMo-Fabric#657](https://github.com/NVIDIA/NeMo-Fabric/issues/657) | [`cb8ef25`][v1-cb8ef25]: issue |
| What an attached Hermes terminal and its in-flight turn do when Fabric stops the runtime: Fabric starts and stops the terminal's backend and doesn't define or test this yet | [NVIDIA/NeMo-Fabric#656](https://github.com/NVIDIA/NeMo-Fabric/issues/656#issuecomment-6971534523) | [`cb8ef25`][v1-cb8ef25]: issue |
| OpenClaw's Brave and Tavily web search plugins | [#13361](https://github.com/NVIDIA/NemoClaw/issues/13361) | [`cb8ef25`][v1-cb8ef25]: Fabric, issue |
| NemoClaw's invoke path can't send `acknowledge_recovery`, so after `session_recovery_required` an agent that keeps its state answers only a request sent with `fabric-agent-ctl invoke --request`; see [continue after session_recovery_required](../observability/troubleshooting.md#continue-after-session_recovery_required). Native interfaces aren't affected | No open issue | [`cb8ef25`][v1-cb8ef25]: code, Fabric |
| Collector provisioning, production collector troubleshooting and Deep Agents trace export | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Tavily and Brave search have not been tested live through OpenShell | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| OpenShell refuses new connections to an address its policy DNS answered once the answer's TTL has passed, so a client that reconnects to the address it kept fails, as OpenClaw's Node.js does. For an OpenClaw agent, the model request fails and its runtime stops; the next apply starts a new runtime without the conversation | Fixed after OpenShell 0.1.9 by [NVIDIA/OpenShell#5650](https://github.com/NVIDIA/OpenShell/pull/5650) | [`cb8ef25`][v1-cb8ef25]: OpenShell |

## Access and Diagnostics

Access paths and diagnostic signals depend on the gateway and harness in use.

| Limit | Issue | Last verified |
|---|---|---|
| The [headless OpenClaw request](../agents-inference/agents.md#run-one-headless-openclaw-request) hasn't been rehearsed as written | No open issue | Not verified: needs the procedure run as written |
| A live rehearsal against an external gateway that requires mTLS client certificates | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| An error holds at most 16 KiB of a command's OpenTofu diagnostics, such as several managed services' [stop details](../agents-inference/models.md#diagnose-and-recover-a-stopped-runtime): it lists the whole diagnostics that fit, then the next one's summary and a count of the rest; a diagnostic longer than 16 KiB keeps as much of its detail as fits | By design: bounds the error's size | [`cb8ef25`][v1-cb8ef25]: code |
| An error shows `child output exceeds the supported limit` in place of a command's output when OpenTofu writes more than 16 KiB to standard error, as a provider crash can, or more than 64 MiB to standard output: cut output can end inside a credential that redaction no longer recognizes | By design: keeps credentials out of errors | [`cb8ef25`][v1-cb8ef25]: code |
| A managed Kubernetes gateway with the `development` profile gives you no `openshell` access of your own; the `oidc` profile [reaches it from the OpenShell CLI](../build-deploy/kubernetes.md#reach-the-gateway-from-the-openshell-cli), which no automated test covers | By design: the development issuer serves only NemoClaw | [`cb8ef25`][v1-cb8ef25]: code, docs |
| [Service URLs](../agents-inference/interfaces.md#expose-a-service-through-the-gateway) on a managed Kubernetes or OpenShift gateway name `openshell.localhost` and the gateway pod's port, 8080, so they don't open as printed; reach them through a port forward to the gateway, sending the URL's host name | [#14316](https://github.com/NVIDIA/NemoClaw/issues/14316) | [`cb8ef25`][v1-cb8ef25]: OpenShell, issue |

## Data and Cleanup

Preserve state and native data before attempting a destructive operation.

| Limit | Issue | Last verified |
|---|---|---|
| Native conversation continuity across runtime replacement | [Per-harness limits](../build-deploy/state.md#choose-what-to-retain-for-each-harness); depends on Fabric and the selected harness | [`cb8ef25`][v1-cb8ef25]: docs |
| Backup, restore, snapshots and transfer of mounted agent data | [Platform-owned storage](../build-deploy/state.md#keep-agent-files-on-mounted-volumes); no NemoClaw command | [`cb8ef25`][v1-cb8ef25]: code, docs |
| A documented path from the earlier product's configuration export to a v1 deployment | [#14580](https://github.com/NVIDIA/NemoClaw/issues/14580) | [`cb8ef25`][v1-cb8ef25]: issue |
| Moving data from the earlier product to v1 and back | No NemoClaw procedure; native data belongs to the harness and moving its storage to the platform ([migration](../get-started/migration.md)) | [`cb8ef25`][v1-cb8ef25]: docs |
| Keeping a sandbox across a managed Docker gateway that stops without a graceful shutdown, such as after a SIGKILL: once the gateway runs again, the sandbox refuses the supervisor that OpenShell starts for it and goes to `Error` with `StartFailed`, and the next apply replaces it, which deletes its files outside mounted volumes and its conversation history. A graceful restart, such as `docker restart`, keeps the sandbox | [#13953](https://github.com/NVIDIA/NemoClaw/issues/13953), [NVIDIA/OpenShell#4910](https://github.com/NVIDIA/OpenShell/issues/4910) | [`291723b`][v1-291723b]: issue; on a DGX Spark, 9 of 9 SIGKILLed gateways lost their Hermes sandbox and 12 of 12 graceful restarts kept it |

## Security

Sandbox policy and credential routing depend on OpenShell and the host's controls; assess their trust boundaries for your deployment.

| Limit | Issue | Last verified |
|---|---|---|
| Host-specific security qualification | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: issue |
| A private CA for sandbox egress on a managed gateway, such as an inference endpoint's CA ([custom CA trust](../agents-inference/inference.md#trust-a-custom-certificate-authority)): OpenShell trusts the CAs in its gateway's [additional CA bundle](https://github.com/NVIDIA/OpenShell/blob/ce58cf8e9b953281352d98a637e41616295b1318/docs/how-it-works/gateways/configuration.mdx#additional-destination-cas). Docker and Podman read the bundle from a file on the gateway, which NemoClaw doesn't mount, and the chart mounts it only from its `supervisor.network.additionalCaConfigMapName` value, which NemoClaw doesn't set. Don't set `additional_ca_bundle` in `spec.gateway.config`: the path names no file on the gateway, and OpenShell doesn't start a gateway whose bundle is missing | [#14486](https://github.com/NVIDIA/NemoClaw/issues/14486) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| A corporate CA for OpenShell's gateway, managed model downloads, and image builds | [Corporate CA](../security/security.md#trust-a-corporate-certificate-authority) | [`cb8ef25`][v1-cb8ef25]: docs |
| [Proxy](../security/sandbox-network.md#use-an-upstream-proxy) credentials for a managed Docker or Podman gateway: OpenShell reads them only from a file on the gateway (`proxy_auth_file`), which NemoClaw doesn't mount | No open issue | [`cb8ef25`][v1-cb8ef25]: code, OpenShell |
| A proxy CA (`proxy_ca_bundle`) for any managed gateway: Docker and Podman read it from a file on the gateway, and the chart mounts it only from its `upstreamProxy.caBundle.configMapName` value, which NemoClaw doesn't set | [#14486](https://github.com/NVIDIA/NemoClaw/issues/14486) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| OAuth-refresh credentials have no NemoClaw YAML wrapper; use [operator-managed OpenShell providers](../agents-inference/oauth-refresh.md), with separate sandbox attachments | No open issue | [`cb8ef25`][v1-cb8ef25]: code, docs |
| Interactive network-request approval and explaining policy to an agent; OpenShell's policy advisor owns both | Not planned ([#12651](https://github.com/NVIDIA/NemoClaw/issues/12651)) | [`cb8ef25`][v1-cb8ef25]: issue |
| Named policy presets; named [`grants`](../security/sandbox-network.md#choose-a-policy) extend the isolated preset instead | Not planned ([#12651](https://github.com/NVIDIA/NemoClaw/issues/12651)) | [`cb8ef25`][v1-cb8ef25]: code, issue |

## SDK and Provider

Keep the SDK, bundled providers, and their state format matched when integrating or recovering a deployment.

| Limit | Issue | Last verified |
|---|---|---|
| Configuration or state migration between releases | Not during alpha; see [compatibility](../references/compatibility.md) | [`cb8ef25`][v1-cb8ef25]: code, docs |
| A hosted Rust API reference | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |
| `tofu import`, adoption, and remote state for CLI and SDK deployments | Not supported; see [compatibility](../references/compatibility.md) | [`cb8ef25`][v1-cb8ef25]: code, docs |

## Documentation Site

Select the v1 guide explicitly and match its source revision to the bundle before using hosted instructions.

| Limit | Issue | Last verified |
|---|---|---|
| Public publication of the combined documentation site, with a check of its legacy routes | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |
| Search and docs MCP scoped to v1 | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |
| Packaged installation of the documentation skill for assistant clients | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |

[v1-cb8ef25]: https://github.com/NVIDIA/NemoClaw/tree/cb8ef25252ffffbca051787adb4711c96ebfcf28
[v1-291723b]: https://github.com/NVIDIA/NemoClaw/tree/291723b41b77dbd502f5418b9b0a9b7c1a322dc9
[v1-b1b4730]: https://github.com/NVIDIA/NemoClaw/tree/b1b4730981ab2a52674d082bdc2fc65bc828ba4c
