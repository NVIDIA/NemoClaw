<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed runtime fixtures

`reference.json` records the Go `managed.Spec.JSON`, ownership labels, container configuration, host configuration, and gateway TOML generated from the Spark configuration fixture at `v1-poc` revision `b549ccd43e6102b72aa9c65ee17abfe3c429fc0b`.

The retained cases cover gateway process layout 2 and the inference service.
Obsolete gateway process layouts 0 and 1 are rejected before engine access.
Gateway storage retains its separate layout-0 specification and durable identity.
Generation is the synthetic 32-character value `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
The fixture does not authorize access to any existing deployment.

Tests compare exact specification strings and label hashes.
Launch comparisons normalize only omitted versus null optional maps, which differ between the Go Docker client and Bollard.
All non-null selected launch settings remain exact.

The fixture now uses `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
These launch fields were updated after the legacy aliases were removed.
