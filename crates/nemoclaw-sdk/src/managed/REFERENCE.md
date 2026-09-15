<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed runtime fixtures

`reference.json` records expected managed specifications, ownership labels, container configuration, host configuration, and gateway TOML for the Spark fixture.

The retained cases cover gateway process layout 2 and the inference service.
Obsolete gateway process layouts 0 and 1 are rejected before engine access.
Gateway storage retains its separate layout-0 specification and durable identity.
Generation is the synthetic 32-character value `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
The fixture does not authorize access to any existing deployment.

Tests compare exact specification strings and label hashes.
Launch comparisons normalize omitted versus null optional maps because Docker treats them equivalently.
All non-null selected launch settings remain exact.

The fixture now uses `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
These launch fields were updated after the legacy aliases were removed.
