---
name: nemoclaw-contributor-update-hermes
description: Audit and deliver a Hermes dependency upgrade in NVIDIA/NemoClaw. Use when changing the selected Hermes release, reviewing a Hermes release, publishing a Hermes base image, or validating Hermes-specific configuration, compatibility, state, packaging, and runtime contracts. Trigger keywords - update Hermes, upgrade Hermes, Hermes release, Hermes version, Hermes base image.
---

<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Update Hermes

Compose this skill with
[`nemoclaw-contributor-update-dependencies`](../nemoclaw-contributor-update-dependencies/SKILL.md).
Use that skill for the release ledger, concern ledger, dependency graph, artifact audit, and
generic migration gates. This skill adds Hermes-specific priorities.

## Mutation boundary

Change only the NVIDIA/NemoClaw checkout in scope. Treat Hermes source, releases, registries, and
producer workflows as read-only. Do not change installer-managed copies or rebuild a
NemoClaw-managed sandbox without explicit user approval.

## Discover the current Hermes integration

Follow [Discover the Current Implementation](../_shared/implementation-discovery.md).

Start from the active Hermes identity in the current checkout. Search that identity and current
Hermes symbols to locate selectors, update tooling, manifests, image builds, compatibility code,
state declarations, workflows, tests, and documentation. Do not use a maintained prose map of
those files.

Use current upstream release metadata and source to determine the version scheme, package
identity, published artifacts, and adjacent release ranges. Do not assume that the generic
dependency collector recognizes every upstream tag form.

The skill includes a Hermes release supplement for tag forms that need additional collection.
Inspect its current help, tests, and applicability before use. Run trusted-base helper bytes when
the output is provenance evidence. A helper changed by the upgrade can be forward-tested, but its
output is not independent evidence for that change.

## Prioritize Hermes contracts

Open concerns for changed behavior in these areas when the current implementation uses them:

- configuration defaults, migrations, profiles, and failure behavior;
- wrappers, argument handling, patches, and other downstream workarounds;
- credentials, inference routing, network access, and output redaction;
- durable state, backup, restore, rebuild, rollback, and cross-identity access;
- direct and transitive packages, licenses, notices, advisories, and native builds;
- image construction, publication, immutable selection, and supported platforms;
- gateway, messaging, tools, sessions, and other runtime behavior.

Derive the concrete surfaces from current code and upstream changes. Remove a workaround only when
its behavior, removal condition, and tests are clear from the current checkout and target source.

## Implement and verify

Use current repository-owned update tooling with an explicit reviewed target. Inspect the tool's
current interface instead of copying its arguments here. Keep host-visible update or rebuild modes
outside ordinary checkout-only PR work unless the user approves them.

Implement semantic migrations before accepting new active selectors. Run the focused tests and
build checks discovered from the changed code. Add runtime evidence for changes to credentials,
network behavior, messaging, processes, persistence, rebuild, rollback, or cleanup.

When the release requires a published base image:

1. Commit and push the source and compatibility changes.
2. Check for conflicting publication work before dispatch.
3. Bind the publication run to the intended source commit.
4. Verify the required platforms and resolve the immutable image identity.
5. Pin that identity in the current production selector.
6. Rebuild and inspect the final image from the pinned artifact.

Repeat publication when an input to the image changes. Do not use a moving image tag or a run for
another commit as evidence.

## Complete the PR

Use
[`nemoclaw-contributor-create-pr`](../nemoclaw-contributor-create-pr/SKILL.md)
for PR preparation and follow-up.

The PR must separate source migration, artifact publication, local tests, runtime evidence, CI,
automated review, E2E, and remaining external gates. Bind all evidence to the applicable source or
PR commit and immutable artifact.
