<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw MCP Runtime Dependency Review

This file records the reviewed `mcporter` baseline installed in the OpenClaw sandbox image.
Update it and `agents/openclaw/mcporter-runtime/package*.json` together whenever `MCPORTER_VERSION`, its integrity value, a manifest override, or the locked graph changes in `Dockerfile.base` or `Dockerfile`.

- Package: `mcporter@0.7.3`
- Purpose: in-sandbox OpenClaw MCP configuration and client adapter; it is not a host bridge, proxy, relay, or listener.
- Registry source: `https://registry.npmjs.org/mcporter/-/mcporter-0.7.3.tgz`
- Repository: `https://github.com/steipete/mcporter`
- License: `MIT`, from the npm registry package metadata.
- npm integrity: `sha512-egoPVYqTnWb3NjRIxo+xc8OrAI0dlPrJm9pAiZx0pImuNIV5rKhGtTnIfH/Y1ldGPVu74ibj3KR5c9U/QSdQFA==`
- Registry metadata independently queried from npm: 2026-06-30.
- Locked graph: `agents/openclaw/mcporter-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration command: `npm --prefix agents/openclaw/mcporter-runtime install --package-lock-only --ignore-scripts --omit=dev`
- Advisory command: `npm --prefix agents/openclaw/mcporter-runtime ci --ignore-scripts --omit=dev && npm --prefix agents/openclaw/mcporter-runtime audit --omit=dev --audit-level=low && npm --prefix agents/openclaw/mcporter-runtime audit signatures`
- Advisory review date: 2026-07-21.
- Advisory result: `0` known vulnerabilities across the resolved production dependency graph; npm verified registry signatures for all `120` resolved packages and attestations for `13` packages.
- Security override: `@hono/node-server@2.0.11` (`sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==`) replaces the SDK's vulnerable `1.19.14` resolution for `GHSA-frvp-7c67-39w9` and the previously reviewed `2.0.5` resolution affected by `GHSA-9mqv-5hh9-4cgg`. `2.0.5` is the first patched release for `GHSA-frvp-7c67-39w9`. The reviewed v2 range retains the `getRequestListener` API used by `@modelcontextprotocol/sdk`; its Node.js 20 floor is below NemoClaw's Node.js 22.19 floor, and the `/vercel` adapter is not consumed. Mcporter's production path imports the SDK's client transport, not the server adapter, and the image build still exercises the installed CLI after the locked install. Remove the override when the SDK's declared range resolves to a reviewed release outside both affected ranges.
- Security override: `fast-uri@3.1.4` (`sha512-8JnbkQ4juDyvYs4mgFGQqg4yCYtFDtUtmp2QIQq11ZZe5CFQ5wcqm1rqDgAh/QdMySuBnPzMUiJUNZG5N/AiQw==`) replaces Ajv's vulnerable `3.1.3` resolution for `GHSA-v2hh-gcrm-f6hx`. It remains within Ajv's declared `^3.0.1` range and preserves the reviewed v3 API boundary. Remove the override when the declared graph resolves to a reviewed patched release.

Both image paths install the committed graph with `npm ci --ignore-scripts --omit=dev` because the published package declares no install-time lifecycle script and NemoClaw needs only its already-built CLI.

## WeChat plugin runtime graph

- Package: `@tencent-weixin/openclaw-weixin@2.4.3`.
- Locked graph: `agents/openclaw/wechat-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration: `npm install --package-lock-only --legacy-peer-deps --ignore-scripts --omit=dev --prefix agents/openclaw/wechat-runtime`.
- Installation boundary: the image materializes the reviewed lock into a root-owned dedicated npm cache and adds the exact package metadata needed by npm's offline resolver. Before that cache becomes immutable, the shared `scripts/lib/reviewed-npm-archive.mts` implementation re-packs every locked archive offline from the final cache and rejects registry-origin drift, metadata or packed-byte SRI drift, unsafe filenames, missing archives, and symlinks. The sandbox user copies that verified immutable source into a writable cache used for registry metadata lookup, archive packing, and the OpenClaw plugin install; no retrieval step falls back to `HOME/.npm`. The copy is deleted in the same image layer, and the trusted cache is never writable. The installer runs in offline, legacy-peer mode, then `verify-wechat-runtime-lock.mts` rejects integrity, version, dependency-set, or peer-range drift and refuses an image OpenClaw version below the plugin's locked peer minimum.
- Default CI gate: `wechat-runtime-audit` in `.github/workflows/pr.yaml` and `.github/workflows/main.yaml` invokes the reviewed `.github/actions/ci-wechat-runtime-audit` implementation. Pull requests resolve it from the base SHA. Because PR #6739's base predates the action, that PR alone may bootstrap the action from signed immutable commit `HOYALIM/NemoClaw@0d2256d71d5bbba3bcaaaa4d01714fa56f22d1e2`; every other PR fails closed if its base lacks the action. Main uses the merged action. The action uses Node `22.19.0` and npm `10.9.4`, materializes the committed graph with scripts disabled, fails on any low-or-higher production advisory, verifies registry signatures, uploads the JSON/text reports, and exercises the exact reviewed archive through a copied writable cache while the trusted source remains read-only. Removal condition: delete the PR #6739 bootstrap checkout, its paired conditional audit step, and the bootstrap-specific test assertions in the first follow-up after this PR merges, before the next release tag; all later PRs must use the normal base-SHA action path.
- Advisory command: `npm ci --ignore-scripts --omit=dev --legacy-peer-deps --prefix agents/openclaw/wechat-runtime && npm audit --omit=dev --audit-level=low --json --prefix agents/openclaw/wechat-runtime && npm audit signatures --prefix agents/openclaw/wechat-runtime`.
- Advisory review: `2026-07-12`; result: `0` known vulnerabilities across the resolved production graph.
- Regression tests: `test/wechat-locked-install.test.ts` keeps the manifest runtime-lock paths and installer verification dispatch synchronized; `test/verify-wechat-runtime-lock.test.ts` proves the installed graph and OpenClaw peer-range compatibility fail closed; `test/wechat-runtime-audit-workflow.test.ts` keeps the Docker cache lifecycle, base-trusted required CI gate, evidence upload, audit threshold, signature verification, and real npm-pack boundary synchronized.

The dedicated graph intentionally omits the plugin's `openclaw` peer dependency. The image already installs and integrity-verifies the reviewed OpenClaw runtime separately; auto-installing another OpenClaw copy would create a second unreviewed runtime graph.
Disabling scripts also prevents transitive packages from executing lifecycle code during the trusted image build.
The lock records the exact version, registry URL, and integrity for every transitive package; the top-level registry integrity check remains an independent control.

## Source-of-Truth Boundary

- `invalidState`: the image installs a package graph, tarball, license, or advisory state that differs from the independently queried npm registry records for `mcporter@0.7.3`, resolves `@hono/node-server` to any version other than exact `2.0.11`, or resolves `fast-uri` to any version other than exact `3.1.4`.
- `sourceBoundary`: npm owns registry metadata, tarball integrity, provenance signatures, and advisory responses; NemoClaw owns the exact lock, script-disabled install, Docker integrity assertion, and review record.
- `whyNotSourceFix`: a repository note cannot make external registry state trustworthy, so image builds execute `npm audit` and `npm audit signatures` against the locked production graph and reviewers compare the lock with the registry response.
- `regressionTest`: `test/mcporter-supply-chain.test.ts` keeps the version, integrity, lock metadata, Docker install flags, audit commands, and this review synchronized.
- `removalCondition`: remove this runtime dependency and review when OpenClaw provides the required authenticated Streamable HTTP client lifecycle without mcporter, or repeat the independent review for a newly pinned version.
