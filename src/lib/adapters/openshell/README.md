<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell export reads

Config export uses the capability boundaries from #9802. Its read-only additions belong to
issue #10938 and PR #11065. They do not complete the capability migrations in that epic.

| Read | Owner | Transport and reason |
| --- | --- | --- |
| Provider endpoint and identity | `providers.ts` | SDK `raw.getProvider`, plus `raw.getProviderProfile` for native NVIDIA inference without overrides and requested managed Brave/OpenAI contracts; the pinned SDK has no curated gateway-provider read. Reuses the metadata fields from `provider-adapter.ts` (#9806, #9825). |
| Sandbox identity, image, and attachments | `sandboxes.ts` | SDK `raw.getSandbox`; curated `sandbox.get` omits workspace, image, and active policy version. |
| Configuration identity and effective policy | `sandbox-config.ts` | SDK `raw.getSandboxConfig` by verified ID returns both in one response; curated `sandbox.getConfig` does a new name lookup and omits workspace. Policy reads for other consumers remain with #9805 and #9826. |
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
Policy protobuf JSON passes through a consumed-field schema before document conversion. Converter
input types come from that schema; fields outside the conversion stay with the complete policy validator.
Schema failures use fixed messages without rejected values.

Provider reads return credential names and requested non-secret config values.
For native NVIDIA hosted inference with no overrides, export also reads `raw.getProviderProfile`
through the same gateway and workspace. It requires the built-in `nvidia` profile, static scope,
revision zero, inference capability, and its single `integrate.api.nvidia.com:443` endpoint.
The pinned OpenShell native resolver uses `/v1` on that host. Export records the built-in profile
as the endpoint evidence. Custom profiles, profile scope changes, and provider config overrides
cannot use this derivation.

Consumers can request `profileContract: "brave"` or `"openai"` to qualify a managed profile.
The reader resolves `raw.getProviderProfile` at the provider's `profileWorkspace` through the
same gateway. Normal onboarding imports the checked-in profile in the `default` workspace.
User profiles must have a nonzero revision and a scope matching their binding; builtin profiles
must have global binding, empty scope, and revision zero. Matching the profile name is insufficient.

Qualification requires the checked-in credential declaration, endpoint rules, binary allowlist,
and inference capability. Brave permits its single header credential and search endpoint;
OpenAI requires the endpointless inference contract. Credential refresh, token grants, discovery,
changed rewriting rules, and unknown protobuf fields in the profile's semantic messages fail.
Provider credential values and handles remain opaque. The reader returns profile identity,
source, scope, revision, and binding for inclusion in complete export observations. A changed
binding or profile revision therefore prevents publication until observations agree. Hosted
consumers that do not request this qualification retain their existing endpoint semantics.

Provider reads retain the complete config-key inventory so export can reject unsupported configuration. Sandbox reads omit
environment values. Configuration reads return revision metadata and a credential-free effective policy document, without settings values.
The policy conversion follows the reviewed OpenShell release: filesystem defaults, compact ports,
query matchers, MCP selectors, and provider-composed rules retain their document meaning. Unknown
protobuf fields are rejected instead of omitted. Global policy revisions use the same precedence as
`policy get --full`; export still requires agreement with the observed sandbox and configuration revision.
Export compares two complete observations and can repeat that pair once when state changes.

Managed rebuild recovery and snapshot-clone provider inspection, profile import, and creation use
`managed-provider-adapter.ts`, which binds the typed CLI adapter to the selected gateway. Provider
detachment, deletion, replacement cleanup, and other lifecycle operations keep their existing
adapters until the remaining #9806 migration slices land. This does not claim SDK qualification for
those operations.

Policy export rejects SDK messages and serialized YAML above 1 MiB. It checks cancellation before conversion and after SDK loading. OpenShell SDK 0.0.106 does not expose a transport receive-size option.
