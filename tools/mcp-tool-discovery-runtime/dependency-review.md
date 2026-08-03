<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# MCP tool discovery runtime dependency review

The shared image runtime uses the official `@modelcontextprotocol/sdk` client so all NemoClaw agent images follow the same Streamable HTTP initialization, protocol-version, session, SSE, pagination, and cleanup behavior. It is not an agent adapter and never invokes a discovered tool.

## Reviewed pin

- Package: `@modelcontextprotocol/sdk@1.30.0`
- Registry tarball: `https://registry.npmjs.org/@modelcontextprotocol/sdk/-/sdk-1.30.0.tgz`
- Integrity: `sha512-xKd8OIzlqNzcqcNumGAa6g+PW2kjD5vrpcKOnfldAUPP3j7lnqMPwlTXQm8gF+UwH72z0lqaRbjr9hqGz0eITA==`
- License: MIT
- Locked production graph: `package-lock.json` (lockfile version 3)
- Build-only tools: `typescript@6.0.3`, `@types/node@25.5.2`, and `esbuild@0.27.4` (not copied into the final image)
- Security overrides: `@hono/node-server@2.0.11`, `fast-uri@3.1.5`,
  `hono@4.12.34`, and `ip-address@10.3.1`

OpenClaw's `mcporter` dependency graph also resolves the official SDK but remains separately locked. This runtime keeps a direct lock because Hermes and LangChain Deep Agents Code must not depend on OpenClaw's adapter package.
The client bundle includes the SDK's AJV validation path, including `ajv-formats` and `fast-uri`, plus `content-type` for standards-compliant response media-type parsing; the `fast-uri` override and `content-type` license are therefore runtime-relevant. It does not include the SDK's Hono server adapter, `hono`, or `ip-address`. The build enforces the exact reviewed bundle-package allowlist and emits `BUNDLED_PACKAGES.json` alongside the generated third-party license notice. The exact overrides keep the install and runtime graphs clear of the reviewed advisories without changing the SDK client pin.

## August 3, 2026 Security Override Refresh

The refresh retains `@hono/node-server@2.0.11` and replaces three affected
transitive versions in the committed production graph.
The retained Hono server override keeps the graph clear of
`GHSA-frvp-7c67-39w9`.
The SDK declares `hono@^4.11.4`, its `express-rate-limit@8.5.2` graph declares
`ip-address@^10.2.0`, and its AJV graph declares `fast-uri@^3.0.1`.
`fast-uri@3.1.4` is affected by `GHSA-7p8r-x3mc-p8w7`.
The `3.1.5` replacement is outside that affected range and remains outside the
affected range for `GHSA-v2hh-gcrm-f6hx`.
`hono@4.12.30` is affected by `GHSA-8j4g-w8fx-2239`.
The `4.12.34` replacement is outside the affected range.
`ip-address@10.2.0` is affected by `GHSA-mwp4-54f8-5fhr`, and its replacement
also contains the corrections for `GHSA-4xrf-jv44-h6hh` and
`GHSA-22jq-vg5j-6vgg`.

The reviewed override identities are:

- `@hono/node-server@2.0.11`
  - Registry tarball: `https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.11.tgz`
  - Integrity: `sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==`
  - License: MIT
  - Node.js engine: `>=20`
- `fast-uri@3.1.5`
  - Registry tarball: `https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz`
  - Integrity: `sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==`
  - License: BSD-3-Clause
  - Node.js engine: no package `engines` declaration
- `hono@4.12.34`
  - Registry tarball: `https://registry.npmjs.org/hono/-/hono-4.12.34.tgz`
  - Integrity: `sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==`
  - License: MIT
  - Node.js engine: `>=16.9.0`
- `ip-address@10.3.1`
  - Registry tarball: `https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz`
  - Integrity: `sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==`
  - License: MIT
  - Node.js engine: `>= 12`

The `fast-uri` replacement remains in the executable bundle.
The `hono` and `ip-address` replacements remain install-graph inputs only, and
the exact bundle allowlist excludes them from the executable bundle.
The `@hono/node-server@2.0.11` override remains separate from the
`hono@4.12.34` override and preserves the reviewed SDK server-range boundary.

## 1.29.0 to 1.30.0 migration review

The audited adjacent range contains 10 upstream commits. The published `1.30.0` tag resolves to commit `2d889f2b329e46680ec9bdd565de4616c497825a`, descends from the published `v1.29.0` tag at `e12cbd7078db388152f6e839abdbe09ba01f3f32`, and contains the required client media-type fix at `69749aa5081ddfe675d36da8d96c7e27d83742b8`. The npm publication's `gitHead` matches the target tag, and its registry signature and build provenance verify.

The required client change replaces case-sensitive substring checks with parsed, normalized media types when selecting JSON or SSE response handling. This fixes standards-valid case variants such as `Text/Event-Stream; Charset=UTF-8`. The remaining commits affect SDK server error formatting, server SSE keepalive lifecycle, stdio buffering, upstream tests and workflows, Zod type compatibility, the server-only Hono version range, and the release version. NemoClaw's bundled client does not include the server or stdio implementations, and the committed `@hono/node-server` override remains `2.0.11`.

Concern ledger:

- `MCP-SDK-130-1` — Client response dispatch rejected case-variant SSE media types. Surface: managed MCP tool discovery initialization and `tools/list`. Resolution: migrate to the official parsed-media-type implementation and cover the full session with a case-variant SSE fixture. Validation: `npm test`.
- `MCP-SDK-130-2` — `content-type@1.0.5` becomes executable bundle input. Surface: response media-type parsing and bundled notices. Resolution: add it to the exact bundle allowlist and verify its MIT text in the generated notice. Validation: `npm run bundle`.
- `MCP-SDK-130-3` — The upstream package widens its Hono server range. Surface: resolved install graph only; the Hono server adapter is absent from the client bundle. Resolution: retain the existing exact `@hono/node-server@2.0.11` security override. Validation: the lock diff and `BUNDLED_PACKAGES.json`.
- `MCP-SDK-130-4` — Other adjacent commits could alter unrelated transports or server behavior. Surface: upstream stdio and server entry points. Resolution: no migration because NemoClaw imports only `client/index.js` and `client/streamableHttp.js`; classify those commits as no runtime impact. Validation: esbuild's exact input graph.

## Build and audit contract

Every agent image installs this committed graph with `npm ci --ignore-scripts` through the same reviewed installer, verifies registry signatures, typechecks the package against the real SDK types, and produces a single Node.js ESM bundle. Only that bundle, its checked package manifest, and a deterministic notice containing the license text for every package in esbuild's actual input graph are copied into the final image; the build dependency tree is discarded with the builder stage. This preserves the official SDK implementation and its license obligations while avoiding a large production layer composed of thousands of small package files.
The installer applies the existing public corporate CA build argument to npm TLS when present.
The root CLI TypeScript project excludes only this dependency-owning image entry point; the image package's dedicated `tsconfig.json` is the source-of-truth type gate, while the dependency-free core remains covered by the root project and host tests.
The image build requires a clean low-severity production advisory audit, verified npm registry signatures, the case-variant SSE session test, a root-owned non-writable bundled runtime, and an executable invalid-input contract check before the image can complete.

Review evidence on 2026-07-14:

- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities
- Pre-build `npm audit signatures`: 98 packages with verified registry signatures and 10 packages with verified attestations

Replacement-port refresh evidence on 2026-07-26:

- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities
- Pre-build `npm audit signatures`: 98 packages with verified registry signatures and 11 packages with verified attestations
- Exact bundle: 10 packages matching the reviewed allowlist in `BUNDLED_PACKAGES.json`

SDK 1.30.0 migration evidence on 2026-07-28:

- `npm test`: case-variant SSE discovery passed, including initialization, session propagation, `tools/list`, and session cleanup
- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities
- Pre-build `npm audit signatures`: 98 packages with verified registry signatures and 11 packages with verified attestations
- Exact bundle: 11 packages matching the reviewed allowlist in `BUNDLED_PACKAGES.json`, including `content-type@1.0.5`
- `npm run typecheck` and `npm run bundle`: passed

Transitive security refresh evidence on August 3, 2026, under Node.js `22.23.1`
and npm `10.9.4`:

- `npm audit signatures`: 98 packages with verified registry signatures and 12 packages with verified attestations
- `npm test`, `npm run typecheck`, and `npm run bundle`: passed
- Exact bundle: 11 packages matching the reviewed allowlist in `BUNDLED_PACKAGES.json`
- `npm audit --omit=dev --audit-level=low`: 0 vulnerabilities

## Updating

Regenerate and review the graph explicitly:

```console
$ npm --prefix tools/mcp-tool-discovery-runtime install --package-lock-only --ignore-scripts
$ npm --prefix tools/mcp-tool-discovery-runtime ci --ignore-scripts
$ npm --prefix tools/mcp-tool-discovery-runtime audit signatures
$ npm --prefix tools/mcp-tool-discovery-runtime test
$ npm --prefix tools/mcp-tool-discovery-runtime run typecheck
$ npm --prefix tools/mcp-tool-discovery-runtime run bundle
$ npm --prefix tools/mcp-tool-discovery-runtime audit --omit=dev --audit-level=low
```

Update this review, the exact package pin, and the committed lock together. Do not replace the lock with a floating install or reuse an agent-specific dependency tree.
Keep each exact security override until a reviewed `@modelcontextprotocol/sdk`
release resolves a version outside the corresponding affected range.
Remove an override only after regenerating the committed lock and passing the
registry-signature, package test, typecheck, exact bundle, and low-threshold
production audit checks.
