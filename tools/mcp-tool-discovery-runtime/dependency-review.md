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
- Security overrides:
  - `@hono/node-server@2.0.12`: `sha512-eWpQYr67tqJLeaSUl0Q+TquuYfUdTibpOJlUMV2FfUP7+KqCC5TufnwnlXL6mobZBJbGAYRd7ZvEBDCbLInjhg==`
  - `fast-uri@3.1.6`: `sha512-7Ical1vFEMr0onbVzEDIreM22I4khW+fzyQPwvAFWBp1iwdshSZRsL4jjRvPG9JP1uiqMHRto+YU6R2/CzDz5Q==`
  - `hono@4.12.34`: `sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==`
  - `ip-address@10.3.1`: `sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==`

OpenClaw's `mcporter` dependency graph also resolves the official SDK but remains separately locked. This runtime keeps a direct lock because Hermes and LangChain Deep Agents Code must not depend on OpenClaw's adapter package.
The client bundle includes the SDK's AJV validation path, including `ajv-formats` and `fast-uri`, plus `content-type` for standards-compliant response media-type parsing. The `fast-uri` override and `content-type` license are therefore runtime-relevant. The bundle does not include the SDK's Hono server adapter or its `hono` and `ip-address` dependencies, but those packages remain part of the installed production graph that the reviewed npm audit CI check evaluates. The build enforces the exact reviewed bundle-package allowlist and emits `BUNDLED_PACKAGES.json` alongside the generated third-party license notice. The exact overrides keep the installed graph outside the affected ranges for `GHSA-7p8r-x3mc-p8w7`, `GHSA-8j4g-w8fx-2239`, `GHSA-mwp4-54f8-5fhr`, `GHSA-4xrf-jv44-h6hh`, and `GHSA-22jq-vg5j-6vgg` without changing the SDK client pin.

## 2026-08-03 security refresh

The NemoClaw `v0.0.100` sandbox image build stopped before creating an image because the committed runtime lock resolved three packages in newly reported advisory ranges.
NemoClaw `main` at `3f3eb6139e089c24397d6a499a10fcde4bdc84da` reproduced the same failure.
At that revision, the image-build audit boundary worked as designed.
Issue #8177 records the source, build run, failure receipt, and resume condition.

Registry metadata binds each audited range:

- `fast-uri`: `3.1.4` at `6aeece669e4166b2446a89f17c07a3b15dfb7ed4` to `3.1.6` at `6f970b2951fd896aa0f3a7ff28eeb6640c137d33`, two patch releases
- Hono: `4.12.30` at `b2ae3a2204a48ce15a26448fd746d39745eb1837` to `4.12.34` at `734755ace341607628219ea1dd8ca17f01bf1a5c`, four patch releases
- `ip-address`: `10.2.0` at `80fccaae984618f35dc941efab55cf2440ab37e8` to `10.3.1` at `be7e626c0d49fccb518899f520a3fb64ee189741`, four release increments that cross the `10.3.0` minor boundary

Each target commit descends from its outgoing commit. The target npm package integrities match the committed lock.

Concern ledger:

- `MCP-AUDIT-1` — earlier `fast-uri` 3.x releases accept malformed authority, IPv6, repeated percent-decoding, or encoded-scheme inputs that can produce host confusion or SSRF (`GHSA-5jgf-p345-68v8`, `GHSA-f65p-4m7j-42xc`, `GHSA-fph4-wmhf-6fwf`, `GHSA-jqff-g426-hqxp`). Surface: executable AJV format validation in the bundled client. Resolution: pin first-patched `fast-uri@3.1.6`, which remains within Ajv's declared range. Validation: exact lock metadata, `npm test`, bundle verification, and the production audit.
- `MCP-AUDIT-2` — `hono@4.12.30` uses a regular expression that can cause excessive work for a large CORS request-header value. Surface: installed SDK server dependency; excluded from the client bundle. Resolution: pin `hono@4.12.34`, which replaces the split expression and adds a regression test for a large request header. Validation: exact lock metadata, bundle-input exclusion, and the production audit.
- `MCP-AUDIT-3` — `ip-address@10.2.0` accepts address forms whose classification can differ across parsers. Surface: installed SDK server dependency; excluded from the client bundle. Resolution: pin `ip-address@10.3.1`, which rejects leading-zero IPv4 octets and stacked subnet suffixes and adds regression tests for IPv4 and IPv6 parsing. Validation: exact lock metadata, bundle-input exclusion, and the production audit.
- `MCP-AUDIT-4` — Live advisory and Sigstore TUF queries in the image build can prevent a released version from reproducing the same image after external metadata or network availability changes. Surface: `install-reviewed-runtime.sh`. Resolution: move both advisory enforcement and registry-signature verification for this exact lock to the trusted reviewed npm audit CI check. Image assembly copies the exact reviewed bundle and license outputs instead of materializing this npm graph, so protected rebuilds need neither registry access nor committed registry archives. Bundle regeneration remains fail-closed on the committed lock, its SHA-512 archive integrity, the runtime test, typecheck, and exact bundle-package allowlist. Validation: `test/mcp/mcp-tool-discovery-image-contract.test.ts` and `npm run bundle:reviewed:check`.

## 2026-08-05 build audit boundary update

Issue #8253 showed that image-build audits made sandbox creation depend on current registry and Sigstore TUF data instead of only the committed build inputs. Bundle regeneration uses the shared installer without live advisory or registry-signature queries. It installs the exact lock with lifecycle scripts disabled from integrity-pinned archives, runs the runtime tests and typecheck, and verifies the exact bundle inputs.

The reviewed npm audit CI check now owns production advisory enforcement for this lock. Its trusted action verifies the downloaded `npm@10.9.4` archive against the reviewed SHA-512 before installing it. The check verifies the lock SHA-256 and SDK package integrity, installs the production graph with lifecycle scripts disabled, records audit provenance and policy results, verifies registry signatures, and fails on unaccepted findings at the repository's configured threshold.

## 1.29.0 to 1.30.0 migration review

The audited adjacent range contains 10 upstream commits. The published `1.30.0` tag resolves to commit `2d889f2b329e46680ec9bdd565de4616c497825a`, descends from the published `v1.29.0` tag at `e12cbd7078db388152f6e839abdbe09ba01f3f32`, and contains the required client media-type fix at `69749aa5081ddfe675d36da8d96c7e27d83742b8`. The npm publication's `gitHead` matches the target tag, and its registry signature and build provenance verify.

The required client change replaces case-sensitive substring checks with parsed, normalized media types when selecting JSON or SSE response handling. This fixes standards-valid case variants such as `Text/Event-Stream; Charset=UTF-8`. The remaining commits affect SDK server error formatting, server SSE keepalive lifecycle, stdio buffering, upstream tests and workflows, Zod type compatibility, the server-only Hono version range, and the release version. NemoClaw's bundled client does not include the server or stdio implementations. The committed `@hono/node-server` override is `2.0.12`.

Concern ledger:

- `MCP-SDK-130-1`: Client response dispatch rejected case-variant SSE media types. Surface: managed MCP tool discovery initialization and `tools/list`. Resolution: migrate to the official parsed-media-type implementation and cover the full session with a case-variant SSE fixture. Validation: `npm test`.
- `MCP-SDK-130-2`: `content-type@1.0.5` becomes executable bundle input. Surface: response media-type parsing and bundled notices. Resolution: add it to the exact bundle allowlist and verify its MIT text in the generated notice. Validation: `npm run bundle`.
- `MCP-SDK-130-3`: The upstream package widens its Hono server range. Surface: resolved install graph only; the Hono server adapter is absent from the client bundle. Resolution: use the reviewed `@hono/node-server@2.0.12` patch release. Validation: the lock diff and `BUNDLED_PACKAGES.json`.
- `MCP-SDK-130-4`: Other adjacent commits could alter unrelated transports or server behavior. Surface: upstream stdio and server entry points. Resolution: no migration because NemoClaw imports only `client/index.js` and `client/streamableHttp.js`; classify those commits as no runtime impact. Validation: esbuild's exact input graph.

## `@hono/node-server` 2.0.12 review

Version `2.0.12` is the next patch release and remains within the SDK's declared `^1.19.9 || ^2.0.5` range. It keeps the MIT license, Node.js `>=20` engine, `hono@^4` peer dependency, package exports, and lack of install scripts.

The `v2.0.11..v2.0.12` source range contains three commits: a test transport replacement, a response-header fix for foreign `Response` objects, and the release commit. The server adapter remains outside NemoClaw's executable client bundle. The annotated tag and release commit are unsigned. During the 2026-08-03 security refresh, `npm audit signatures` verified the exact package's registry signature and Supply-chain Levels for Software Artifacts (SLSA) provenance against release commit `a813b6cdaa15baac3ead84e9e6ed5b72b2353c96`. Upstream Node.js 20, 22, and 24 checks, Windows checks, build checks, and the npm publication check passed.

The reviewed archive is `https://registry.npmjs.org/@hono/node-server/-/node-server-2.0.12.tgz` with integrity `sha512-eWpQYr67tqJLeaSUl0Q+TquuYfUdTibpOJlUMV2FfUP7+KqCC5TufnwnlXL6mobZBJbGAYRd7ZvEBDCbLInjhg==`. This patch keeps the fail-closed signature check and adds no exception.

## Build and audit contract

The repository commits the generated ESM bundle, its checked package manifest, its deterministic third-party notice, and the dependency-free managed-startup CommonJS bundle under `reviewed-runtime-bundle/`; it does not commit registry archives for this graph. Every agent image copies those exact artifacts through scratch stages and probes the executable invalid-input contract after the copy. The trusted reviewed npm audit CI gate independently installs and verifies the exact production lock, including registry signatures and advisory policy, before main or tag production image publication and mutable cohort promotion. `bundle:reviewed:check` regenerates all four artifacts with the reviewed esbuild version and rejects any byte or file-set drift. This preserves the official SDK implementation and its license obligations without an image-build npm install or a large production dependency layer.
The installer remains the reviewed regeneration path. It applies the existing public corporate CA build argument to npm TLS when present, uses IPv4-first DNS resolution, a four-socket registry connection budget, and bounded fetch timeouts. Its recovery path remains capped and fail-closed on ambiguous, unpinned, integrity-invalid, or non-network failures. The runtime test, typecheck, exact bundle-package allowlist, and byte-for-byte reviewed bundle check run before an artifact update is accepted, while the trusted reviewed npm audit CI gate owns exact-lock registry-signature verification.
The root CLI TypeScript project excludes only this dependency-owning image entry point; the image package's dedicated `tsconfig.json` is the source-of-truth type gate, while the dependency-free core remains covered by the root project and host tests.
The image build requires a root-owned non-writable bundled runtime and an executable invalid-input contract check before it can complete. The reviewed bundle regeneration requires lock-pinned archive integrity and the case-variant SSE session test. The reviewed npm audit CI check verifies registry signatures and separately evaluates the locked production graph against the repository's advisory policy. The production base-image publication workflow requires that check before base-image platform-digest uploads, mutable base-image tags, or managed-image promotion for the same commit.

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

Security refresh evidence on 2026-08-03:

- `npm ci --ignore-scripts`: installed the exact 98-package lock
- `npm audit signatures`: verified 98 registry signatures and 12 provenance attestations
- `npm test` and `npm run typecheck`: passed
- `npm run bundle`: emitted the same 11-package client bundle with `fast-uri@3.1.6`; `hono` and `ip-address` remain outside the executable bundle
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
$ npm --prefix tools/mcp-tool-discovery-runtime run bundle:reviewed
$ npm --prefix tools/mcp-tool-discovery-runtime run bundle:reviewed:check
$ npm --prefix tools/mcp-tool-discovery-runtime audit --omit=dev --audit-level=low
```

Update this review, the exact package pin, and the committed lock together. Do not replace the lock with a floating install or reuse an agent-specific dependency tree.
