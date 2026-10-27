<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell SDK archive

This directory carries the reviewed `@nvidia/openshell-sdk@0.0.116` package under its upstream Apache-2.0 license.
The archive matches the GitHub Packages URL and SHA-512 integrity in the root `package-lock.json`.
Its source is NVIDIA/OpenShell tag `v0.0.116`, commit `d1155aa70042d3e2ee49dbfa15346b108b7c1d92`.
The included `LICENSE` is copied from that source.

The installer and `npm run dev:setup` verify this archive, seed npm's cache offline, and run the normal dependency installation.
Users do not need GitHub credentials or an SDK build toolchain.
The SDK is required by these installation workflows. Setup stops if verification, installation, or either public SDK import fails.
`npm run dev:doctor` checks the installed SDK without installing it or contacting a gateway.

For a direct source dependency installation, run these commands from the checkout:

```bash
node scripts/lib/openshell-sdk-install.mts prepare
npm ci --ignore-scripts --prefer-offline --include=optional --@nvidia:registry=https://npm.pkg.github.com
node scripts/lib/openshell-sdk-install.mts check
```

Public npm dependencies still require registry access unless they are cached.
The archive does not contain credentials or an npm configuration file.
npm metadata retains the optional dependency for isolated CI jobs that do not use the SDK; installers explicitly include it and verify both imports.
The command-scoped registry setting lets npm 12 recognize the locked SDK URL without changing user configuration.
Existing CI continues to verify the same registry identity and integrity through its reviewed dependency pipeline.

When upgrading the SDK, obtain the reviewed registry archive and replace `nvidia-openshell-sdk-<version>.tgz` alongside the manifest, lockfile, and reviewed dependency pins.
Do not substitute a locally repacked archive: its compressed bytes can differ from the reviewed checksum.
Run the SDK installation package contract after each update.
Remove this archive and cache preparation when the pinned SDK is available through the public npm registry.

## Trusted E2E Setup

The production SDK remains `0.0.116`; `ci/reviewed-npm-audit.json` also admits `0.1.5` as the reviewed replacement for the OpenShell upgrade.
When compiling the candidate CLI and plugin, the E2E planner requires successful SDK packaging, downloads that run's archive bundle, and uses explicit artifact mode.
Explicit candidate dispatches that select only `llama-cpp-dgx-spark-qualification` or `native-runtime-qualification-producer`, with no target selector, skip SDK packaging and candidate compilation.
Those dispatches use their trusted producer plans.
All other planner paths stop if SDK packaging fails, is cancelled, or is unexpectedly skipped.

The `prepare-e2e` action defaults both `install-dependencies` and `build-cli` to `true`.
Jobs that prepare a candidate checkout set both inputs to `false` to prepare Node.js and npm without installing dependencies or building the CLI.
They download the reviewed archive before calling `install-reviewed-openshell-sdk` once to verify and install dependencies.
Trusted Spark preparation retains the default installation and build behavior.
The protected runtime controller first installs dependencies from the trusted workflow checkout, then installs the reviewed SDK after projecting candidate OpenShell versions.

Dependency preparation selects the archive from the candidate lockfile and verifies its registry identity and SHA-512 integrity against the trusted policy before installation.
Downstream SDK installation actions must use an immutable commit pin whose trusted policy includes the same reviewed replacement.
Package credentials remain confined to the producer's download step, and dependency installation keeps npm lifecycle scripts disabled.
