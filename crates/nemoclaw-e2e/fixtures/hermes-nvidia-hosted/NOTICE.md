<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted Hermes Fixture Provenance

`v0.yaml` records the representative supported Hermes deployment shape at NVIDIA/NemoClaw revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f`.
Its SHA-256 is asserted by the deterministic test.

`v0-export.yaml` is the manually reviewed, credential-value-free output shape from the public `nemoclaw config export` contract delivered by that revision in #11986.
It retains the NVIDIA credential environment-variable reference and the explicit Hermes API interface, but contains no credential value.
Its SHA-256 is `6159d9351d25b4d30e6df80fdb700f144418eaae80a2385b9602e15f5412543a` and is asserted by the deterministic test.

`v1.yaml` records separately authored current v1 intent using the required singular `agent` shape.
The deterministic test converts the historical one-element `agents` list only in memory and requires that projection to equal the parsed v1 document; the raw export is never deployed and no production translator is added.
The explicitly selected live scenario reports its lifecycle assertions through Cargo and writes no separate evidence report.
