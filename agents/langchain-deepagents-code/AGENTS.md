<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Deep Agents Code Integration

Use the shared dependency-upgrade workflow for version changes. This guide describes the maintained component boundaries, not a release checklist.

## Build and runtime ownership

`requirements.in` and `dependency-overrides.in` feed the hash-locked dependency graph in `requirements.lock`.
Read the lock's generation command before regenerating it. Resolve the graph on the supported Python version and target platform.
`Dockerfile.base` installs that graph, applies dependency compatibility changes, runs `pip check`, and checks the runtime contract.
The installed-package validator is `validate-runtime-contract.py`; host-side immutable-image validation lives in `scripts/checks/validate-dcode-runtime-contract.mts`.

`Dockerfile` consumes the base image and installs managed patches and the profile plugin.
Follow its actual COPY inputs and checksum checks when changing plugin sources or metadata.
Follow the base-image contract consumers when changing build inputs; version searches alone miss cache and overlay dependencies.

The launchers, wrapper, and supervisor own process startup, headless output, and resume behavior.
Inspect their consumers when upstream entrypoints or output formats change.
Existing-sandbox version and readiness checks live in the CLI; fresh-image validation does not qualify those paths.

Remove a managed patch only when the upstream implementation and its existing behavioral regression tests establish equivalent behavior.
Keep release-specific findings in task evidence and the owning tests.

## Validate before image qualification

Check the host prerequisites in [test guidance](../../test/README.md#macos-host-tools), including Python wheel-build packages.
From the repository root, run:

```sh
npm run test:changed -- --changed=origin/main
```

This includes integration tests and maps opaque build inputs through `test/helpers/vitest-watch-triggers.ts`.
Review its selected tests and unmapped inputs. Extend the existing mappings for a newly discovered opaque dependency.
Use Vitest's import graph for TypeScript consumers instead of duplicating path inventories.
The selected existing tests cover lock/selector agreement, patch behavior, profile-plugin checksums, image contracts, and headless consumers where those inputs changed.

These tests do not install the target wheel or qualify a real sandbox.
Validate the resolved target dependency graph and changed consumers against the actual artifact before expensive qualification.
Use the existing image validator on an authorized cached immutable image when installed-runtime evidence is required:

```sh
node scripts/checks/validate-dcode-runtime-contract.mts --reference '<image@sha256:digest>' --platform linux/amd64
```

That validator uses a read-only container without network access; Docker and the selected image must already be available.
Use the current supported architecture for the artifact. Keep existing-sandbox and live lifecycle qualification separate.
