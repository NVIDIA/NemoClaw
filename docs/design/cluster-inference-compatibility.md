<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cluster Inference Contract Baseline

Cluster-managed vLLM and Ollama extend the existing SDK/provider lifecycle without changing the Fabric or OpenShell pins.
This record compares the contracts at NemoClaw `v1` revision `618c002419beb994c62c89b6e1df31783621e481` with the cluster implementation for [#12732](https://github.com/NVIDIA/NemoClaw/issues/12732).
It does not establish team approval, a release compatibility policy, or general Kubernetes/OpenShift qualification.
Use the [cluster deployment guide](../kubernetes.md#run-a-managed-model-service) for configuration and retained-resource behavior.

## Exact Inputs

The source pins below define the baseline; a deployment also needs its own immutable agent and hosted-runtime image digests.
Build the CLI, providers, agent images, and hosted-runtime images from the same checkout.
Keep the generated bundle manifest and the image metadata export with the deployment state.

| Input | Identity and source |
|---|---|
| NemoClaw baseline | `618c002419beb994c62c89b6e1df31783621e481` on `v1` |
| Fabric Rust SDK/provider dependency and image source | `24f068c895e5cbc30286bc743498be4e5014d658`; [SDK dependency](../../crates/nemoclaw-sdk/Cargo.toml), [provider dependency](../../crates/nemoclaw-provider/Cargo.toml), [image recipe](../../image/fabric/Dockerfile) |
| Fabric source archive | SHA-256 `77f78f66a24a8cd8e6f33f9cf49f3db8c5de39e12e095f5599cb63909a05865f`; [offline catalog](../../image/fabric/catalog.json), catalog schema `2` |
| OpenShell | `6648bd0c290efbc41ba131ee9831ee45cd431f94`, version `0.1.2`; [workspace dependencies](../../Cargo.toml), [artifact pins](../../versions.json), [vendored SDK changes](../../crates/vendor/openshell-sdk/NOTICE.md) |
| Bundle tools | OpenTofu `1.12.6`, Docker provider `4.6.0`, Helm provider `3.3.0`; platform-specific archive checksums in [versions.json](../../versions.json) |
| Gateway image | `ghcr.io/nvidia/openshell/gateway@sha256:2fe4dad9118e14ab80a8258b545ea6e6cd74c3469e24ad4e6610f964d98913a2` |
| Gateway chart | `oci://ghcr.io/nvidia/openshell/helm-chart@sha256:7a714bbbbcef7b5ed8dac599e89e89df12eb623fa4454d22f89df41d6f047e2a` |
| Sandbox runtime image | `ghcr.io/nvidia/openshell/sandbox@sha256:bf4797b6c511f2d8ba02955dbba4bf76c1f0dd6d83531420c5408d5f1fb9d72f` |
| Supervisor image | `ghcr.io/nvidia/openshell/supervisor@sha256:d7b5264bb6bc56f4796e6fa3617b8e4a8d785be0b7293542efd8cc250b0fb67a` |
| Development issuer image | `docker.io/nginxinc/nginx-unprivileged@sha256:5aea7cc516b419e3526f47dd1531be31a56a046cfe44754d94f9383e13e2ee99` |
| Baseline default agent image | `nc-fabric-owner-20260924@sha256:c4c0d3add3869e49d0ce8d03bd7e41bbe2682d0df285ef6fde5f181b123cf83e`; a local default, not a published cluster image |
| OpenClaw native input | Version `2026.9.4`; `ghcr.io/openclaw/openclaw@sha256:cc596b846506a5f4cfcee111394a2725f375f01cca2ebb492a161fd1b747f101` in the [agent image recipe](../../image/fabric/Dockerfile) |
| vLLM base image, ARM64 / AMD64 | `vllm/vllm-openai@sha256:3b0e188ffceb3d07e09c3cb5215433a0020eacf02d7f882ed3a8bfd15454477e` / `vllm/vllm-openai@sha256:c2f3b1b964e47809b722b5e75b61b1e7b39a50f70388cf2bf2418f16a9f31da2`; [ARM64 recipe](../../runtimes/vllm/Dockerfile), [AMD64 recipe](../../runtimes/vllm-amd64/Dockerfile) |
| Ollama base image, ARM64 / AMD64 | `ollama/ollama@sha256:684d8674b4315fa18f4f0e973a118ec2652ed96f67563277839985175858e0ba` / `ollama/ollama@sha256:0ff452f6a4c3c5bb4ab063a1db190b261d5834741a519189ed5301d50e4434d1`; version `0.34.0`; [ARM64 recipe](../../runtimes/ollama/Dockerfile), [AMD64 recipe](../../runtimes/ollama-amd64/Dockerfile) |

The runtime base images lack NemoClaw's supervisor until the corresponding recipe is built.
Their digests cannot replace the built hosted-runtime image digest in `spec.services`.
The cluster examples contain zero-digest placeholders and do not identify qualified images.

## Preserved Contracts

| Boundary | Required behavior and current consumer |
|---|---|
| Descriptor discovery and planning | Fabric owns `fabric.adapter/v1alpha2` descriptors and public configuration planning; [SDK planning](../../crates/nemoclaw-sdk/src/fabric_capabilities.rs) requires the selected image's catalog revision to match the bundled revision. [Authoring](../../crates/nemoclaw-authoring/src/capabilities.rs) still reads `config.schema`, `model_schema`, and `settings_schema`. |
| SDK/image/catalog agreement | The [SDK build check](../../crates/nemoclaw-sdk/build.rs) compares the SDK Fabric revision, offline catalog revision, and Dockerfile revision/archive checksum. Installed image discovery and `image.metadata` must additionally establish the selected image's actual descriptor and runtime metadata. |
| Model protocol mapping | The [Fabric projection](../../crates/nemoclaw-sdk/src/fabric_config.rs) preserves provider, model, endpoint, credential environment reference, explicit `api`, tuning, and model settings. Both cluster examples select `openai-completions`; Fabric owns native OpenClaw mapping. Cluster DNS replaces the transport endpoint without replacing protocol selection. |
| Native OpenClaw state | The [pinned adapter](https://github.com/NVIDIA/NeMo-Fabric/blob/24f068c895e5cbc30286bc743498be4e5014d658/adapters/python/openclaw/src/nemo_fabric_adapters/openclaw/adapter.py) locks its retained home and rejects an existing native configuration whose declared sections conflict with Fabric-owned settings; unrelated native bookkeeping may remain. Paths are documented in [native state](../state.md#native-agent-files). Reconfiguring inference does not authorize replacing a sandbox or deleting native files. Retained model PVCs do not preserve sandbox files after sandbox deletion. |
| Hosted-runtime contract | The same Rust supervisor, pinned public model identities, hardware and resident memory protection, model manifests, and explicit recovery rules serve Docker and cluster workloads. Cluster validation checks declared prepared data plus a 16 GiB working reserve and the Pod's declared memory bounds; it does not perform Docker's remaining-download disk-capacity observation or measure cgroup pressure. Storage remains at `/data`, with generated vLLM credentials on separate retained storage at `/credentials`. |
| Cluster lifecycle | The SDK selects a managed gateway's namespace and compiles resources through the existing provider path. The provider verifies cluster and namespace identity, retained storage bindings, and ownership before mutation; it does not adopt an external namespace, PVC, or service. |
| Health | The image bridge preserves unknown and unsupported results. The selected real Fabric backend advertises no native health checks; service readiness and explicit agent replies do not satisfy SDK apply's health gate. See [Fabric health during apply](../usage.md#fabric-health-during-apply). |

The [Fabric management contract](fabric-management.md) owns the bridge interface, installed metadata requirements, native-state limits, and upstream boundaries.
The cluster implementation does not replace those contracts with cluster-specific adapter logic.

## OpenClaw Context Budget

The [cluster examples](../kubernetes.md#run-a-managed-model-service) use a `32768`-token service context and matching OpenClaw `model_metadata.contextWindow`.
An operator reported real OpenClaw turns at NemoClaw revision `4dedf0a82`, using images built from that revision on a kind cluster with one GB300 GPU, through OpenShell `ExecSandbox` and `fabric-agent invoke`.
With Ollama `qwen3:0.6b` at `32768`, its log recorded `n_tokens=19947` and `truncated=0`, and the reply followed the instruction.
At `8192`, the turn reported success but the reply ignored the instruction; context truncation is an inference from the changed behavior, not a confirmed truncation log from that run.
With vLLM `Qwen/Qwen3-4B`, the `8192` setting produced context-overflow HTTP 400 responses and failed automatic compaction; `32768` produced three HTTP 200 chat-completion responses through the supervisor.
That vLLM run retained `kvCacheGiB: 6` and `maxSequences: 1`.
These observations explain the example budget; they do not qualify other models, GPUs, revisions, or longer conversations, and they do not resolve the pinned Fabric health limitation.

## Remaining Compatibility and Qualification Work

- [#12442](https://github.com/NVIDIA/NemoClaw/issues/12442) tracks the unmerged Fabric pin and changing descriptor contracts.
  As recorded in [#12732](https://github.com/NVIDIA/NemoClaw/issues/12732) on 2026-10-07, Fabric PRs [#318](https://github.com/NVIDIA/NeMo-Fabric/pull/318), [#324](https://github.com/NVIDIA/NeMo-Fabric/pull/324), and [#326](https://github.com/NVIDIA/NeMo-Fabric/pull/326) closed without merging; descriptor lookup in [#368](https://github.com/NVIDIA/NeMo-Fabric/pull/368) does not establish replacement planning, model protocol, or retained-state contracts.
  A future pin update must reconcile those consumers and qualify their behavior together.
- [Fabric #298](https://github.com/NVIDIA/NeMo-Fabric/issues/298) owns bounded native health; [#12443](https://github.com/NVIDIA/NemoClaw/issues/12443) owns NemoClaw integration.
  SDK apply requires a supported, passing health report; the reported explicit agent turns do not establish that readiness result.
- [#12692](https://github.com/NVIDIA/NemoClaw/issues/12692) owns managed-gateway OIDC.
  Generated vLLM bearer storage and the gateway's development issuer have separate owners and lifetimes; neither establishes production gateway authentication.
- [#12733](https://github.com/NVIDIA/NemoClaw/issues/12733) and [#12734](https://github.com/NVIDIA/NemoClaw/issues/12734) track real-cluster qualification and E2E/CI coverage.
  Deterministic fixtures establish lifecycle behavior only; the [reported GB300 run](#openclaw-context-budget) covers one revision and model pair.
  Other GPU/model combinations, OpenShift admission, GPU device isolation, and the selected CSI driver's retention behavior still need qualification.
- Team approval of the baseline and service boundary remains an acceptance item under [#12730](https://github.com/NVIDIA/NemoClaw/issues/12730) and [#12732](https://github.com/NVIDIA/NemoClaw/issues/12732).
  This implementation does not claim full issue closure.
