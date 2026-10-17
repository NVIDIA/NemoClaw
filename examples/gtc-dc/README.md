<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# GTC DC Planned Examples

These nine templates cover Hermes, OpenClaw, and LangChain Deep Agents on the three GTC DC target environments.
Each declares one agent, a local managed Docker gateway, and one managed vLLM service.
They are planned configurations; successful model loading, agent replies, and lifecycle behavior have not been established for these combinations.

| Harness | Linux ARM64 DGX Station | Linux ARM64 DGX Spark | Windows ARM64 with WSL2 and RTX Spark |
|---|---|---|---|
| Hermes | [Station](hermes-dgx-station.yml) | [Spark](hermes-dgx-spark.yml) | [WSL2 RTX Spark](hermes-windows-wsl2-rtx-spark.yml) |
| OpenClaw | [Station](openclaw-dgx-station.yml) | [Spark](openclaw-dgx-spark.yml) | [WSL2 RTX Spark](openclaw-windows-wsl2-rtx-spark.yml) |
| LangChain Deep Agents | [Station](deepagents-dgx-station.yml) | [Spark](deepagents-dgx-spark.yml) | [WSL2 RTX Spark](deepagents-windows-wsl2-rtx-spark.yml) |

All files select [NVIDIA Nemotron 3 Super 120B-A12B NVFP4](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4/tree/ff433f5493e25d631c9f12b5d55c674229923d02), pinned to commit `ff433f5493e25d631c9f12b5d55c674229923d02`.
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
Run the Linux ARM64 tools and Docker engine inside WSL2, with NVIDIA GPU passthrough, RAM, disk, and the API socket available there.
The 88 GiB budget and 28 GiB reserve require at least 116 GiB total memory observable inside WSL2; startup additionally checks for at least 108 GiB available memory.
Configure the WSL2 memory limit and leave capacity for Windows and other applications outside that Linux budget; reject the run if the observed headroom is insufficient.
Model loading and GPU access through WSL2 still require validation on the selected machine.
See [hardware admission and memory checks](../../docs/models.md#choose-a-hardware-profile) and [platform limits](../../docs/limits.md#platforms-models-and-placement).

On the Station, DGX Spark, or inside the RTX Spark's ARM64 WSL2 distribution, run from the repository root:

```sh
cargo run --locked -p nemoclaw-build -- bundle --platform linux_arm64
cargo run --locked -p nemoclaw-build --no-default-features -- runtime runtimes/vllm/build.json
cargo images build --platform linux/arm64 hermes openclaw deepagents
docker image inspect nc-fabric:hermes nc-fabric:openclaw nc-fabric:deepagents --format '{{index .RepoDigests 0}}'
```

All nine targets use the maintained ARM64 Hermes, OpenClaw, or Deep Agents image.

Copy one template into a private deployment directory before planning:

```sh
mkdir -p .local/gtc-dc
cp examples/gtc-dc/openclaw-dgx-spark.yml .local/gtc-dc/deployment.yml
```

Assign a fresh `metadata.uid` and replace both zero-digest image references with references from builds of this checkout.
The runtime builder prints `Runtime image loaded: NAME@sha256:DIGEST`; image inspection prints the agent's `nc-fabric@sha256:DIGEST` reference.
Both images must exist on the Docker daemon selected in the copied file.
Check that its gateway port, model port, and private `/24` do not conflict with existing resources.
The committed templates use gateway ports 17901–17909, model ports 19101–19109, and networks 172.30.180.0/24–172.30.188.0/24.
These distinct addresses do not make concurrent model services fit one host; plan capacity for the combined workload before selecting more than one.

Preview the selected deployment on ARM64:

```sh
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/gtc-dc/state .local/gtc-dc/deployment.yml
```

For a Windows target, copy its corresponding `*-windows-wsl2-rtx-spark.yml` file instead and run the same Linux ARM64 command inside WSL2.

Plan observes the selected environment without creating deployment resources or requesting inference.
Follow [the deployment workflow](../../docs/usage.md) for apply, recovery, and retained teardown, and verify [model and agent responses](../../docs/inference.md#verify-the-result) separately.
At the current Fabric pin, production adapters report unsupported health, so apply fails its agent health check after preserving completed resource changes and state.

## Sources and Adaptation

The configurations adapt the existing [Station](../station/vllm.yaml), [Spark](../spark/vllm.yaml), [AMD64 Nemotron](../nemotron-amd64.yaml), [Hermes](../fabric-hermes.yaml), and [Deep Agents](../fabric.yaml) examples from NemoClaw commit `7ebcbf47cd42ae55ec4c084f0d1e0634c37ad472`.
The changes select Nemotron Super NVFP4, one agent per file, target-specific hardware, a 65,536-token context, explicit memory budgets, and separate deployment identities and addresses.

The [upstream vLLM Nemotron Super recipe](https://github.com/vllm-project/recipes/blob/d80a1692a40e79bc6a5dc77e5a2d71c32e3d4b37/models/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16.yaml), pinned to recipes commit `d80a1692a40e79bc6a5dc77e5a2d71c32e3d4b37`, informs the model and native parser choices.
Its DGX Spark and Station commands use vLLM 0.28.0 with settings these templates do not select, such as an FP8 KV cache and MTP speculative decoding.
These templates use only fields that this checkout's schema accepts.
The pinned ARM64 runtime image builds on the upstream `vllm/vllm-openai` image currently tagged `qwen38-flash-next`, not a vLLM release; whether it serves this model is untested.
They do not reproduce or qualify the upstream recipe.
The [ARM64 runtime notice](../../runtimes/vllm/NOTICE.md) describes retained upstream sources and licenses.
The model is distributed under the [NVIDIA Nemotron Open Model License](https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-nemotron-open-model-license/); the pinned snapshot contains no separate license or notice file.
The RTX Spark profile uses NVIDIA's [documented N1X GPU identities](https://docs.nvidia.com/rtx-spark/rtx-spark-porting-guide/latest/gpu-identification.html) and [CUDA compute capability table](https://developer.nvidia.com/cuda/gpus).
