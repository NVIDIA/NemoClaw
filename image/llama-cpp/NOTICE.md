<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# llama.cpp runtime

The base is Classic NemoClaw's CUDA llama.cpp image, pinned by digest in this Dockerfile.
It builds ggml-org/llama.cpp revision `8e7f22b67ef4667b4ddd50230771287f328cfb3f` from archive SHA-256 `45a24299e7a24410624489d19924d492bc71a120fa17d9b7cb32f6d5c4f1aed0`.
Classic's build definition at NemoClaw revision `495896a404d77fb4673fc41dbf18d5e0fec91b2a`, `managed-inference/images/llama-cpp/`, records its pinned CUDA bases, compilers and architecture flags.
The base retains llama.cpp's MIT license, authors and source metadata; this layer preserves them and adds the Apache-2.0 NemoClaw supervisor and its retained source archive.
The supervisor's memory-protection attribution is in its retained source NOTICE.md.

The layer changes the entrypoint and user to the v1 runtime contract, leaving the pinned llama-server and CUDA libraries intact.
Models are acquired separately and retain their own licenses.
An image build does not qualify a model, GPU, tool calling or multimodal input.
