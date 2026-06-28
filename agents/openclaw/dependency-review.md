<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw MCP Runtime Dependency Review

This file records the reviewed `mcporter` baseline installed in the OpenClaw sandbox image.
Update it whenever `MCPORTER_VERSION` or its integrity value changes in `Dockerfile.base` or `Dockerfile`.

- Package: `mcporter@0.7.3`
- Purpose: in-sandbox OpenClaw MCP configuration and client adapter; it is not a host bridge, proxy, relay, or listener.
- Registry source: `https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz`
- Repository: `https://github.com/steipete/mcporter`
- License: `MIT`, from the npm registry package metadata.
- npm integrity: `sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==`
- Registry metadata reviewed: 2026-06-27.
- Advisory command: `npm install --package-lock-only --ignore-scripts mcporter@0.7.3 && npm audit --omit=dev`
- Advisory review date: 2026-06-27.
- Advisory result: `0` known vulnerabilities across the resolved production dependency graph.

The image install uses `--ignore-scripts` because the published package declares no install-time lifecycle script and NemoClaw needs only its already-built CLI.
Disabling scripts also prevents transitive packages from executing lifecycle code during the trusted image build.
The exact version and registry integrity check remain mandatory; this review does not replace either control.
