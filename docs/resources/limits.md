<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Current Limits

This page lists what Agent Configs does not do yet or has not tested, with the open GitHub issue that tracks each where one exists.
Other pages state a limit where it affects a procedure and link the same issue.
Unlike these limits, the responsibilities in [Out of Scope](out-of-scope.md) are left to other components by design.

The **Last Verified** column links the `v1` commit each row was last checked against, then what was checked.
That commit's `versions.json` pins the upstream sources, and its `image/fabric/Dockerfile` pins the OpenClaw image:

- **code**: NemoClaw's source, tests, and E2E cases.
- **OpenShell**: NVIDIA OpenShell's source and Helm chart.
- **Fabric**: NVIDIA NeMo Fabric's source.
- **Hermes**: Hermes Agent's source.
- **OpenClaw**: The OpenClaw image.
- **issue**: The linked issues are open, and no fix has landed in these pins.
- **docs**: The page the row links.

A row marked **not verified** names the run that would check it.

## Installation and Releases

Use the [CLI archive](../get-started/install.md), or the [macOS](../get-started/install.md#installing-with-the-macos-installer) or [Windows](../get-started/install.md#installing-with-the-windows-installer) installer if the release includes it.
Keep the matching bundle for an existing deployment.
The following installation and release limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Archive provenance, OS signing, and macOS notarization are separate checks. Use the release's evidence record for platform results. | [#14621](https://github.com/NVIDIA/NemoClaw/issues/14621) | [Signing record contract](../../.github/scripts/record-cli-signing.sh); final platform results not verified |
| The macOS installer requires Apple silicon and macOS 15 or later. A final release includes the installer only if it's signed and notarized. If unavailable, install the `darwin_arm64` archive. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | [Installer and signing workflow](../../.github/workflows/release.yml); final installer availability not verified |
| The Windows installer comes only with a release whose Windows executables are signed: without Windows signing, staging builds none. Its artwork and icon await NVIDIA brand and trademark review under [#14836](https://github.com/NVIDIA/NemoClaw/issues/14836). | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | **not verified**: the first release candidate staged with the installer |
| Releases don't include a `claude` agent image: it bundles Anthropic's proprietary Claude Code CLI, which NVIDIA can't redistribute. Build it locally as [Building Agent Images](../build-deploy/build.md#building-agent-images) describes. | [#13524](https://github.com/NVIDIA/NemoClaw/issues/13524) | [`43c9dc9`][v1-43c9dc9]: issue |
| The SDK and provider packages are not published. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| No support policy or enterprise deployment qualification. | [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) | [`cb8ef25`][v1-cb8ef25]: issue |

## Platforms, Models, and Placement

`nemoclaw openshell` (`osh`) supports plaintext and mTLS deployments on Linux amd64, Linux arm64, and macOS Apple silicon.
Bearer-token authentication and managed Kubernetes gateway access remain tracked in [#14855](https://github.com/NVIDIA/NemoClaw/issues/14855).
The pinned OpenShell release publishes no CLI archive for Windows or Intel macOS; those clients need a supported Linux or Apple silicon host, or WSL2 on Windows.

Accepted platform and model declarations are not a tested matrix.
Verify the exact host and runtime combination before relying on a reply.
The following platform, model, and placement limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| No general NVIDIA DGX Station setup procedure. Most Station configurations are untested. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Managed Ollama with OpenClaw on DGX Station. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| [NVIDIA Nemotron on an AMD64 GPU host](../agents-inference/models.md#configuring-nemotron-on-an-amd64-gpu-host): its runtime image and GPU inference. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, docs, issue |
| A deployment from a Windows client on Docker Desktop or a Podman machine, with a managed or an external gateway: no Windows host has run one, and CI tests the Windows client against fake engines on named pipes. | [#14639](https://github.com/NVIDIA/NemoClaw/issues/14639) | [`5223fdc`][v1-5223fdc]: code, docs, issue |
| A managed gateway from a macOS client on Colima, Rancher Desktop, or a Podman machine: no macOS host has run one. The gateway binds `/var/run/docker.sock` in the engine's VM, from each engine's documentation. Docker Desktop 4.94 on macOS 26 created a sandbox through that socket in [#14643](https://github.com/NVIDIA/NemoClaw/pull/14643). An engine at another socket, such as a Lima instance's, binds the client's socket path, which its VM might not serve. | [#14640](https://github.com/NVIDIA/NemoClaw/issues/14640) | [`ffe5406`][v1-ffe5406]: code, docs, issue |
| Local GPU deployment on Windows/WSL or macOS. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A model service on a separate physical SSH host. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Serving one model across several GPUs on one host: `container.gpuDevices` takes one entry, so vLLM refuses a [parallel layout](../agents-inference/models.md#setting-the-parallel-layout) larger than one GPU. | [#14384](https://github.com/NVIDIA/NemoClaw/issues/14384) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| DGX Spark systems whose driver reports a placeholder GPU name, such as `NVIDIA JMJWOA-Generic-GPU`, instead of `NVIDIA GB10`: the `dgx-spark` profile and recipes that require `NVIDIA GB10` [don't match them](../agents-inference/models.md#choosing-a-hardware-profile). | [#14698](https://github.com/NVIDIA/NemoClaw/issues/14698) | [`c30c3f1`][v1-c30c3f1]: code, issue |
| Distributed inference across several Sparks or Stations. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Podman beyond a local rootless Linux gateway: rootful operation, remote engines, and model services on the Podman host. A Podman gateway can use one on a Docker host through [SSH placement](../agents-inference/remote-service.md). | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, docs, issue |
| OpenShift beyond [OpenShift Local runs by hand](../build-deploy/kubernetes.md). No automated run covers OpenShift, and kind cannot run a managed `openshift` gateway, which needs OpenShift to assign its `fsGroup`. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A managed OpenShift gateway needs the `openshift` target: the pinned chart does not leave the gateway's UID and `fsGroup`, or a shared supervisor's UID, group, and `fsGroup`, to OpenShift by itself, so NemoClaw sets them to `null` on that target. The gateway has run this way by hand on one OpenShift Local 4.22.14 node (`linux/amd64`), where `restricted-v2` also admitted a shared supervisor's pod; no deployment with a shared supervisor has run on OpenShift. | [#13828](https://github.com/NVIDIA/NemoClaw/issues/13828), [NVIDIA/OpenShell#5483](https://github.com/ai-openshell/openshell/issues/5483) | [`ca452e0`][v1-ca452e0]: code, OpenShell, issue |
| Pull Secrets for a managed Kubernetes or OpenShift gateway's own pods: the gateway and its helper pods pull OpenShell's public images without any, which matters only on a cluster that redirects those images to a mirror that requires pull Secrets. Sandbox pods pull with the Secrets that [`image_pull_secrets`](../build-deploy/kubernetes.md#referencing-registry-credentials) names. | No open issue | [`cb8ef25`][v1-cb8ef25]: OpenShell |
| Putting a managed Kubernetes or OpenShift gateway behind a Gateway API ingress: TLS would end at the Gateway, which conflicts with NemoClaw's mTLS. Use [an external gateway behind an ingress](../build-deploy/kubernetes.md#reaching-an-external-gateway-through-an-ingress) instead. | Not planned ([#14307](https://github.com/NVIDIA/NemoClaw/issues/14307)) | [`cb8ef25`][v1-cb8ef25]: docs |
| Model services that NemoClaw places with a Kubernetes or OpenShift gateway. Sandboxes can use [a server you run in the cluster](../build-deploy/kubernetes.md#using-a-model-server-in-the-cluster). | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| [A model server you run in the cluster](../build-deploy/kubernetes.md#using-a-model-server-in-the-cluster) has been tried on one kind cluster with NemoClaw's vLLM runtime behind a key ([#13546](https://github.com/NVIDIA/NemoClaw/issues/13546)) and its Ollama runtime, and with Ollama on one OpenShift Local node. Other network plugins, and vLLM on OpenShift, are untested. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: docs, issue |
| A gateway published through [`expose`](../build-deploy/kubernetes.md#publishing-the-gateway-outside-the-cluster) on a cluster other than kind, including any OpenShift Route. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| NemoClaw's own plan, apply and destroy dialing a [published gateway](../build-deploy/kubernetes.md#publishing-the-gateway-outside-the-cluster) instead of port forwards, so they still need `pods/portforward`. | [#14422](https://github.com/NVIDIA/NemoClaw/issues/14422) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A managed gateway published through a `LoadBalancer` Service: `expose.service` takes only `NodePort`, because the pinned OpenShell chart's Service takes no annotations or source ranges, and listens on the gateway's own port. | [#14421](https://github.com/NVIDIA/NemoClaw/issues/14421) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| Tool use through managed Ollama, managed Ollama with harnesses other than Hermes, and managed Ollama on GPUs and hosts other than CI's Linux AMD64 [GPU runner](../../internal-docs/contributing/live-tests.md#hcl-e2e-scenarios). | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| Gated repositories, custom remote-code models, GGUF in vLLM, and nested Hugging Face checkpoints. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| A tested matrix of harness, model, provider and platform combinations. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: issue |
| Generic [application containers](../build-deploy/container-services.md) on Podman, Kubernetes, or a remote engine: this path supports managed local Docker only. | By design: [container contract](../build-deploy/container-services.md) | [`e7e1857`][v1-e7e1857]: docs |

## Inference

A configured connection or ready container does not establish successful model responses.
The following inference limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Hermes does not reject a managed Ollama window below its 64,000-token minimum. Refer to [sizing the context for Hermes](../agents-inference/inference.md#sizing-the-context-for-hermes). | [NousResearch/hermes-agent#141641](https://github.com/NousResearch/hermes-agent/issues/141641) | [`cb8ef25`][v1-cb8ef25]: Hermes, issue |
| Native NVIDIA NIM's full tool inventory, default 8K context, general task reliability, cross-host cache restoration, and other model and profile combinations remain unqualified. Use the [bounded BF16 candidate configuration](../agents-inference/models.md#native-nim-candidate). | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556), [NVIDIA/NeMo-Fabric#679](https://github.com/NVIDIA/NeMo-Fabric/issues/679) | Refer to the [source-specific qualification record](https://github.com/NVIDIA/NemoClaw/issues/14556#issuecomment-7016789006) |
| llama.cpp bearer authentication protects inference. Native model inventory and health remain public. A key does not provide inventory confidentiality. | [#14556](https://github.com/NVIDIA/NemoClaw/issues/14556) | Refer to the [source-specific qualification record](https://github.com/NVIDIA/NemoClaw/issues/14556#issuecomment-7016789006) |
| Model Router. | By design: the deprecated `llm-router` was retired ([#14066](https://github.com/NVIDIA/NemoClaw/issues/14066)); configure Switchyard routing through [Hermes Relay](../agents-inference/agents.md#hermes-relay-tracing) | [`5b83ffc`][v1-5b83ffc]: code, docs |
| A provider that uses Gemini's native API. Onboarding's Google Gemini preset connects through Gemini's OpenAI-compatible endpoint. | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Guides for named hosted providers such as NVIDIA, OpenAI, Anthropic, OpenRouter and Nous. | No open issue | [`cb8ef25`][v1-cb8ef25]: docs |
| More than 32 providers attached to one sandbox: OpenShell refuses more, and its inference providers, its web search and each `api` integration count one each. | By design: OpenShell's limit per sandbox | [`cb8ef25`][v1-cb8ef25]: code, OpenShell |

## Agents and Integrations

Select the adapter and image together, then verify its integrations and native request path separately from apply.
The following agent and integration limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Managed MCP servers: NemoClaw passes the agent's `mcp` section to Fabric, but does not run the servers or grant them network access or credentials. | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Hermes OAuth and managed tools. | No open issue | [`cb8ef25`][v1-cb8ef25]: code |
| Automatic third-party skill acquisition, installation, upgrade, or removal: the [skill configuration](../agents-inference/agents.md#skills-on-a-mounted-volume) loads supplied files. It does not provide a package-management workflow. | Harness-owned. Supply the required files and dependencies | [`e7e1857`][v1-e7e1857]: docs |
| Agent interfaces are reached by Fabric's P0 conventions. Runtime handles do not report them yet. | [NVIDIA/NeMo-Fabric#565](https://github.com/NVIDIA/NeMo-Fabric/issues/565) | [`1636069`][v1-1636069]: Fabric, issue |
| Interface tokens that the agent's own tools cannot read, an interface health check, and exposed service URLs for Hermes's dashboard. | [NVIDIA/NeMo-Fabric#566](https://github.com/NVIDIA/NeMo-Fabric/issues/566) | [`cb8ef25`][v1-cb8ef25]: issue |
| Plugin files: NemoClaw does not download, build, or install plugins. Put the prepared plugin folders on a mounted volume and list them in the harness's `settings.plugins.external`; Fabric's [OpenClaw](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/docs/integrations/harness/openclaw/openclaw.mdx#plugins) and [Hermes](https://github.com/NVIDIA/NeMo-Fabric/blob/76bde16c40747062001bd6ea5f5d13cadab3d706/docs/integrations/harness/hermes/hermes.mdx#plugins) adapters load them and stop the start when an enabled plugin doesn't load. | No open issue | [`1636069`][v1-1636069]: code, Fabric |
| Plugins the agent installs: because NemoClaw keeps each agent's state, a Hermes agent that installs a plugin itself fails its next start with `hermes_plugin_agent_installed_unsupported`, and Fabric's tests do not show an OpenClaw agent's plugin staying usable after a restart or sandbox replacement. | [NVIDIA/NeMo-Fabric#657](https://github.com/NVIDIA/NeMo-Fabric/issues/657) | [`1636069`][v1-1636069]: Fabric, issue |
| What an attached Hermes terminal and its in-flight turn do when Fabric stops the runtime: Fabric starts and stops the terminal's backend and does not define or test this yet. | [NVIDIA/NeMo-Fabric#656](https://github.com/NVIDIA/NeMo-Fabric/issues/656#issuecomment-6971534523) | [`1636069`][v1-1636069]: issue |
| NemoClaw's invoke path cannot send `acknowledge_recovery`, so after `session_recovery_required` an agent that keeps its state answers only a request sent with `fabric-agent-ctl invoke --request`. Refer to [continue after session_recovery_required](../observability/troubleshooting.md#continuing-after-session_recovery_required). Native interfaces are not affected. | No open issue | [`1636069`][v1-1636069]: code, Fabric |
| Collector provisioning, production collector troubleshooting and Deep Agents trace export. | No open issue | [`cb8ef25`][v1-cb8ef25]: code |

## Access and Diagnostics

Access paths and diagnostic signals depend on the gateway and harness in use.
The following access and diagnostic limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| The [headless OpenClaw request](../agents-inference/agents.md#running-one-headless-openclaw-request) has not been rehearsed as written. | No open issue | Not verified: needs the procedure run as written |
| A live rehearsal against an external gateway that requires mTLS client certificates. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: code, issue |
| An error holds at most 16 KiB of a command's OpenTofu diagnostics, such as several managed services' [stop details](../agents-inference/models.md#diagnosing-and-recovering-a-stopped-runtime): it lists the whole diagnostics that fit, then the next one's summary and a count of the rest. A diagnostic longer than 16 KiB keeps as much of its detail as fits. | By design: bounds the error's size | [`cb8ef25`][v1-cb8ef25]: code |
| An error shows `child output exceeds the supported limit` in place of a command's output when OpenTofu writes more than 16 KiB to standard error, as a provider crash can, or more than 64 MiB to standard output: cut output can end inside a credential that redaction no longer recognizes. | By design: keeps credentials out of errors | [`cb8ef25`][v1-cb8ef25]: code |
| A managed Kubernetes gateway with the `development` profile gives you no `openshell` access of your own. The `oidc` profile [reaches it from the OpenShell CLI](../build-deploy/kubernetes.md#reaching-the-gateway-from-the-openshell-cli), which no automated test covers. | By design: the development issuer serves only NemoClaw | [`cb8ef25`][v1-cb8ef25]: code, docs |
| [Service URLs](../agents-inference/interfaces.md#exposing-a-service-through-the-gateway) on a managed Kubernetes or OpenShift gateway: OpenShell's chart turns off gateway service routing, so apply lists none. With `enable_gateway_service_routing: true` in `spec.gateway.config`, the URLs name `openshell.localhost` and the gateway pod's port, 8080, so they do not open as printed. Reach them through a port forward to the gateway, sending the URL's host name. | [#14316](https://github.com/NVIDIA/NemoClaw/issues/14316) | [`cb8ef25`][v1-cb8ef25]: OpenShell, issue |

## Data and Cleanup

Preserve state and native data before attempting a destructive operation.
The following data and cleanup limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Native conversation continuity across runtime replacement. | [Per-harness limits](../build-deploy/state.md#choosing-what-to-retain-for-each-harness), which depend on Fabric and the selected harness | [`cb8ef25`][v1-cb8ef25]: docs |
| Durable data for generic application containers: their writable volume is disposable, and replacement or destroy can lose it. This differs from caller-supplied volumes mounted in an agent sandbox. | By design: [application storage](../build-deploy/container-services.md#deciding-whether-the-image-fits) | [`e7e1857`][v1-e7e1857]: docs |
| Transferring native data between NemoClaw v0 and NemoClaw Agent Configs. | No NemoClaw procedure. The harness owns native data, and the platform owns storage transfer. See [how to evaluate NemoClaw Agent Configs in a separate deployment](../get-started/migration.md). | [`cb8ef25`][v1-cb8ef25]: docs |
| Keeping a sandbox across a managed Docker gateway that stops without a graceful shutdown, such as after a SIGKILL: after the gateway runs again, the sandbox refuses the supervisor that OpenShell starts for it and goes to `Error` with `StartFailed`, and the next apply replaces it, which deletes its files outside mounted volumes and its conversation history. A graceful restart, such as `docker restart`, keeps the sandbox. | [#13953](https://github.com/NVIDIA/NemoClaw/issues/13953), [NVIDIA/OpenShell#4910](https://github.com/ai-openshell/openshell/issues/4910) | [`291723b`][v1-291723b]: issue, plus a DGX Spark run where 9 of 9 SIGKILLed gateways lost their Hermes sandbox and 12 of 12 graceful restarts kept it |
| Keeping a sandbox's files and conversations across a change to its policy's filesystem, Landlock, or process settings: OpenShell applies them only when a sandbox starts, so the change replaces the sandbox. Network rules, middleware bindings, and grants change in place. | No open issue: OpenShell's [policy guide](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/policies/manage-policies.mdx#how-changes-take-effect) | [`ca452e0`][v1-ca452e0]: code, OpenShell |

## Security

Sandbox policy and credential routing depend on OpenShell and the host's controls.
Assess their trust boundaries for your deployment.
The following security limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Host-specific security qualification. | [#12641](https://github.com/NVIDIA/NemoClaw/issues/12641) | [`cb8ef25`][v1-cb8ef25]: issue |
| A private CA for sandbox egress on a managed gateway, such as an inference endpoint's CA ([custom CA trust](../agents-inference/inference.md#trusting-a-custom-certificate-authority)): OpenShell trusts the CAs in its gateway's [additional CA bundle](https://github.com/ai-openshell/openshell/blob/152c59d3178039e3fbb4a5595f9fff7216a6be92/docs/how-it-works/gateways/configuration.mdx#additional-destination-cas). Docker and Podman read the bundle from a file on the gateway, which NemoClaw does not mount, and the chart mounts it only from its `supervisor.network.additionalCaConfigMapName` value, which NemoClaw does not set. Do not set `additional_ca_bundle` in `spec.gateway.config`: the path names no file on the gateway, and OpenShell does not start a gateway whose bundle is missing. | [#14486](https://github.com/NVIDIA/NemoClaw/issues/14486) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| A corporate CA for OpenShell's gateway, managed model downloads, and image builds. | [Corporate CA](../security/security.md#trusting-a-corporate-certificate-authority) | [`cb8ef25`][v1-cb8ef25]: docs |
| [Proxy](../security/sandbox-network.md#using-an-upstream-proxy) credentials for a managed Docker or Podman gateway: OpenShell reads them only from a file on the gateway (`proxy_auth_file`), which NemoClaw does not mount. | No open issue | [`cb8ef25`][v1-cb8ef25]: code, OpenShell |
| A proxy CA (`proxy_ca_bundle`) for any managed gateway: Docker and Podman read it from a file on the gateway, and the chart mounts it only from its `upstreamProxy.caBundle.configMapName` value, which NemoClaw does not set. | [#14486](https://github.com/NVIDIA/NemoClaw/issues/14486) | [`cb8ef25`][v1-cb8ef25]: code, OpenShell, issue |
| OAuth-refresh credentials have no NemoClaw YAML wrapper. Use [operator-managed OpenShell providers](../agents-inference/oauth-refresh.md), with separate sandbox attachments. | No open issue | [`cb8ef25`][v1-cb8ef25]: code, docs |
| Protected secret delivery through generic application-container `environment` and `files`: these are literal inputs that enter configuration, plans, or state. | By design: [application credentials](../build-deploy/container-services.md#protecting-application-credentials) | [`e7e1857`][v1-e7e1857]: docs |

## SDK and Provider

Keep the SDK, bundled providers, and their state format matched when integrating or recovering a deployment.
The following SDK and provider limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Configuration or state migration between releases | Not during alpha, as [compatibility](../references/compatibility.md) describes | [`cb8ef25`][v1-cb8ef25]: code, docs |
| A hosted Rust API reference | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |
| `tofu import`, adoption, and remote state for CLI and SDK deployments | Not supported, as [compatibility](../references/compatibility.md) describes | [`cb8ef25`][v1-cb8ef25]: code, docs |
| [Hand-written HCL](../build-deploy/opentofu-project.md) under Terraform: the provider addresses are under `registry.opentofu.org`, and the examples' tests run only under OpenTofu. | [#14725](https://github.com/NVIDIA/NemoClaw/issues/14725) | [`1b5574f`][v1-1b5574f]: code, issue |
| A guard against lost creation replies in hand-written HCL: only the SDK records the OpenShell and Fabric objects an apply might create. | [#14726](https://github.com/NVIDIA/NemoClaw/issues/14726) | [`1b5574f`][v1-1b5574f]: code, issue |
| Handing an existing CLI deployment over to hand-written HCL | [#14721](https://github.com/NVIDIA/NemoClaw/issues/14721) | [`1b5574f`][v1-1b5574f]: code, issue |

## Documentation Site

Select the NemoClaw Agent Configs guide explicitly and match its source revision to the bundle before using hosted instructions.
The following documentation site limits apply:

| Limit | Issue | Last Verified |
|---|---|---|
| Public publication of the combined documentation site, with a check of its legacy routes | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |
| Search and docs MCP scoped to the Agent Configs guides | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |
| Packaged installation of the documentation skill for assistant clients | [#12644](https://github.com/NVIDIA/NemoClaw/issues/12644) | [`cb8ef25`][v1-cb8ef25]: issue |

Managed [llama.cpp](../agents-inference/models.md#serving-a-pinned-gguf-with-llamacpp) accepts pinned public GGUF files on one CUDA GPU.
General tool use, multimodal input, other models and parity with NemoClaw v0 host settings need separate qualification.
Refer to the [recorded scope](https://github.com/NVIDIA/NemoClaw/issues/14556#issuecomment-7016789006).

[v1-5b83ffc]: https://github.com/NVIDIA/NemoClaw/tree/5b83ffc8e6ae46c4e5eec2466ed847cb223addad
[v1-cb8ef25]: https://github.com/NVIDIA/NemoClaw/tree/cb8ef25252ffffbca051787adb4711c96ebfcf28
[v1-ca452e0]: https://github.com/NVIDIA/NemoClaw/tree/ca452e0ecb79c03914ecb775c4d9437f67db9449
[v1-c30c3f1]: https://github.com/NVIDIA/NemoClaw/tree/c30c3f1b3fbf9d825d13fd4497c98b35ef33f1ee
[v1-291723b]: https://github.com/NVIDIA/NemoClaw/tree/291723b41b77dbd502f5418b9b0a9b7c1a322dc9
[v1-5223fdc]: https://github.com/NVIDIA/NemoClaw/tree/5223fdc0b6c9a7ec0b7d86b9c11699eb3de1a206
[v1-ffe5406]: https://github.com/NVIDIA/NemoClaw/tree/ffe5406498c6a27c068ad52a56ddcfb1cb37b904
[v1-e7e1857]: https://github.com/NVIDIA/NemoClaw/tree/e7e1857514f4bed9269eeaf6786bcdb2d6d0ade3
[v1-43c9dc9]: https://github.com/NVIDIA/NemoClaw/tree/43c9dc9cea1dea3bd59057fd18d96ed799475e9c
[v1-1636069]: https://github.com/NVIDIA/NemoClaw/tree/1636069b91f402242a35714fde1011042c3f1f70
[v1-1b5574f]: https://github.com/NVIDIA/NemoClaw/tree/1b5574f18137bb4a94b695dfa86b4be5e1c8d8e6
[v1-ca452e0]: https://github.com/NVIDIA/NemoClaw/tree/ca452e0ecb79c03914ecb775c4d9437f67db9449
