<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# MCP tool discovery runtime dependency review

The shared image runtime uses the official `@modelcontextprotocol/sdk` client so all NemoClaw agent images follow the same Streamable HTTP initialization, protocol-version, session, SSE, pagination, and cleanup behavior. It is not an agent adapter and never invokes a discovered tool.

## Reviewed pin

- Package: `@modelcontextprotocol/sdk@1.29.0`
- Registry tarball: `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.29.0.tgz`
- Integrity: `sha512-zo37mZA9hJWpULgkRpowewez1y6ML5GsXJPY8FI0tBBCd77HEvza4jDqRKOXgHNn867PVGCyTdzqpz0izu5ZjQ==`
- License: MIT
- Locked production graph: `package-lock.json` (lockfile version 3)
- Build-only tools: `typescript@6.0.3`, `@types/node@25.5.2`, and `esbuild@0.27.4` (not copied into the final image)
- Security overrides: `@hono/node-server@2.0.11` and `fast-uri@3.1.4`

The same SDK version and integrity are already present in the separately locked OpenClaw `mcporter` dependency graph. This runtime keeps a direct lock because Hermes and LangChain Deep Agents Code must not depend on OpenClaw's adapter package.
The client bundle includes the SDK's AJV validation path, including `ajv-formats` and `fast-uri`; the `fast-uri` override is therefore runtime-relevant. It does not include the SDK's Hono server adapter. The build enforces the exact reviewed bundle-package allowlist and emits `BUNDLED_PACKAGES.json` alongside the generated third-party license notice. The exact overrides keep the install and runtime graphs clear of `GHSA-frvp-7c67-39w9` and `GHSA-v2hh-gcrm-f6hx` without changing the SDK client pin.

## Build and audit contract

Every agent image installs this committed graph with `npm ci --ignore-scripts` through the same reviewed installer, verifies registry signatures, typechecks the package against the real SDK types, and produces a single Node.js ESM bundle. Only that bundle, its checked package manifest, and a deterministic notice containing the license text for every package in esbuild's actual input graph are copied into the final image; the build dependency tree is discarded with the builder stage. This preserves the official SDK implementation and its license obligations while avoiding a large production layer composed of thousands of small package files.
The installer applies the existing public corporate CA build argument to npm TLS when present.
The root CLI TypeScript project excludes only this dependency-owning image entry point; the image package's dedicated `tsconfig.json` is the source-of-truth type gate, while the dependency-free core remains covered by the root project and host tests.
The image build requires a clean low-severity production advisory audit, verified npm registry signatures, a root-owned non-writable bundled runtime, and an executable invalid-input contract check before the image can complete.

Review evidence on 2026-07-14:

- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities
- Pre-build `npm audit signatures`: 98 packages with verified registry signatures and 10 packages with verified attestations

Replacement-port refresh evidence on 2026-07-26:

- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities
- Pre-build `npm audit signatures`: 98 packages with verified registry signatures and 11 packages with verified attestations
- Exact bundle: 10 packages matching the reviewed allowlist in `BUNDLED_PACKAGES.json`

## Updating

Regenerate and review the graph explicitly:

```console
$ npm --prefix tools/mcp-tool-discovery-runtime install --package-lock-only --ignore-scripts
$ npm --prefix tools/mcp-tool-discovery-runtime ci --ignore-scripts
$ npm --prefix tools/mcp-tool-discovery-runtime audit signatures
$ npm --prefix tools/mcp-tool-discovery-runtime run typecheck
$ npm --prefix tools/mcp-tool-discovery-runtime run bundle
$ npm --prefix tools/mcp-tool-discovery-runtime audit --omit=dev --audit-level=low
```

Update this review, the exact package pin, and the committed lock together. Do not replace the lock with a floating install or reuse an agent-specific dependency tree.
