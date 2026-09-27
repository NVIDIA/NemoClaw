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
