<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# DGX Spark Examples

Choose a scenario, build its runtime and harness images, and copy the YAML to your own deployment directory.
These examples target one Linux ARM64 DGX Spark with an NVIDIA GB10 GPU and at least 118 GiB of host memory.
The new scenarios use managed Docker gateways and authenticated vLLM services.

## Choose a Scenario

| File | Agents and models | What it demonstrates |
|---|---|---|
| [pi-small.yaml](pi-small.yaml) | Pi with Qwen3-4B | A small local assistant with explicit Pi model metadata |
| [deepagents-team.yaml](deepagents-team.yaml) | Two Deep Agents with Nemotron 3.5 Lightning 30B-A3B NVFP4 | Two sandboxes, one shared model service, separate agent workspaces and tool settings |
| [shared-model.yaml](shared-model.yaml) | Pi, OpenClaw, and Deep Agents with Qwen3.6-35B-A3B NVFP4 | Three sandboxes reuse one managed model service |
| [two-models.yaml](two-models.yaml) | Pi with Qwen3-4B and Qwen3.6-27B NVFP4 | Fast/smart route selection with two independently managed services |
| [local-and-oracle.yaml](local-and-oracle.yaml) | OpenClaw with local Qwen3.8-27B NVFP4 and an operator-selected hosted model | Managed local inference plus an external oracle; the local route is the default |
| [vllm.yaml](vllm.yaml) | OpenClaw with Qwen3-4B | The original ordinary-vLLM example |
| [spark-inline.yaml](spark-inline.yaml) | OpenClaw with Qwen3.8-Flash-Next-NVFP4 | Model preparation, CPU offloading, and an inline serving recipe |
| [remote-vllm.yaml](remote-vllm.yaml) | OpenClaw with SSH-managed Qwen3-4B and an external Podman gateway | Separate sandbox and model engines; the current OpenShell Podman pin has the [TLS initialization blocker](https://github.com/NVIDIA/OpenShell/issues/3427) |

The Deep Agents researcher has `tools.allow: [read]`; the writer retains the harness's default tools.
Each agent receives its own sandbox, workspace, and artifact directory.
Declaring several agents does not arrange communication or delegate work between them.

The shared-model example allows two concurrent sequences; requests from three harnesses can queue.
The two-model example defaults to `fast`; Pi invocation input can select a declared alias with `{"prompt": "…", "model": "smart"}`.
These aliases select models explicitly; they are not an automatic cost or difficulty router.

## Prepare and Run

Run commands from the repository root.
Use the [build prerequisites](../../docs/build.md) and [managed-model requirements](../../docs/models.md), including Docker with NVIDIA GPU access and driver major 580 or newer.
Apply downloads pinned model weights, creates containers, and reserves model/KV-cache memory.
Run one example at a time unless the host has capacity for their combined budgets.
Preserve existing deployments and use available ports and nonoverlapping gateway network ranges.

Build the ordinary runtime and the harnesses selected by your example:

```sh
cargo run -p nemoclaw-build -- runtime runtimes/vllm/build.json
docker buildx bake pi deepagents openclaw --load
cargo run -p nemoclaw-build -- bundle
```

The inline recipe has its own [Qwen3.8 image build](../../docs/build.md#build-a-runtime-image).
The remote example also requires [SSH placement setup](../../docs/remote-service.md).

Copy the selected example, assign a fresh deployment UUID, and replace its local image digests with those reported by your builds.
The committed local digests identify development artifacts; build the images before applying the examples on another machine.
Keep the model repository revisions pinned.
For `local-and-oracle.yaml`, replace `https://oracle.example/v1` and `replace-with-your-hosted-model`, then supply `ORACLE_API_KEY` in the caller's environment.
The example assumes an OpenAI-compatible hosted Chat Completions endpoint; real oracle requests may incur charges.
See [credential handling](../../docs/usage.md#configuration-and-credentials).

```sh
mkdir -p .local/spark-demo
cp examples/spark/pi-small.yaml .local/spark-demo/deployment.yaml
# Edit deployment.yaml for your UUID, image digests, and available addresses.
dist/linux_arm64/bin/nemoclaw plan --state-dir .local/spark-demo/state .local/spark-demo/deployment.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/spark-demo/state .local/spark-demo/deployment.yaml
dist/linux_arm64/bin/nemoclaw export --state-dir .local/spark-demo/state --output .local/spark-demo/exported.yaml
dist/linux_arm64/bin/nemoclaw apply --state-dir .local/spark-demo/state .local/spark-demo/exported.yaml
```

Apply checks startup and configuration; it does not generate an answer.
Use the [Deep Agents/Pi request procedure](../../docs/agents.md#run-one-deep-agents-or-pi-request) or [headless OpenClaw request procedure](../../docs/agents.md#run-one-headless-openclaw-request) to ask each agent a question.
The procedures explain how to select Pi’s `fast`/`smart` routes and OpenClaw’s `local`/`oracle` routes.
The [qualification record](../../docs/validation/spark-examples-linux-arm64.md) identifies the hosted-oracle checks still pending.
An unchanged apply should report no infrastructure changes.
If startup fails, retain the state and inspect the [model supervisor's status and logs](../../docs/models.md#diagnose-and-recover-a-stopped-runtime) before retrying the original configuration.
Destroy the owned workloads when finished:

```sh
dist/linux_arm64/bin/nemoclaw destroy --state-dir .local/spark-demo/state
```

Destroy retains managed model downloads and gateway storage under the [retention contract](../../docs/state.md#deletion-and-retention).
It does not remove the external oracle or its account credentials.

## Model Sources and Adaptation

Model choices and native parser settings were checked against the [vLLM DGX Spark catalog](https://recipes.vllm.ai/browse?panel=open&hw=dgx_spark_gb10) on 2026-09-17; the recipes repository revision was `296ce72d28595433f5e5ac88fb46ade591664264`.
The YAML pins each selected Hugging Face checkpoint independently.

| Model family | Recipe | Adaptation in these examples |
|---|---|---|
| Qwen3-4B | [Qwen3 recipe](https://recipes.vllm.ai/Qwen/Qwen3-4B) | Existing small-model baseline, Hermes tool parser, Qwen3 reasoning parser |
| Qwen3.6-35B-A3B and 27B | [35B-A3B recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-35B-A3B), [27B recipe](https://recipes.vllm.ai/Qwen/Qwen3.6-27B) | Public NVIDIA NVFP4 checkpoints, Qwen3 Coder tool parser, Qwen3 reasoning parser |
| Qwen3.8-27B | [Qwen3.8 recipe](https://recipes.vllm.ai/Qwen/Qwen3.8-27B) | Public NVIDIA NVFP4 checkpoint, Qwen3 XML tool parser, Qwen3 reasoning parser |
| Nemotron 3.5 Lightning | [Lightning recipe](https://recipes.vllm.ai/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16) | Public NVIDIA NVFP4 checkpoint, FlashInfer Mamba backend, Qwen3 XML tools, Nemotron v3 reasoning |

The new YAML uses 32K context, one or two concurrent sequences, explicit KV-cache budgets, generated bearer authentication, and the pinned ordinary runtime.
It does not reproduce the upstream performance configurations: speculative decoding, long-context scaling, and custom repository code are not enabled.
These are text-agent scenarios; the presence of a vision-capable model does not qualify multimodal agent input.

Validation status: parser, schema, compiled resource topology, export round trips, and maintained adapter contracts are checked by the Rust tests, including this nested directory.
See the [live qualification record](../../docs/validation/spark-examples-linux-arm64.md) for tested model/scenario combinations and remaining gates.
Passing configuration checks alone does not establish model loading, tool use, or performance.
