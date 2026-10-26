<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Super VL on DGX Spark

This experimental profile serves Super VL NVFP4 on one 128 GB DGX Spark with native five-token MTP.
It requires explicit selection and preserves the existing DGX Spark default.

```bash
nemoclaw onboard --profile vllm.dgx-spark-gb10.single.nemotron-3.5-super-vl-120b-a12b-nvfp4
```

The profile requires qualified Linux ARM64 DGX Spark hardware, Docker, driver 580.65.06 or newer,
compute capability 12.1 or newer, and at least 120,000,000,000 bytes of reported GPU memory.
The capacity requirement excludes 64 GB systems and rejects unknown memory capacity before installation.
Available memory and competing workloads still affect startup and serving.

## Serving configuration

The recipe uses a 114,688-token context window, two sequences, and 70% GPU memory utilization.
FlashInfer handles Mamba with FP16 state, stochastic rounding, five Philox rounds,
shared prefix checkpoints, and a 16-token prefix matching unit.
The pinned runtime enables prefix caching and aligned Mamba caching by default.
The deprecated `--mamba-cache-mode` flag is unnecessary.

Native MTP uses the checkpoint's prediction layers; no separate drafter is downloaded.
The checkpoint's original chat template uses `qwen3_coder` tool parsing and `nemotron_v3` reasoning parsing.
The recipe accepts up to eight inline images and disables video and arbitrary remote media URLs.
It retains bearer authentication, fixed serving arguments, catalog receipts, and the read-only model cache.

The model revision and reviewed-code manifest are shared with the existing Station integration.
The runtime is the ARM64 manifest of `vllm/vllm-openai:nightly-3f1bcfd82bb2e93fcd364fc7a5491718453a77e2`.
The recipe pins its digest. The existing launcher verifies model metadata before loading custom code offline.
The two additional permitted launcher options control prefix caching; they cannot select code or model paths.

## Validation limits

Selection and materialization tests cover the Spark profile, fixed arguments, authentication policy,
capacity rejection, and the unchanged default. Existing Station and reviewed-code denial tests remain applicable.

An October 16 GB10 trial passed non-thinking text, inline-image, and tool-call smoke tests with native MTP5.
That trial used model revision `579ffa0b659bc681b89e649fa7c2d5089399602e` and the same runtime.
Hugging Face blob identities match the catalog revision for every file except `README.md`.
The initial trial used direct remote-code trust, so it does not qualify the reviewed-code launcher or managed installer.

The preset records software validation. Full-context load, sustained concurrency, model accuracy,
streaming and thinking tool calls, complete agent onboarding, and managed lifecycle qualification remain pending.
Runtime warnings about default FP8 KV scales and image-kernel tuning remain accuracy and performance qualification items.
These smoke results do not establish a default-model promotion or qualification of every agent runtime.
