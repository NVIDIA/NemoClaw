<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Notes

These notes describe the v1 development documentation and its release boundaries.
A release version, date, artifact manifest, and approved support matrix: **TBD**.
The workspace package version alone does not establish that a release has been published.

## Product Changes

The development branch provides desired-state YAML, a Rust SDK, the `plan`/`apply`/`export`/`destroy` CLI, and a bundled OpenTofu provider.
See [the overview](overview.md) for implemented boundaries and [the CLI reference](reference/cli.md) for commands.

Final changes tied to a release tag and matching artifacts: **TBD**.

## Breaking Changes and Migration

Earlier CLI commands, schemas, and state formats do not have general compatibility guarantees.
Use [migration](migration.md) to assess current limits and [state](state.md) to understand data preservation.

| Earlier workflow | v1 development boundary |
|---|---|
| npm installer, interactive onboarding, and agent-specific aliases | Source-built native bundle and desired-state YAML; a published installation channel remains TBD |
| Imperative sandbox/inference changes | Plan/apply with retained identity and explicit replacement restrictions |
| TypeScript lifecycle package | Rust SDK; no compatible TypeScript replacement promised |
| Export as part of a backup/restore workflow | Configuration export only; sandbox files/history need separate preservation |
| Automatic reuse of earlier state or native data | No general adoption or migration; evaluate a separate deployment |
| Managed channels, MCP, arbitrary plugins, and legacy inference installers | See the individual TBD entries in [migration](migration.md#map-the-user-task) |

Rehearsed release-specific migration and rollback instructions: **TBD**.

## Qualification and Known Issues

Current [validation records](validation/README.md) name their source revisions and tested environments.
They do not establish qualification of a future release candidate.

Release-candidate results, supported configurations, and reviewed known issues: **TBD**.

## Previous Releases

The combined staging site's **Latest (main)** version retains the imported main guides and changelog.
Use [earlier documentation](migration.md#find-earlier-documentation) to select that version; its release entries are not v1 release notes.
Public combined-site cutover and full hosted redirect verification: **TBD**.
The [migration inventory](design/documentation-migration-inventory.md#history-and-publication-inputs) identifies the earlier changelog sources to preserve.
