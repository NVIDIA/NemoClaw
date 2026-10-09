<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell SDK Source

Source: NVIDIA/OpenShell, `crates/openshell-sdk`, revision `e1f3c82caa3ed3b65de22889ae7ef32a774878ef`.
Upstream: https://github.com/NVIDIA/OpenShell/tree/e1f3c82caa3ed3b65de22889ae7ef32a774878ef/crates/openshell-sdk

The Rust sources, tests, and README are unchanged.
Upstream copyright headers, the Apache-2.0 license, and third-party notices are retained.

Modifications on 2026-10-09 (refreshed from OpenShell v0.1.3-pre.8):

- Resolve inherited package and dependency values from the upstream workspace into this standalone manifest.
- Replace the relative `openshell-core` dependency with the same Git revision and disable its default features so NemoClaw does not compile telemetry support.
- Remove inherited workspace lint settings and declare an independent workspace for this vendored dependency.

NemoClaw's root manifest patches only `openshell-sdk`; the other OpenShell crates remain pinned Git dependencies.
Remove this patch when the pinned upstream SDK supports disabling core telemetry.
