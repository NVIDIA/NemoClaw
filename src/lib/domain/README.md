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

V1alpha1 configuration export omits corporate CA material and its digest. An otherwise supported
managed sandbox with an imported CA remains exportable after its retained bundle and startup-profile
digest pass workload authority validation. CA state still participates in stable observation.
Missing, malformed, or mismatched CA state must prevent publication. Export does not change sandbox trust or transfer
source-host trust to another deployment; configure that deployment's CA through onboarding.

Managed OpenClaw exports `agents[].tools.disclosure: direct` only when the registry selection agrees with
the validated startup profile. Absent or explicit `progressive` selection keeps
the canonical omission. Model compatibility can still downgrade runtime tool
behavior. Preserve managed-image authority and full residual profile equality;
admitting disclosure must not admit extra tool gateways or minimal-bootstrap settings.
Hermes keeps its canonical export without `tools`; a retained direct selection or
profile is unsupported even when those two sources agree.

One or more uniquely named read-only secondary OpenClaw agents can share the primary hosted route
on Docker and export in runtime order. Runtime `main` remains the sole default and exports as
`primary`; each secondary keeps its compatible, nonreserved ID and exports
`tools: {allow: [read]}`. Execution, interfaces, authentication, and observability remain primary-owned. The
generator and exporter use the same manifest normalizer in `src/lib/extra-agents-validation.ts`.
Canonical workspace paths stay implicit. Verify the whole retained manifest before
admitting that leaf in the residual profile comparison; other agent settings still
need their own supported projection. Apply the roster and route constraints only
to documents using `tools.allow`, preserving existing v1 agent shapes.

The attached-Ollama source model admits the same roster constraints, but this does not authorize
v1alpha1 publication. `config/verify-export-source.ts` rejects Ollama sources at the compatibility
gate, and `config/export-document.ts` rejects local serving providers. Successful publication
depends on the named-service contract in #11928 and the exporter mapping in #12012.
The source checks retain the selected model, shared tuning, external daemon ownership, and
NemoClaw-managed proxy ownership. Export does not change either resource.

Managed OpenClaw exports `harness.interfaces.dashboard` when the retained port agrees with the
registry and remote bind agrees with recorded preparation. It retains the port 18789 dashboard
marker because the v1alpha1 target disables the dashboard when the block is absent. Loopback bind
remains implicit. Legacy registry entries may omit the port only for the canonical
loopback/default-port profile. Custom URLs, WSL exposure and device-auth changes remain unsupported.
Export does not establish that a dashboard listener is currently running.

`config/verify-agent-interfaces.ts` owns retained dashboard and API checks for both agents.
Each agent has a closed `interfaces` schema; Hermes adds dashboard enablement, internal port,
browser TUI and API port. Enabled Hermes dashboards require matching registry settings and an
allocated API port. The existing registry row publishes that allocation with the lifecycle
generation and sandbox fingerprint, which the export verifier checks against live identity.
Pending reservations and mismatched or changing evidence cannot authorize export.

Hermes emits an explicit disabled dashboard or false TUI because the v1alpha1 target enables both
when they are absent. Public port 18789, internal port 19119 and API port 8642 remain implicit when
their effective source values match the target defaults. Legacy disabled profiles may omit the API
allocation; enabling the dashboard requires an explicit allocation. Dashboard ports retain the
onboarding parser's restrictions, including API ports 8642–8652, port 18642 and equal
public/internal ports. Export describes retained intent and does not inspect current processes or
require a running host forward.

OpenClaw telemetry supports an enabled local OTLP/HTTP collector at
`http://host.openshell.internal:4318`, a printable ASCII service name of 1–256 characters without
edge spaces, and a sample rate from 0 to 1. Canonical disabled telemetry is omitted. Other disabled
settings, Unicode service names, remote collectors, headers, and credentials remain unsupported.
Export preserves the observed effective policy, including local collector rules, without adding
permissions or claiming collector health.
