<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GTC DC Examples

The nine local-inference templates cover Hermes, OpenClaw, and LangChain Deep Agents on the three ARM64 GTC DC target environments.
Each declares one agent, a local managed Docker gateway, and one managed vLLM service.
On DGX Spark, the Hermes and Deep Agents templates are verified; the other combinations are untested.
The directory also links an [AMD64 Kubernetes profile](#amd64-kubernetes-with-nvidia-cloud-inference) that uses NVIDIA cloud inference.

| Template | DGX Spark result |
|---|---|
| Hermes | Applies and answers, including tool calls |
| Deep Agents | Applies and answers, including file tool calls |
| OpenClaw | Not yet run with this template |

The first apply downloads the 74.8 GiB model; on the verified DGX Spark the download took about 55 minutes and loading about 15.
After the model loaded, a short question took about 5 seconds, a five-point itinerary about 15–18 seconds, and a task with a tool call 17–29 seconds.
The model's reasoning left room for complete answers within the templates' 1,024-token limit.
Switching a deployment from one harness to another replaces only the sandbox, while the model service keeps running.
DGX Station and Windows WSL2 RTX Spark remain untested.

| Harness | Linux ARM64 DGX Station | Linux ARM64 DGX Spark | Windows ARM64 with WSL2 and RTX Spark |
|---|---|---|---|
| Hermes | [Station](hermes-dgx-station.yaml) | [Spark](hermes-dgx-spark.yaml) | [WSL2 RTX Spark](hermes-windows-wsl2-rtx-spark.yaml) |
| OpenClaw | [Station](openclaw-dgx-station.yaml) | [Spark](openclaw-dgx-spark.yaml) | [WSL2 RTX Spark](openclaw-windows-wsl2-rtx-spark.yaml) |
| LangChain Deep Agents | [Station](deepagents-dgx-station.yaml) | [Spark](deepagents-dgx-spark.yaml) | [WSL2 RTX Spark](deepagents-windows-wsl2-rtx-spark.yaml) |

The local-inference files select [NVIDIA Nemotron 3 Super 120B-A12B NVFP4](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4/tree/ff433f5493e25d631c9f12b5d55c674229923d02), pinned to commit `ff433f5493e25d631c9f12b5d55c674229923d02`.
The serving configuration uses a 65,536-token context, one sequence, an 8 GiB KV cache, and an 88 GiB total GPU budget.
That budget covers the approximately 74.8 GiB pinned weights and declared cache; actual runtime headroom and context capacity still require verification.
KV and SSM cache dtypes use runtime defaults; model output accuracy and tool calls also require live checks.

## Prepare the Target Host

Ubuntu 24.04 is the assumed Linux environment, including the WSL2 distribution.
Use [the build prerequisites](../../docs/build.md), Docker with NVIDIA GPU access and the containerd image store, and driver major 580 or newer.
Each target requires exactly one visible NVIDIA GPU; these configurations provide neither CPU offloading nor multi-GPU serving.

| Target | Hardware requirement | Memory accounting |
|---|---|---|
| DGX Station | ARM64 GB300, compute capability at least 10.3, observable dedicated GPU-memory counters | 88 GiB GPU budget; 32 GiB host reserve |
| DGX Spark | ARM64 GB10, compute capability at least 12.1, at least 118 GiB host RAM | 88 GiB serving budget plus 28 GiB host reserve; both use shared host/GPU RAM |
| Windows + WSL2 RTX Spark | ARM64 N1X, 128 GB unified-memory configuration, compute capability at least 12.1 | 88 GiB serving budget plus 28 GiB host reserve inside WSL2; shared CPU/GPU memory |

RTX Spark combines an [ARM64 N1X processor](https://docs.nvidia.com/rtx-spark/rtx-spark-porting-guide/latest/overview.html) with [shared CPU/GPU memory](https://www.nvidia.com/en-us/products/rtx-spark/specifications/).
These examples select its 128 GB configuration and the `rtx-spark` hardware profile.
Run the Linux ARM64 tools inside WSL2, with the Docker API socket, NVIDIA GPU access, RAM, and disk available there.
NemoClaw's [main-line readiness checks](https://github.com/NVIDIA/NemoClaw/blob/4ce30c292c0a518ee713f2d10460d473bb904637/docs/reference/system-readiness.mdx) qualify Docker Desktop's WSL integration and treat Docker Engine installed inside WSL as unqualified; neither has run these templates.
Under WSL2, CUDA uses the Windows NVIDIA driver, which appears inside the distribution as a stub `libcuda.so`; do not install a Linux GPU driver there ([CUDA on WSL](https://docs.nvidia.com/cuda/wsl-user-guide/index.html)).
The 88 GiB budget and 28 GiB reserve require at least 116 GiB total memory observable inside WSL2; startup additionally checks for at least 108 GiB available memory.
A WSL2 memory limit that passes these checks leaves at most 12 GiB of the 128 GB configuration for firmware, Windows, and other applications.
Whether memory observed inside WSL2 accounts for GPU allocations made through the Windows driver is untested; measure both inside WSL2 and in Windows while the model loads.
Model loading and GPU access through WSL2 still require validation on the selected machine.
See [hardware admission and memory checks](../../docs/models.md#choose-a-hardware-profile) and [platform limits](../../docs/limits.md#platforms-models-and-placement).

On the Station, DGX Spark, or inside the RTX Spark's ARM64 WSL2 distribution, run from the repository root:

```sh
cargo run --locked -p nemoclaw-build -- bundle --platform linux_arm64
docker buildx bake vllm
cargo images build --platform linux/arm64 hermes openclaw deepagents
docker image inspect nc-prototype-vllm:rust-v1 nc-fabric:hermes nc-fabric:openclaw nc-fabric:deepagents --format '{{index .RepoDigests 0}}'
```

All nine targets use the maintained ARM64 Hermes, OpenClaw, or Deep Agents image.

Copy one template into a private deployment directory before planning:

```sh
mkdir -p .local/gtc-dc
cp examples/gtc-dc/openclaw-dgx-spark.yaml .local/gtc-dc/deployment.yaml
```

Assign a fresh `metadata.uid` and replace both zero-digest image references with references from builds of this checkout.
Image inspection prints each image's `NAME@sha256:DIGEST` reference.
Both images must exist on the Docker daemon selected in the copied file.
Check that its gateway port, model port, and private `/24` do not conflict with existing resources.
The committed templates use gateway ports 17901–17909, model ports 19101–19109, and networks 172.30.180.0/24–172.30.188.0/24.
These distinct addresses do not make concurrent model services fit one host; plan capacity for the combined workload before selecting more than one.

Preview the selected deployment on ARM64:

```sh
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/gtc-dc/state .local/gtc-dc/deployment.yaml
```

For a Windows target, copy its corresponding `*-windows-wsl2-rtx-spark.yaml` file instead and run the same Linux ARM64 command inside WSL2.

Plan observes the selected environment without creating deployment resources or requesting inference.
Follow [the deployment workflow](../../docs/usage.md) for apply, recovery, and retained teardown, and verify [model and agent responses](../../docs/inference.md#verify-the-result) separately.

## AMD64 Kubernetes with NVIDIA Cloud Inference

One profile targets Linux AMD64 Kubernetes workers, an existing OpenShell gateway, and NVIDIA's hosted Super VL API.
It replaces the earlier three-OpenClaw Kubernetes example with two sandboxes: one OpenClaw agent and one Hermes agent.
Inference runs on NVIDIA's cloud; the Kubernetes workers need no local GPU.
Choose the [YAML](kubernetes-amd64.yaml) or equivalent [OpenTofu HCL](kubernetes-amd64.tf) configuration.
Both links are symlinks to the owning files in `examples/kubernetes/`.
The profile requires live validation.

| Sandbox | Harness | Image metadata environment variable |
|---|---|---|
| `openclaw` | `nvidia.fabric.openclaw` | `NEMOCLAW_OPENCLAW_IMAGE_METADATA` |
| `hermes` | `nvidia.fabric.hermes` | `NEMOCLAW_HERMES_IMAGE_METADATA` |

Both agents select `nvidia/nemotron-3.5-super-vl-120b-a12b` at `https://integrate.api.nvidia.com/v1` through the OpenAI completions API.
Set `NVIDIA_INFERENCE_API_KEY` on the applying host; [credential ownership](../../docs/security.md#credentials-and-authentication) describes its storage and removal.
Model requests can incur cloud inference charges.
Each harness gets a registration bound to its image's executables, using the shared endpoint and credential reference.
Both sandboxes retain explicit process and filesystem policies, with writes limited to `/sandbox`.
Hermes also reads its packaged source, Switchyard plugin, and the public CA bundle used for HTTPS.

Follow the [Kubernetes prerequisites and image preparation](../../docs/kubernetes.md#prerequisites), then the [existing-gateway procedure](../../docs/kubernetes.md#use-an-existing-gateway).
Select a Linux AMD64 image for each harness, push both to a registry the cluster can pull from, and supply their matching metadata bundles.
Set `GATEWAY_TOKEN` and the `GATEWAY_CA`, `GATEWAY_CERT`, and `GATEWAY_KEY` TLS file references for the existing gateway.

For YAML, assign a fresh deployment UID and replace the gateway endpoint and both image digests before planning.
Follow the [deployment workflow](../../docs/usage.md) for apply and retained teardown.

For HCL, copy `hosted-nvidia.tf` alone into a private working directory and set `gateway_endpoint`, a fresh `workspace`, and both `images` references.
Pin the two NVIDIA providers to the matching native bundle's manifest version and install them from its `providers` directory, as in the [HCL setup](../hcl/travel-team/README.md#run-it).
Run the bundle's `libexec/tofu` to initialize, validate, plan, and apply that directory.
The HCL protects its workspace with `prevent_destroy`; full workspace deletion requires removing that protection and setting `destroy=true`.
Choose one authoring path per deployment, with its own workspace and state; applying both configurations does not adopt the other path's resources.
Verify an [agent response](../../docs/inference.md#verify-the-result) from each sandbox separately.

## Sources and Adaptation

The configurations adapt the existing [Station](../station/vllm.yaml), [Spark](../spark/vllm.yaml), [AMD64 Nemotron](../nemotron-amd64.yaml), [Hermes](../fabric-hermes.yaml), and [Deep Agents](../fabric.yaml) examples from NemoClaw commit `7ebcbf47cd42ae55ec4c084f0d1e0634c37ad472`.
The changes select Nemotron Super NVFP4, one agent per file, target-specific hardware, a 65,536-token context, explicit memory budgets, and separate deployment identities and addresses.

The [upstream vLLM Nemotron Super recipe](https://github.com/vllm-project/recipes/blob/d80a1692a40e79bc6a5dc77e5a2d71c32e3d4b37/models/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16.yaml), pinned to recipes commit `d80a1692a40e79bc6a5dc77e5a2d71c32e3d4b37`, informs the model and native parser choices.
Its DGX Spark and Station commands use vLLM 0.28.0 with settings these templates do not select, such as an FP8 KV cache and MTP speculative decoding.
These templates use only fields that this checkout's schema accepts.
The pinned runtime image builds on the upstream `vllm/vllm-openai` v0.32.0 release image, pinned by digest.
They do not reproduce or qualify the upstream recipe.
The [ARM64 runtime notice](../../image/vllm/NOTICE.md) describes retained upstream sources and licenses.
The model is distributed under the [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/); the pinned snapshot contains no separate license or notice file.
The RTX Spark profile uses NVIDIA's [documented N1X GPU identities](https://docs.nvidia.com/rtx-spark/rtx-spark-porting-guide/latest/gpu-identification.html) and [CUDA compute capability table](https://developer.nvidia.com/cuda/gpus).
