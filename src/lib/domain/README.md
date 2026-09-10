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

Configuration export represents retained startup intent from a validated managed-image receipt.
Preserve image authority and full residual profile comparison when admitting a supported setting.

Managed OpenClaw exports `agents[].tools.disclosure: direct` only when the registry selection agrees with
the validated startup profile. Absent or explicit `progressive` selection keeps
the canonical omission. Model compatibility can still downgrade runtime tool
behavior. Preserve managed-image authority and full residual profile equality;
admitting disclosure must not admit extra tool gateways or minimal-bootstrap settings.
Hermes keeps its canonical export without `tools`; a retained direct selection or
profile is unsupported even when those two sources agree.

Managed OpenClaw exports `agents[].interfaces.dashboard` when the retained port agrees with the
registry and remote bind agrees with recorded preparation. Port 18789 and loopback bind are omitted.
Legacy registry entries may omit the port only for the canonical loopback/default-port profile.
Custom URLs, WSL exposure and device-auth changes remain unsupported. Export does not establish
that a dashboard listener is currently running.

OpenClaw telemetry supports an enabled local OTLP/HTTP collector at
`http://host.openshell.internal:4318`, a printable ASCII service name of 1–256 characters without
edge spaces, and a sample rate from 0 to 1. Canonical disabled telemetry is omitted. Other disabled
settings, Unicode service names, remote collectors, headers, and credentials remain unsupported.
Export preserves the observed effective policy, including local collector rules, without adding
permissions or claiming collector health.
