<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell SDK Source

Source: ai-openshell/openshell (formerly NVIDIA/OpenShell), `crates/openshell-sdk`, revision `152c59d3178039e3fbb4a5595f9fff7216a6be92`.
Upstream: https://github.com/ai-openshell/openshell/tree/152c59d3178039e3fbb4a5595f9fff7216a6be92/crates/openshell-sdk

The Rust sources, tests, and README are unchanged.
Upstream copyright headers, the Apache-2.0 license, and third-party notices are retained.

Modifications on 2026-11-24 (refreshed from OpenShell v0.1.10):

- Resolve inherited package and dependency values from the upstream workspace into this standalone manifest.
- Replace the relative `openshell-core` dependency with the same Git revision and disable its default features so NemoClaw does not compile telemetry support.
- Replace the relative `openshell-crypto` dependency with the same Git revision and the `aws-lc` backend the upstream workspace selects.
- Remove inherited workspace lint settings and declare an independent workspace for this vendored dependency.

NemoClaw's root manifest patches only `openshell-sdk`; the other OpenShell crates remain pinned Git dependencies.
Remove this patch when the pinned upstream SDK supports disabling core telemetry.
