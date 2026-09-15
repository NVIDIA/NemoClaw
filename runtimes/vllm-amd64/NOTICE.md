<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Linux AMD64 vLLM Runtime

This artifact packages the shared NemoClaw supervisor with the pinned Linux AMD64 vLLM 0.27.1 image.
It applies no vLLM source patches and contains no model weights or preparation tools.
It retains the supervisor source archive, locked dependency sources and original licenses, Dockerfile, build manifest, and build hashes under `/opt/nemoclaw/source/`, as described by the [generic runtime notice](../vllm/NOTICE.md).
The upstream image retains its installed vLLM and dependency notices.
Model license and notice files at the selected repository root are downloaded with its snapshot.

On 2026-09-15, the base-image pin and [Nemotron configuration](../../examples/nemotron-amd64.yaml) were adapted from NemoClaw main revision `97745a7ad9649f851704493e4b670b3674f875aa`:

- [Serving recipe](https://github.com/NVIDIA/NemoClaw/blob/97745a7ad9649f851704493e4b670b3674f875aa/managed-inference/recipes/vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.linux-amd64-single.v1.yaml).
- [Model identity](https://github.com/NVIDIA/NemoClaw/blob/97745a7ad9649f851704493e4b670b3674f875aa/managed-inference/models/vllm.nemotron-3.5-lightning-30b-a3b-nvfp4.v1.yaml).

The example preserves that model revision, served name, GPU minimums, native serving flags, bearer authentication, IPC selection, and startup timeout in v1's service fields.
It uses the v1 snapshot store, watchdog, and SSH placement contracts, and declares driver major 580 as its minimum.
The supervisor generates the bearer credential in retained storage and passes it to vLLM through its child environment.
This adaptation does not establish live qualification on AMD64 hardware.
