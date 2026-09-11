<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Working on the desired-state prototype

This checkout is an independent Go prototype. Read `DESIGN.md` for its scope and
`README.md` for build and test commands. Keep work local unless the user authorizes
publication.

## Go coding guidance

Use [JetBrains Modern Go Guidelines](https://github.com/JetBrains/go-modern-guidelines)
for all Go work. The upstream skill and versioned wrappers are available locally
at [.agents/skills/use-modern-go/SKILL.md](.agents/skills/use-modern-go/SKILL.md).
Read and follow that skill before writing or editing Go code.

Run its complete `list` output for the relevant file or the version in `go.mod`.
Use `explain` for applicable guidelines that need more context. Prefer the modern
language and standard-library idioms supported by that version. Preserve behavior
and public data formats; the upstream guidance requires an explicit request before
migrating existing JSON v1 code.

The guidance tool is a development dependency. Its wrapper installs a pinned CLI
in the user's cache; it does not enter `go.mod` or the product bundle. Upstream
revision and license information are recorded in the skill's `UPSTREAM.md`.

## Validation

Run `gofmt`, focused tests, and `go vet` for changes. Rebuild the native bundle
before integration tests that execute its provider or osquery extension.
Keep native runtime evidence distinct from cross-compilation. Live tests create
real resources and require the explicit environment settings in `LOCAL_TEST.md`.
