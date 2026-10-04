<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed runtime fixtures

`reference.json` records expected managed specifications, ownership labels, container configuration, host configuration, and gateway TOML for the Spark fixture.

The retained cases cover a gateway process (layout 2) and a managed service process.
Gateway processes require layout 2; layouts 0 and 1 identify gateway storage.
Generation is the synthetic 32-character value `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`.
The fixture does not authorize access to any existing deployment.

Tests check that serialization preserves typed intent and ownership, and that changed configuration changes its identity without selecting new storage.
Launch checks cover declared network and storage bindings, resource limits, GPU access, privilege restrictions, and the no-restart policy rather than comparing complete output snapshots.
Observation and mutation fixtures retain independent Docker responses for ownership, drift, and failure checks.

Service launch fields use `/usr/local/bin/nemoclaw-runtime` and `NEMOCLAW_RUNTIME_SPEC`.
