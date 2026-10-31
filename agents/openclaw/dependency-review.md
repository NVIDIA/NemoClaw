<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw Runtime Dependency Review

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
- Advisory command: `npm --prefix agents/openclaw/mcporter-runtime ci --ignore-scripts --omit=dev && node scripts/lib/reviewed-npm-audit.mts --directory agents/openclaw/mcporter-runtime --exceptions ci/npm-audit-exceptions.json --graph mcporter-runtime --threshold high && npm --prefix agents/openclaw/mcporter-runtime audit signatures --registry=https://registry.yarnpkg.com --omit=dev`
- Advisory review date: 2026-10-20.
- Advisory result: the updated production graph reports `4` moderate findings and no high or critical findings. All 121 installed package registry signatures verified; 16 packages have verified attestations.
- Security override: `@modelcontextprotocol/sdk@1.32.0` (`sha512-8BviX/hK4Gd2eL1KdTwm0gfl4d3wdoErW0Jd00h6nomUAtk6IJk5vwQJc6kfWtJTzN5OEV/lgIiJKI8fiDGAlA==`) replaces `1.31.0` for [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) and retains the earlier fix for [GHSA-6qxp-vccf-f47h](https://github.com/modelcontextprotocol/typescript-sdk/security/advisories/GHSA-6qxp-vccf-f47h). The replacement stays within mcporter's declared `^1.25.1` range and preserves the MIT license and Node.js `>=18` floor. Mcporter persists complete token and client-information objects, preserving the patched SDK's `issuer` field. Existing OAuth credentials saved without `issuer` require clearing and a new sign-in, as specified by the earlier advisory. Remove this override when the reviewed graph resolves to a patched SDK.
- SDK compatibility: `1.32.0` binds experimental tasks to their creating session and restricts HTTP redirects to the same origin by default. Mcporter uses the SDK's client transports; it does not configure a server task store. The managed discovery client already refuses redirects. OpenClaw, managed messaging, the reviewed archive audit, and the generated discovery bundle use the same SDK release.
- Security override: `@hono/node-server@2.0.11` (`sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==`) replaces the SDK's vulnerable `1.19.14` resolution for `GHSA-frvp-7c67-39w9` and the previously reviewed `2.0.5` resolution affected by `GHSA-9mqv-5hh9-4cgg`. `2.0.5` is the first patched release for `GHSA-frvp-7c67-39w9`. The reviewed v2 range retains the `getRequestListener` API used by `@modelcontextprotocol/sdk`; its Node.js 20 floor is below NemoClaw's Node.js 22.19 floor, and the `/vercel` adapter is not consumed. Mcporter's production path imports the SDK's client transport, not the server adapter, and the image build still exercises the installed CLI after the locked install. Remove the override when the SDK's declared range resolves to a reviewed release outside both affected ranges.
- Security override: `fast-uri@3.1.7` (`sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg==`) replaces Ajv's vulnerable resolution. [GHSA-58mr-gqgx-xq4g](https://github.com/advisories/GHSA-58mr-gqgx-xq4g) and [GHSA-qw65-cvwx-89v3](https://github.com/advisories/GHSA-qw65-cvwx-89v3) affect the previous `3.1.6` pin; `3.1.7` fixes both and retains the earlier 3.x security fixes. The replacement remains within Ajv's declared `^3.0.1` range and preserves the reviewed v3 API and BSD-3-Clause license. The CLI, OpenClaw, mcporter, MCP discovery bundle, legacy OpenClaw remediation, and weather fixture use this patch release. Remove the override when the declared graph resolves to a reviewed release outside all affected ranges.
- Security override: `hono@4.12.34` (`sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==`) replaces the SDK's vulnerable `4.12.27` resolution.
  `GHSA-8j4g-w8fx-2239`, `GHSA-54fx-42gc-7vw4`, `GHSA-f23p-vx2j-j53r`, and `GHSA-79qm-7rj5-m7r9` are fixed in `4.12.34`.
  The replacement remains within the SDK's declared `^4.11.4` range and preserves Hono's Node.js `>=16.9.0` contract.
  Before removing or advancing the override, review the replacement and update the exact-version source-of-truth boundary, lock digests, and regression tests together.
- Security override: `ip-address@10.3.1` (`sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==`) replaces `express-rate-limit`'s vulnerable `10.2.0` resolution. `GHSA-mwp4-54f8-5fhr` affects releases through `10.3.0`; the replacement remains within the declared `^10.2.0` range, adds the leading-zero IPv4 rejection and host-only subnet classification required for trust-boundary checks, and preserves Node `>= 12`. Remove the override when the declared graph resolves to a reviewed release outside the affected range.

Both image paths install the committed graph with `npm ci --ignore-scripts --omit=dev` because the published package declares no install-time lifecycle script and NemoClaw needs only its already-built CLI.
The reviewed audit wrapper reports lower-severity production findings and blocks unaccepted high or critical advisories. The default `ci/npm-audit-exceptions.json` registry is empty. Any future exception must match one advisory, graph, package, installed version, and severity; identify an owner and NemoClaw tracking issue; state a decision, rationale, and expiry no more than 30 days away; and include compensating controls for temporary risk acceptance. Missing, malformed, expired, overlong, mismatched, or unused exceptions fail closed. The repository-wide audit also rejects exceptions for unknown graph IDs. Registry signature verification remains a separate control.

## Managed messaging proxy address remediation

- Advisory: [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) affects `proxy-addr@2.0.7`; `2.0.8` contains the reviewed fix.
- Ordinary graph: `agents/openclaw/managed-image-messaging-runtime/package.json` overrides non-bundled `proxy-addr` resolutions to exact `2.0.8`. Its lock records npm integrity `sha512-5nnx0yGyVUcY6t9RnWcARWtwT9F1D8O9rt08htPvnd49W1IgZtmLkhu9WfMzQj1cFxjHIO6connUNVW5k7AVyQ==`, the unchanged `forwarded@0.2.0` and `ipaddr.js@1.9.1` dependencies, the MIT license, and the existing Node.js engine floor.
- Bundled Slack graph: the reviewed registry archive `@openclaw/slack@2026.9.2` bundles `@slack/bolt@5.0.0`, `express@5.2.1`, and `proxy-addr@2.0.7`. NemoClaw retains the exact official registry install and verifies OpenClaw's trusted provenance record before replacing only that nested package with the reviewed `proxy-addr@2.0.8` archive. The replacement fails closed if the Slack, Bolt, Express, vulnerable package, or replacement package contract differs from the reviewed identities.
- Audit boundary: the reviewed archive audit applies the same replacement before materializing the aggregate production graph, then pins the complete remediated archive tree digest. The registry archive remains immutable evidence; vulnerable bundled bytes do not survive in the final installed Slack extension.
- Lifecycle suppression: both the managed graph install and the replacement package retrieval keep lifecycle scripts disabled. The replacement package declares no lifecycle script.
- Removal condition: remove the Slack-specific rewrite only after the reviewed Slack archive bundles `proxy-addr@2.0.8` or newer. Keep the ordinary exact override until every supported managed-messaging path resolves outside the affected range and a regenerated lock plus reviewed audit proves the replacement is unnecessary.
- Regression evidence: `test/agents/openclaw/openclaw-npm-remediation.test.ts` guards the exact source and replacement contracts; `test/runtime/messaging/messaging-build-applier-integrity.test.ts` proves the installed official plugin is patched only after provenance verification; `test/agents/openclaw/openclaw-managed-messaging-offline-build.test.ts` guards the ordinary graph; and `test/agents/openclaw/openclaw-dependency-review.test.ts` keeps the audit and runtime remediation wiring present.

## Reviewed OpenClaw plugin remediation

The reviewed archive audit and image build use the package identities in `ci/reviewed-npm-audit.json`. They verify registry integrity before replacing bundled packages. Official plugin installs also require OpenClaw's trusted install record. A changed source package, replacement identity, dependency layout, or patched tree stops remediation.

The following recipes apply to the retained 2026.9.2 and 2026.9.5 archives.
They do not describe the separate 2026.10.5 replacements.

- Discord, Slack, and Google Chat: the reviewed 2026.9.2 and 2026.9.5 archives listed in `scripts/lib/openclaw-npm-remediation.mts` replace affected bundled Zod copies with `zod@4.6.6`. Discord SDK runtime modules and declarations receive a digest-checked Zod 4 migration through atomic directory replacement. Native installation permits only npm's exact relative UUID launcher link after verifying the complete reviewed UUID 14.0.2 tree. Other SDK symlinks and hard links are rejected. Remove each rewrite only when a reviewed upstream archive ships patched Zod and `scripts/audit-reviewed-npm-graph.mts` confirms its graph. `test/agents/openclaw/openclaw-zod-runtime.test.ts` supplies Discord runtime and link-boundary evidence. Require plugin-specific runtime evidence for Slack and Google Chat before removing their rewrites.
- Discord and Slack: the reviewed 2026.9.2 and 2026.9.5 archives replace bundled Undici with `8.12.2` for Discord and `7.30.1` for Slack. The replacement checks the plugin manifest, bundled package, and reviewed registry package. Remove each rewrite when the reviewed upstream archive ships a patched Undici and passes the real patched distribution and plugin runtime probes.
- Slack: the official 2026.9.2 install and reviewed 2026.9.5 archive replace bundled `body-parser@2.3.0` with `2.4.0` and affected `qs` copies with `6.16.1`. The replacement checks the Slack, Bolt, Express, parser, and `qs` identities. A retry verifies completed replacements before resuming. Remove this rewrite when the reviewed Slack archives ship patched parser and `qs` versions. The failure-and-retry test is in `test/runtime/messaging/messaging-build-applier-integrity.test.ts`; the process probe is in `test/agents/openclaw/openclaw-body-parser-runtime.test.ts`.
- Microsoft Teams: official 2026.9.2 and 2026.9.5 installs atomically replace the verified native project's MSAL Node/Common tree with `7.1.0`/`16.14.2` and its shared Zod with `4.6.6`. Both SDK consumers must resolve the project-owned MSAL path. The original project manifest and lock remain installation provenance. Remove this update when a reviewed upstream plugin install resolves those patched versions without it. `test/agents/openclaw/openclaw-msal-runtime.test.ts` probes the token manager and Azure identity constructors.

The PR and main `real-openclaw-dist-harness` jobs run those three runtime probes with scripts disabled during package installation. The audit still verifies the final production graph separately.

### OpenClaw 2026.10.5 plugins

The audit inventory also includes the reviewed `@openclaw/discord`, `@openclaw/googlechat`, and `@openclaw/slack` 2026.10.5 archives.
`patchOpenClaw105PluginDependencies` in `scripts/lib/openclaw-npm-remediation.mts` owns their installed-tree remediation.
It checks each plugin's name, version, dependency declarations, and affected dependency tree before replacement.
Each replacement must match both its registry archive integrity and its reviewed extracted-tree digest.
A completed replacement must match the same final tree before a retry can reuse it.

| Plugin | Reviewed replacement |
|---|---|
| Discord | Zod 4.6.6 and Undici 8.12.3. The embedded Discord SDK retains its `zod/v3` API and receives the digest-checked bounded-collection repair. |
| Google Chat | Zod 4.6.6. This recipe does not replace its HTTP client. |
| Slack | Zod 4.6.6, Undici 8.12.3, and body-parser 2.4.0. The parser retains local content-type 2.1.0 and qs 6.16.1 so incompatible ancestor copies cannot satisfy its imports. |

The archive audit verifies the final remediated plugin tree before installation.
The official-install path verifies OpenClaw's trusted provenance record before invoking the same recipe.
`test/agents/openclaw/openclaw-npm-remediation.test.ts` covers source drift, replacement integrity, and rejection paths.
Remove a recipe only when a newly reviewed upstream archive contains the replacements and real plugin consumers pass without the recipe.
Retain historical plugin recipes while supported installed sandboxes can still select their archives.

The production image lifecycle allowlist contains only OpenClaw 2026.9.2.
The 2026.3.11, 2026.6.10 and 2026.7.1 core archive recipes have been removed because no image build or reviewed audit selects them.
The final image still includes `openclaw-npm-remediation.mts` because the messaging build applier imports it for supported plugin remediation.

### Runtime and managed-plugin overrides

The prerequisite audit invokes `scripts/lib/remediate-openclaw-runtime-dependencies.mts` after controlled installation and before the installed-lock check.
Production remains on 2026.9.2 with its existing remediation; the separate 10.5 upgrade wires this helper into its image builds.
For OpenClaw 2026.10.5, it verifies the runtime identity and updates its npm and Undici declarations to 12.2.1 and 8.12.3.
The managed-plugin workspace must match the reviewed original or patched SHA-256 digest.
The patched workspace selects MSAL Node 7.1.0, body-parser 2.4.0, Undici 8.12.3, Zod 4.6.6, and qs 6.16.1 for future official-plugin projects.
The helper also applies the plugin recipes above when those plugins occur in the installed graph.

npm 12.2.1's bundled Undici 6.29.0 is replaced with reviewed 6.29.1 without changing npm's identity.
`patch-bundled-npm-undici.mts` validates the package contract and layout, verifies the archive integrity, and checks the installed npm and npx entrypoints.
The separate OpenClaw 2026.9.7 migration graph removes its bundled Undici 8.10.2 only after resolution selects reviewed top-level 8.12.3.
Failed verification restores the original tree.
After interrupted cleanup, a retry verifies the replacement and the retained backup before removing that backup.
Ambiguous or unsafe retained state fails without deletion.

Ordinary audit installation leaves the reviewed lock unchanged.
The explicit `updateLock` mode updates metadata when producing the aggregate archive graph or regenerating a reviewed lock.
The shared writer in `bundled-npm-package.mts` serves runtime workspaces, runtime and plugin manifests, and lock metadata.
These updates stage and verify complete bytes in the same directory before an atomic rename.
Staging failures preserve the original file and remove the attempt's temporary file; a later retry can resume.
After publication, the writer syncs the parent directory and reports any sync failure.
A retry syncs the directory even when the metadata already contains the verified replacement.
The writer preserves file permissions and ownership, rejects symlinks, and stops if it observes a replaced pathname or changed source before publication.
`test/install/remediate-openclaw-runtime-dependencies.test.ts` covers resolution, metadata writes, cleanup retries, unsafe state, and stale-lock rejection.
`test/install/patch-bundled-npm-undici.test.ts` covers the bundled npm replacement, rollback, and cleanup failures.
The shared `bundled-npm-package.mts` owns replacement, rollback, archive verification, and backup cleanup for ip-address and Undici.
Both entrypoints restore one verified affected backup when an interrupted replacement leaves the live package absent.
They validate npm identity before restoration and preserve unverified staging trees.
Replacement stages carry private ownership markers bound to the package, parent and stage directories, and creator's host boot and process scope.
On retry, both entrypoints remove a marked stage only after verifying that identity and confirming that its creator has exited.
Unknown, active, unsafe, or unverifiable stages remain intact with a recovery diagnostic; a directory-name prefix alone never authorizes deletion.
Replacement copies the original package into the private stage and verifies its complete contents before publishing a backup.
The ownership marker records the original and backup directory identities, backup name, and a digest of file contents and entry modes.
If interruption leaves the original live package intact, recovery can remove its sole owned backup after both trees match that receipt.
This recovery also requires a verified inactive stage owner; changed, ambiguous, or unsafe backups remain for inspection.
After replacement succeeds, cleanup retries remove one recognized affected backup only after verifying the live replacement.
Unrecognized names, multiple backups, missing identity, or unsafe trees fail without deletion.
`test/install/bundled-npm-package.test.ts` covers shared archive and recovery failures; package-specific suites retain identity and rollback coverage.
`test/install/bundled-npm-staging-recovery.test.ts` interrupts real child processes during copying, receipt publication, backup publication, and promotion, then checks recovery and ownership-denial behavior for both packages.
`test/agents/openclaw/openclaw-real-patched-dist-harness.test.ts` materializes reviewed 2026.10.5 archives and runs npm, npx, and the Discord SDK through the repaired dependencies.
It also verifies Google Chat account parsing through patched Zod and Slack Bolt HTTP body parsing through its patched local parser dependencies.
Remove these repairs only after reviewed upstream packages resolve the required versions without mutation and the audit and real consumers pass.

## WeChat plugin runtime graph

- Package: `@tencent-weixin/openclaw-weixin@2.4.9`. This version uses the supported channel SDK and binds inbound replies to the OpenClaw 2026.9.x model runtime. The locked production dependencies are `qrcode-terminal@0.12.0` and `zod@4.6.6`.
- Locked graph: `agents/openclaw/wechat-runtime/package-lock.json` (npm lockfile version 3).
- Lock regeneration: `npm install --package-lock-only --legacy-peer-deps --ignore-scripts --omit=dev --prefix agents/openclaw/wechat-runtime`.
- Installation boundary: the image materializes the reviewed lock into a root-owned dedicated npm cache and adds the exact package metadata needed by npm's offline resolver. Before that cache becomes immutable, the shared `scripts/lib/reviewed-npm-archive.mts` implementation re-packs every locked archive offline from the final cache and rejects registry-origin drift, metadata or packed-byte SRI drift, unsafe filenames, missing archives, and symlinks. The sandbox user copies that verified immutable source into a writable cache used for registry metadata lookup, archive packing, and the OpenClaw plugin install; no retrieval step falls back to `HOME/.npm`. The copy is deleted in the same image layer, and the trusted cache is never writable. The installer runs in offline, legacy-peer mode, then `verify-wechat-runtime-lock.mts` rejects integrity, version, dependency-set, or peer-range drift and refuses an image OpenClaw version below the plugin's locked peer minimum.
- Default CI gate: `reviewed-npm-audit` in `.github/workflows/pr.yaml` and `.github/workflows/main.yaml` audits the WeChat locked graph with the shared reviewed npm implementation.
  The pull request workflow loads the audit implementation, policy, manifest, and lockfile from the candidate checkout.
  The shared gate uses Node.js `24.22.1` and verified `npm@12.0.2`.
  It installs the exact lock with lifecycle scripts disabled and legacy peer resolution, rejects any low-or-higher production advisory, and verifies registry signatures.
  It also exercises the reviewed archive through a copied writable cache while the trusted source remains read-only.
  Signature verification makes at most three attempts and retries only `npm error Failed to download`; all other failures stop immediately.
  The shared report artifact stores the audit policy, signature-attempt evidence, and whether each response came from a matching cache entry or a live registry request.
  Its mcporter receipt, raw report, and trusted policy result cross into image builds; the other graph receipts remain CI evidence.
  The archive graph also retains the generated manifest and lock bytes authenticated by its receipt.
- Advisory command: `npm ci --ignore-scripts --omit=dev --legacy-peer-deps --prefix agents/openclaw/wechat-runtime && npm audit --registry=https://registry.yarnpkg.com --omit=dev --audit-level=low --json --prefix agents/openclaw/wechat-runtime && npm audit signatures --registry=https://registry.yarnpkg.com --omit=dev --prefix agents/openclaw/wechat-runtime`.
- Advisory review: `2026-09-23`; result: `0` known vulnerabilities across the resolved production graph. Registry signatures verified for all three packages; one package has a verified attestation.
- Regression tests: `test/install/wechat-locked-install.test.ts` keeps the manifest runtime-lock paths and installer verification dispatch synchronized; `test/install/verify-wechat-runtime-lock.test.ts` proves that the installed graph, OpenClaw peer range, and lazy inbound-handler imports fail closed; `test/automation/releases/reviewed-npm-audit-workflow.test.ts` keeps the cache lifecycle, audit threshold, bounded signature retry, invalid-signature denial, and npm-pack boundary synchronized.

The dedicated graph intentionally omits the plugin's `openclaw` peer dependency. The image already installs and integrity-verifies the reviewed OpenClaw runtime separately; auto-installing another OpenClaw copy would create a second unreviewed runtime graph.
Disabling scripts also prevents transitive packages from executing lifecycle code during the trusted image build.
The lock records the exact version, registry URL, and integrity for every transitive package; the top-level registry integrity check remains an independent control.

## Source-of-Truth Boundary

- `invalidState`: the image installs a package graph, tarball, license, or advisory state that differs from the independently queried npm registry records for `mcporter@0.7.3`, resolves `@hono/node-server` to any version other than exact `2.0.11`, resolves `fast-uri` to any version other than exact `3.1.7`, resolves `hono` to any version other than exact `4.12.34`, resolves `ip-address` to any version other than exact `10.3.1`, resolves `@modelcontextprotocol/sdk` to any version other than exact `1.32.0`, or leaves any final managed-messaging `proxy-addr` installation at a version other than exact `2.0.8`.
- `sourceBoundary`: npm owns registry metadata, tarball integrity, provenance signatures, and advisory responses; NemoClaw owns the exact lock, script-disabled install, Docker integrity assertion, empty-by-default audit exception registry, and review record.
- `whyNotSourceFix`: a repository note cannot make external registry state trustworthy, so the required `reviewed-npm-audit` CI check materializes the exact locked production graph and verifies its registry signatures.
- `imageBuildBoundary`: image builds verify the committed lock, registry origin, tarball integrity, installed graph, and lifecycle suppression.
  Builds without supplied audit evidence evaluate the reviewed advisory policy directly.
  Evidence-backed builds instead verify the receipt and policy-result transport hashes after trusted workflow code validates the candidate graph and policy.
  Neither path connects to Sigstore.
  The `schema=4` and `mcporter-recipe=locked-ci+reviewed-audit-v3` provenance values record this boundary.
  They do not attest that trusted CI verified registry signatures.
- `enforcementBoundary`: any nonzero `npm audit signatures` status fails the required CI check.
  The PR workflow requires this check before merge.
  The `pr-reviewed-npm-audit` job loads its audit implementation, policy, and dependency files from the commit under review.
  The managed-image build job requires that result before local builds and same-repository digest publication.
  The base-image workflow requires its audit result before it builds or publishes any base image.
  It also requires the result before it invokes managed-image publication.
  Final OpenClaw images reuse a matching installed runtime only from a digest-pinned base in the official GHCR namespace.
  The publication workflow gates that base on the check.
  A matching marker from a local base or mutable tag is package metadata without independent CI attestation.
  It cannot authorize reuse; the existing version checks reinstall the locked runtime or reject a newer base.
- `regressionTest`: `test/security/mcporter-supply-chain.test.ts` keeps the version, integrity, lock metadata, Docker install flags, image-build audit boundary, `reviewed-npm-audit` CI check, and this review synchronized.
  `test/inference/managed/managed-image-publication-workflow.test.ts` verifies that the candidate checkout supplies the audit action and inputs, and that publication depends on the audit.
  `test/automation/releases/reviewed-npm-audit.test.ts` proves exact matching and fail-closed exception validation.
- `removalCondition`: remove this runtime dependency and review when OpenClaw provides the required authenticated Streamable HTTP client lifecycle without mcporter, or repeat the independent review for a newly pinned version.

## OpenClaw 2026.10.5 qualification prerequisites

[PR #13697](https://github.com/NVIDIA/NemoClaw/pull/13697) prepares trusted audit and E2E controls for
[PR #12382](https://github.com/NVIDIA/NemoClaw/pull/12382), which owns the runtime upgrade.
This prerequisite retains production OpenClaw 2026.9.2 and WeChat 2.4.9.
Their existing locks remain the primary audit identities.
The replacement records admit only the reviewed OpenClaw 2026.10.5 and WeChat 2.4.10 lock digests, package integrities, and registry URLs.
They do not select another production runtime or admit arbitrary locks.
The 2026.9.5 and 2026.9.7 migration graphs are separate audit inputs; this prerequisite does not activate them on main.

The archive inventory retains the versions needed by main and the upgrade.
The audit materializes the selected graphs, applies the reviewed recipes, verifies installed-lock identity, checks advisory policy, and verifies registry signatures.
A passing candidate audit does not approve changes to its own policy.
Independent review must inspect those changes and the receipts for each selected lock.

Full PR E2E uses trusted main for these controls.
The Model Router target also needs the target-specific Python 3.13 setup in this prerequisite.
The runtime upgrade still requires successful CI, managed-image activation, automated review, and full default E2E qualification.
Retain draft status until the applicable qualification and independent review requirements pass.
Retire superseded archive identities only when their runtime consumers and historical qualification obligations are retired.

## Bundled schema and request-body repairs

The reviewed runtime graphs pin Zod 4.6.6 and body-parser 2.4.0. The existing
archive remediation also updates the Discord and Slack 2026.9.2/2026.9.5 bundles,
and Google Chat 2026.9.2/2026.9.5, to Zod 4.6.6. Discord's embedded SDK 2.5.0 uses migrated
CJS/ESM schemas and declarations instead of its vendored Zod 3 implementation.
The migration checks the original SDK output digest before changing files.

Both Slack bundles receive body-parser 2.4.0 with nested qs 6.16.1,
iconv-lite 0.7.3, and content-type 2.1.0. Express retains its separate
content-type 1.0.5 copy. Publisher SRI pins and final package-tree digests remain
in `scripts/lib/openclaw-npm-remediation.mts`. The verified native-install path
applies the same replacements after checking the managed plugin location.

The managed messaging cache retains the original bundled dependency records
and supplies the replacement archives offline. Its direct Zod 4.6.6 pin and
body-parser 2.4.0 override are included in the committed lock and checksum-pinned
Docker archive inputs. The WeChat cache separately supplies its locked Zod
4.6.6 archive. These repairs add no advisory exceptions.

Retained OpenClaw 2026.9.2 and 2026.9.5 Undici 8.x repairs use 8.12.2.
The 2026.10.5 runtime and plugin repairs and the 2026.9.7 migration graph use
8.12.3. The retained Slack 7.x copy uses 7.30.1. These replacements reject
excessive response content encodings without changing the existing
major-version boundary. The CLI and OpenClaw
locks, generated runtime bundles, archive-tree pins, and offline cache inputs
record those versions. The cache carries the 7.x replacement through the
existing npm-alias pattern. Original bundled records remain available for
source-archive verification before remediation.

Teams 2026.9.2 and 2026.9.5 use MSAL Node 7.1.0 with Common 16.14.2 to
address GHSA-xcx6-jx8p-x3h5. Their SDKs are nonbundled dependencies in the
verified native npm project. After provenance and project-path checks, the
existing remediation replaces their shared MSAL tree and its nested Common
atomically. Azure Identity 4.13.2 and Teams Apps 2.0.15/2.0.16 retain their
code and declared 5.x ranges; the explicit security migration overrides those
ranges at runtime. The original installation lock remains source provenance.
The archive audit resolves MSAL 7.1.0, and the cache supplies both the original
installation and replacement archives. Other Common consumers retain their
versions. Compatibility checks cover existing Teams and Azure token flows
with simulated responses, plus the advisory's routing and state denials.

The same verified Teams projects replace their shared nonbundled Zod 4.4.3/4.5.4
with 4.6.6 after checking the plugin dependency and actual module resolution.
The existing direct Zod cache pin supplies the replacement. Schema comparisons
retain existing accepted/rejected configuration behavior; an oversized bounded
collection is rejected before visiting its elements. Original installation
metadata remains source provenance, as with the MSAL migration.

Managed image and CI tooling use Node.js 24.22.1. The base-image security probe
checks that exact runtime as well as the Debian package inventory, because
Node bundles native libraries that npm audit and dpkg do not cover. Older
cached bases fail admission and follow the existing rebuild path. The reviewed
npm target remains 12.0.2; Node’s initial npm 11.19.1 tree is replaced before
package installation, then the existing private-package repairs are applied.
