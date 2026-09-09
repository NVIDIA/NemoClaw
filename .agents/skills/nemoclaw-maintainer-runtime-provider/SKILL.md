---
name: nemoclaw-maintainer-runtime-provider
description: Implement or review a NemoClaw managed runtime provider through RuntimeProviderBundle, qualification-backed activation, provider-neutral orchestration, and E2E qualification. Use for a new native provider, provider activation, or runtime-provider architecture work. Do not use for the portable experimental profile.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Add a Managed Runtime Provider

Add one provider through the repository's runtime-provider contract. Keep generic orchestration
independent of provider implementations and provider names.

## Confirm Product Scope

Apply the product scope gate in `AGENTS.md` before implementation or approval. Require an accepted
issue or accepted design decision that defines ownership, lifecycle, compatibility, security, and
validation. A valid bundle or passing test does not establish a supported surface.

Keep the portable experimental profile independent. Do not change portable selection, lifecycle,
or compatibility behavior as part of a native managed-provider change.

## Load Current Authority

Before planning, editing, or reviewing:

1. Read `src/lib/onboard/runtime-provider/contract.ts` and `registry.ts`.
2. Read `activation.ts`, `current.ts`, and `native-qualification-authority.ts`.
3. Read the candidate provider factory and its provider-owned helpers.
4. Trace `SandboxEntry.openshellDriver` through onboarding and every lifecycle action in scope.
5. Read the focused contract, activation, provider, architecture, and E2E-support tests.

Use checked-in source and tests as behavior authority. Use these references for interpretation:

- Read [Bundle API Contract](references/api-contract.md) before changing a provider bundle.
- Read [Activation and Qualification](references/activation-and-qualification.md) before making a
  provider production-selectable.
- Read [Implementation and Review](references/implementation-and-review.md) before editing generic
  orchestration, planning validation, or reviewing a provider PR.

## Choose the Delivery State

Name the intended state before coding:

- **Candidate bundle:** The registry accepts one complete 14-surface object. Optional surfaces may
  declare `supported: false` with a reason. The provider is not production-selectable.
- **Activated provider:** Every required surface and qualification field passes the current
  activation contract. The provider enters through `createCurrentRuntimeProviderBundles(...)`.
- **Activation-contract extension:** The provider topology cannot satisfy the current activation
  contract. Stop implementation until maintainers accept the contract change and its validation.
- **Review:** Evaluate the claimed state only. Do not turn an incomplete candidate into an
  activated provider during review.

Do not add a candidate to the established-provider registry to bypass activation. Do not emulate
Docker commands or invent container-engine identities to satisfy a contract that does not match
the provider topology.

## Implement One Provider Identity

Resolve configuration once to one opaque provider ID. Register one `RuntimeProviderBundle` under
that identity. Bind every surface, receipt, resource handle, and persisted sandbox record to it.

Provider-owned modules must own provider-specific commands, endpoint or socket authority, runtime
resource identity, network preparation, lifecycle operations, recovery, and cleanup. Generic
orchestration must consume bundle surfaces. It must not import a provider implementation or branch
on a provider name.

If the current contract lacks a required provider-owned behavior, propose the narrow contract
extension and its tests. Do not add an ambient environment switch or a central provider-name
branch as a substitute.

Persist the selected provider ID in `SandboxEntry.openshellDriver`. Start, stop, rebuild, snapshot,
restore, recovery, inference changes, and destroy must resolve the same bundle from persisted
state. Reject missing, unknown, reused, or drifted authority before mutation.

## Validate and Qualify

Follow the focused checks in [Implementation and Review](references/implementation-and-review.md).
Run the current type, repository, contract, activation, provider, and architecture checks that the
diff affects.

Local and CI checks establish contract behavior. They do not replace protected qualification or
the complete supported live E2E matrix against the commit under review. Use
`nemoclaw-maintainer-e2e` when the maintainer requests the GitHub Actions run.

## Report

Return:

- accepted product scope and intended delivery state;
- provider ID, topology, authority model, and persisted state boundary;
- implemented, unsupported, and extended bundle surfaces;
- remaining provider-name branches in generic orchestration;
- focused validation tied to the commit under review;
- protected qualification and full E2E evidence, or the missing gate; and
- credential, recovery, cleanup, and ownership obligations.
