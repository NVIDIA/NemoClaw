<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw MCP Runtime Dependency Review

This file records the reviewed `mcporter` baseline installed in the OpenClaw sandbox image.
Update it and `agents/openclaw/mcporter-runtime/package*.json` together whenever `MCPORTER_VERSION` or its integrity value changes in `Dockerfile.base` or `Dockerfile`.

- Package: `mcporter@0.7.3`
- Purpose: in-sandbox OpenClaw MCP configuration and client adapter; it is not a host bridge, proxy, relay, or listener.
- Registry source: `https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz`
- Repository: `https://github.com/steipete/mcporter`
- License: `MIT`, from the npm registry package metadata.
- npm integrity: `sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==`
- Registry metadata reviewed: 2026-06-27.
- Locked graph: `agents/openclaw/mcporter-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration command: `npm --prefix agents/openclaw/mcporter-runtime install --package-lock-only --ignore-scripts --omit=dev`
- Advisory command: `npm --prefix agents/openclaw/mcporter-runtime ci --ignore-scripts --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit signatures`
- Advisory review date: 2026-06-27.
- Advisory result: `0` known vulnerabilities across the resolved production dependency graph.

Both image paths install the committed graph with `npm ci --ignore-scripts --omit=dev` because the published package declares no install-time lifecycle script and NemoClaw needs only its already-built CLI.
Disabling scripts also prevents transitive packages from executing lifecycle code during the trusted image build.
The lock records the exact version, registry URL, and integrity for every transitive package; the top-level registry integrity check remains an independent control.
