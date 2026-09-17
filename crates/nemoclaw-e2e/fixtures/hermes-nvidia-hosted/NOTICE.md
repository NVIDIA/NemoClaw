<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted Hermes Fixture Provenance

`v0.yaml` records the representative supported Hermes deployment shape at NVIDIA/NemoClaw revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f`.
Its SHA-256 is asserted by the deterministic test.

`v0-export.yaml` is the manually reviewed, credential-value-free output shape from the public `nemoclaw config export` contract delivered by that revision in #11986.
It retains the NVIDIA credential environment-variable reference and the explicit Hermes API interface, but contains no credential value.
Its SHA-256 is `6159d9351d25b4d30e6df80fdb700f144418eaae80a2385b9602e15f5412543a` and is asserted by the deterministic test.

`v1.yaml` records the expected result after the ordinary v1 parser applies target-owned defaults to those raw bytes.
The ignored live scenario remains non-qualifying until an owned v0 deployment reproduces the reviewed export and its lifecycle evidence is retained.
