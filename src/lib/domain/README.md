<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Domain helpers

Domain modules contain pure policy and decision logic. They should not import oclif, spawn processes, read host state directly, or call Docker/OpenShell.

Preferred layout:

```text
src/lib/domain/<area>/<topic>.ts
src/lib/domain/<area>/<topic>.test.ts
```

Flat files are acceptable for small cross-cutting helpers, but workflow-specific logic should live under an area directory that matches the command/action stack when practical:

```text
src/commands/internal/<area>/<verb>.ts
src/lib/actions/<area>/<verb>.ts
src/lib/domain/<area>/<topic>.ts
```

Config export projects supported settings from the validated managed startup receipt and keeps the full residual profile comparison.
OpenClaw telemetry supports an enabled local OTLP/HTTP collector at `http://host.openshell.internal:4318`, a printable ASCII service name of 1–256 characters without edge spaces, and a sample rate from 0 to 1.
Canonical disabled telemetry is omitted; other disabled settings, Unicode service names, remote collectors, headers and credentials remain unsupported.
Export preserves the observed effective policy, including any local collector rules, without adding permissions or claiming collector health.
