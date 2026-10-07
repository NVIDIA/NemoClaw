<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Release Notes

These notes describe the v1 development documentation and its release boundaries.
v1 has no release yet; [#12638](https://github.com/NVIDIA/NemoClaw/issues/12638) tracks the first one.
The workspace package version alone does not establish that a release has been published.

## Product Changes

The development branch provides desired-state YAML, a Rust SDK, the `onboard`/`plan`/`apply`/`export`/`destroy` CLI, and a bundled OpenTofu provider.
See [the overview](overview.md) for implemented boundaries and [the CLI reference](reference/cli.md) for commands.

## Breaking Changes and Migration

Earlier CLI commands, schemas, and state formats have no compatibility guarantees.
See [migration](migration.md) for where each earlier task lives now, and [state](state.md) for data preservation.

## Qualification and Known Issues

See [current limits](limits.md) for what v1 does not do yet or has not tested, with the issue tracking each.

## Previous Releases

The combined staging site's **Latest (main)** version retains the imported main guides and changelog.
Use [earlier documentation](migration.md#find-earlier-documentation) to select that version; its release entries are not v1 release notes.
