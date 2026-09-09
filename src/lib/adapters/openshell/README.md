<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell export reads

Config export uses the capability boundaries from #9802. Its read-only additions belong to
issue #10938 and PR #11065. They do not complete the capability migrations in that epic.

| Read | Owner | Transport and reason |
| --- | --- | --- |
| Provider endpoint and identity | `providers.ts` | SDK `raw.getProvider`, plus `raw.getProviderProfile` for native NVIDIA inference without overrides; the pinned SDK has no curated gateway-provider read. Reuses the metadata fields from `provider-adapter.ts` (#9806, #9825). |
| Sandbox identity, image, and attachments | `sandboxes.ts` | SDK `raw.getSandbox`; curated `sandbox.get` omits workspace, image, and active policy version. |
| Configuration identity | `sandbox-config.ts` | SDK `raw.getSandboxConfig` by verified ID; curated `sandbox.getConfig` does a new name lookup and omits workspace. |
| Effective policy document and applied revision | `sandbox-policy.ts` and `sandbox-policy-cli.ts` | Retains the existing policy contract from #10150. YAML conversion and policy migration remain with #9805 and #9826. |
| Inference route | `inference/live.ts` | Retains the CLI read with an explicit gateway. The separate generated inference client remains with #9809 and #9828. |
| Managed workload and gateway ownership | NemoClaw registry and gateway state | These are NemoClaw provenance, not OpenShell resource fields. |

Use a curated SDK method when it preserves all fields and scope required by its consumer.
Production access to the raw client and generated messages must stay inside this directory. The SDK connection in
`sdk.ts` is shared with sandbox execution. It retains the existing managed state-root check,
explicit loopback gateway, and bounded local mTLS file reads. No second credential loader is needed.

The read interfaces require an explicit gateway, workspace, and abort signal. Only a confirmed
not-found response returns `null`. Other failures use the existing sandbox error categories and
fixed messages. There is no CLI fallback after an SDK failure. Resource versions stay decimal
strings so uint64 values cannot lose precision.

`sdk-read-schema.ts` defines TypeBox schemas for consumed response fields. Validate before
projection, keep credential values opaque, and check response identities against the request.
Schema failures use fixed messages without rejected values.

Provider reads return credential names and requested non-secret config values.
For native NVIDIA hosted inference with no overrides, export also reads `raw.getProviderProfile`
through the same gateway and workspace. It requires the built-in `nvidia` profile, static scope,
revision zero, inference capability, and its single `integrate.api.nvidia.com:443` endpoint.
The pinned OpenShell native resolver uses `/v1` on that host. Export records the built-in profile
as the endpoint evidence. Custom profiles, profile scope changes, and provider config overrides
cannot use this derivation.

Provider reads retain the complete config-key inventory so export can reject unsupported configuration. Sandbox reads omit
environment values. Configuration reads return revision metadata, not settings or credential values.
Export compares two complete observations and can repeat that pair once when state changes.

Other provider CRUD, credential, profile, attachment, policy mutation, and lifecycle consumers
keep their existing adapters. Their migration remains with the linked capability issues. This
change does not replace their contracts or claim SDK qualification for their operations.
