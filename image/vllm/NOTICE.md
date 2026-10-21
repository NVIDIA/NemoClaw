<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# vLLM Runtime

This artifact adds the NemoClaw runtime supervisor to the immutable multi-platform upstream vLLM image named in its Dockerfile, built for the Linux ARM64 or AMD64 host that builds it.
It does not apply model-specific patches or embed model weights.
The selected model is downloaded into retained storage when the deployment is applied.

`supervisor-source.tar.gz` retains the supervisor's source and locked dependency sources, including their original license files.
The runtime policy credit remains in `crates/nemoclaw-runtime/NOTICE.md` inside the archive.
`/opt/nemoclaw/source/Dockerfile` and `supervisor.Dockerfile` retain this image's and the supervisor's build instructions.
The upstream image retains its vLLM and installed dependency notices.
Model license and notice files present at the selected repository root are downloaded with the model snapshot.

The [AMD64 Nemotron example](../../examples/nemotron-amd64.yaml) adapts its configuration from NemoClaw main revision `97745a7ad9649f851704493e4b670b3674f875aa`:

- [Serving recipe](https://github.com/NVIDIA/NemoClaw/blob/97745a7ad9649f851704493e4b670b3674f875aa/managed-inference/recipes/vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1.yaml).
- [Model identity](https://github.com/NVIDIA/NemoClaw/blob/97745a7ad9649f851704493e4b670b3674f875aa/managed-inference/models/vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.v1.yaml).

The example preserves that model revision, served name, GPU minimums, native serving flags, bearer authentication, IPC selection, and startup timeout in v1's service fields, and declares driver major 580 as its minimum.
This adaptation does not establish live qualification on AMD64 hardware.
