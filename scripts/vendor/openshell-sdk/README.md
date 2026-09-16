<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenShell SDK installation archive

This directory ships the OpenShell JavaScript SDK used by NemoClaw.
The upstream package uses the Apache-2.0 license.
It is separate from the OpenShell CLI and gateway binaries.

`scripts/lib/install-openshell-sdk.mts` verifies the archive against the root lockfile before installation.
This permits installation without GitHub package credentials or an expiring CI artifact.
When the SDK pin changes, replace the archive with the same package verified by `ci/reviewed-npm-audit.json`.
Run `test/installer-integration/install-openshell-sdk.test.ts` to verify installation and import behavior.
