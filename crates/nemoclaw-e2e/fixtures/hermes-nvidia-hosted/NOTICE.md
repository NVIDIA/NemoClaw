<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Hosted Hermes Fixture Provenance

`v0-export.yaml` is the manually reviewed, credential-value-free output shape from the public `nemoclaw config export` contract delivered by NVIDIA/NemoClaw revision `b6934c6300c4e1e175757e9281ae3a641d9a5b1f` in #11986.
It retains the NVIDIA credential environment-variable reference and the explicit Hermes API interface, but contains no credential value.

`v1.yaml` records separately authored current v1 intent using the required singular `agent` shape.
The deterministic test converts the historical one-element `agents` list only in memory and requires that projection to equal the parsed v1 document; the raw export is never deployed and no production translator is added.
The explicitly selected live scenario reports its lifecycle assertions through Cargo and writes no separate evidence report.
