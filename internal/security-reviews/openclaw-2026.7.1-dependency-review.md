<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# OpenClaw 2026.7.1 dependency review

> Internal engineering evidence. This file is not part of the public documentation set.

Review date: 2026-07-21

Last updated: 2026-08-21

## Decision

Pin the production OpenClaw runtime and matching official plugins to the
non-prerelease `v2026.7.1` release. This replaces `2026.6.10`, whose bundled
graph contains the critical `tar` advisory that prompted the release update.

On August 21, 2026, npm advisory drift exposed `GHSA-r292-9mhp-454m` in
`tar<=7.5.20`. The published `openclaw@2026.7.1` archive contains `tar@7.5.19`,
and NemoClaw's plugin directly selects `tar@7.5.20` for guarded migration
archives. Retain supported `openclaw@2026.7.1`, apply the existing fail-closed
archive remediation to select `tar@7.5.21`, and select the same first patched
release in both committed production locks. Do not add an audit exception.

The production OpenClaw install uses the authoritative committed lock at
`agents/openclaw/openclaw-runtime/package-lock.json`, with SHA-256
`60f816dcff6f35179b1c48b4c06db9473497760d45ca1831252c27e8b1d2d665`.
NemoClaw derives that lock from the SRI-verified `openclaw@2026.7.1` archive
after applying the reviewed dependency remediation.
The committed `nemoclaw/package-lock.json` has SHA-256
`66bef669196bb1c61385871e369542d3c321c277adb0f0e2e9f0ad972106b163`.
The protected managed-image build's locked npm cache seed binds that same lock
digest and the exact `tar@7.5.21` archive.
The remediation replaces `brace-expansion@5.0.7` with `5.0.9`.
It also replaces `fast-uri@3.1.2` with `3.1.5` and `ip-address@10.2.0` with
`10.3.1` in the OpenClaw core graph.
It replaces `tar@7.5.19` with `7.5.21` in the core manifest and shrinkwrap,
including the `@openclaw/fs-safe@0.4.1` optional dependency edge.
The combined reviewed-archive install also applies the exact root override
`tar@7.5.21`. Without that install boundary, npm follows the published
`@openclaw/fs-safe@0.4.1` manifest and recreates nested `tar@7.5.19` even when
the remediated OpenClaw archive's own manifest and shrinkwrap are corrected.
The reviewed `npm@11.18.0` archive also contains a private `tar@7.5.19` tree.
Image builds retain the existing pre-upgrade tar repair before npm installs the
reviewed npm archive. They then apply the same exact `tar@7.5.21` repair after
the npm upgrade. Each completed image reasserts the idempotent repair at its
final filesystem boundary.
The same reviewed `undici@8.10.0` replacement applies to the OpenClaw core
dependency and the Discord manifest, shrinkwrap, and bundled package tree.
The committed mcporter lock also selects `fast-uri@3.1.5` and
`ip-address@10.3.1`.
Both committed runtime locks select `hono@4.12.34`.
Image builds verify the lock digest and installed production graph before they
expose the OpenClaw binary.

The release lineage is unusually wide and divergent: the direct upstream
comparison reports 4,407 commits ahead and 34 behind. The maintainer requested
this exact stable release after reviewing that risk. The long-term source of
truth for these behaviors remains upstream OpenClaw, and this upgrade does not
turn NemoClaw's compiled-dist shims into supported upstream APIs.

OpenClaw now requires Node `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`.
NemoClaw therefore moves its exact `node:22-trixie-slim` digest to the image
whose amd64 config reports Node `22.23.1`.

## Reviewed identities

- `openclaw@2026.7.1`
  - `sha512-ge/Xss99CHAjPL/ikmH/UFoiOrjcxDB4sW3y9mhyCD+dYW3wzV7TKbAVdkrXFgAG2d2BjpJofP97zUZ+umxo8g==`
  - `https://registry.npmjs.org/openclaw/-/openclaw-2026.7.1.tgz`
  - remediated package tree: `sha512-OfBP5yJPR5gdGnQ1LPtvSvrn3WoRT7+vi3KMsNGyXgwM8wpzJ174dfnJTLRtn6zSX9Vrp84uDn6YffkaLyNOVg==`
- `@openclaw/diagnostics-otel@2026.7.1`
  - `sha512-XXhMifYWTgoR6yFN4T3JkHxdPvQCe8k1cNZjVIgXNmk1svCdBWuALfQQicmpemlmWwauIQuHYgBURY6k63e+rw==`
- `@openclaw/brave-plugin@2026.7.1`
  - `sha512-7Z+GZ/6K6a8LlkTsWVnAZ1hv8EarORzHQvFHD7ekcg033FGJOXYPEZSbvvE3qR9vM+vnoZplNjMZ7vFMRcvQgw==`
- `@openclaw/discord@2026.7.1`
  - `sha512-tZfdC1YA8oVLvc2BK1w0F6rUljS5ugCOp2uWe0vPsbG1fbzVVIO4V32RoqZznGHe5u2R9u4n1aV5Z/qa1m2oFg==`
  - remediated package tree: `sha512-w+F8FrRl0wPd0EN2RnLyu6yfixel7BT8Iex4wLLQDvfIac8rLhuksNpFU4uZa8W9wXgh47hguq0F9NSN0BZfOQ==`
- `@openclaw/slack@2026.7.1`
  - `sha512-dwVGEVCmoTQrOIeZaSCIOPg8pT7hB883QQEXdp9EZUDzTGuvSc+KxH2iERSOV/59hROQctYdcobGn/vdB1H4XA==`
  - remediated package tree: `sha512-4ThnsNS+yBlFSkTaQn2xosxrDu1s0vrxcqka5QqFj+8dCEaTa9JVLRgNniYV/QNhO53wc7a2R5oQFElzYspT2w==`
- `@openclaw/whatsapp@2026.7.1`
  - `sha512-wLY/Omc5fleRpl2lKGN8sxt/8hYfHGwLRezmWsk8oCbea5pRKUPE6ZX+wJO1O52NOJkAGCuiXvS7x0qIeKxXbQ==`
- `@openclaw/msteams@2026.7.1`
  - `sha512-gG/Yk6HZAguHwrmKjsqdONbFz5WNy126PEAXQWNW/TulO1kIifQ6tktM16BQPNLnkmWqLbj+TrrO55Cjas1aFg==`
  - remediated package tree: `sha512-FL4l65gEbbwtDd9Ogr69+xBNzIfE4YS8Hib36G+kcmX+T0oB1zL+/qs6b4bJc+ygTsh60H3yqpFbXoQeN05JYQ==`
- `@zed-industries/codex-acp@0.11.1`
  - `sha512-My2VSlBtvJipJhImHjFDej2ut/p00QqOISRnZgLgLrSIzjgvdcQvAhaZviWj7XPhk4UIdIb0OoA+Lrls824uiQ==`
  - `https://registry.npmjs.org/@zed-industries/codex-acp/-/codex-acp-0.11.1.tgz`
- `@tencent-weixin/openclaw-weixin@2.4.3`
  - `sha512-dPQbidUNWigC6V10vGW4i+GLH09x+6zUhafZRjuxkJ9GDu8o62WBsnUTojp4KqUH756hz+t2v9khiCRSi0dBDw==`
- `tar@7.5.21` (OpenClaw, NemoClaw plugin, and npm-private remediation)
  - `sha512-XdhtCvlMywwxpCW8YEq3lOXBJpUPTR2OHHcwLPO3HwsJqOHa2Ok/oJ7ruGzp+JrKoRPVCzJwAdEjqLW/vNRPHA==`
  - `https://registry.npmjs.org/tar/-/tar-7.5.21.tgz`
  - `BlueOak-1.0.0`; Node `>=18`
  - signed annotated tag object: `ffe9a0eac23bfc2b1ce50e202ee51f22c471fc73`
  - verified tag commit: `0cd9cc3c5814446d3c0cbea6a31d6c00c2c8a9d9`
- `brace-expansion@5.0.9` (OpenClaw locked-runtime remediation)
  - `sha512-ScQ4IuvIEF1TMlP7Zt+vjJ//9zlPb2SDcxWxM3bk8s6t6GGdJ7KO1dCcTidOPJKePW30LE/2cT7wCyPho9/Wxg==`
  - `https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.9.tgz`
- `fast-uri@3.1.5` (OpenClaw and mcporter locked-runtime remediation)
  - `sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==`
  - `https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.5.tgz`
  - `BSD-3-Clause`; no dependencies
- `undici@8.10.0` (OpenClaw core and Discord remediation)
  - `sha512-HvltHd7avK13QIw/oLe4qoOLyoVSoafqJ2jYOrtMRBkbYT31eiBQ8O0ehRKZiEZCMEyLFQNIADpgCWC5fALvYQ==`
  - `https://registry.npmjs.org/undici/-/undici-8.10.0.tgz`
  - `MIT`; no dependencies; Node `>=22.19.0`
- `ip-address@10.3.1` (OpenClaw and mcporter locked-runtime remediation)
  - `sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g==`
  - `https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz`
  - `MIT`; no dependencies; Node `>= 12`
  - annotated source tag commit: `be7e626c0d49fccb518899f520a3fb64ee189741`; unsigned tag
- `hono@4.12.34` (OpenClaw and mcporter locked-runtime remediation)
  - `sha512-GqXJqY/xJkJmuloTrnV1ZEXG3fqte+VjkUqoRNZXcrUidiUOP4fMSIHHY4tsqZBK++kVyWmt/AAfSUuy57/eSA==`
  - `https://registry.npmjs.org/hono/-/hono-4.12.34.tgz`
  - `MIT`; no dependencies; Node.js `>=16.9.0`
- `mcporter@0.7.3` committed runtime lock
  - SHA-256: `17f2372a0a6949df928333a2f98862ae563013a7682b19a8ce63825c4696a064`

`fast-uri@3.1.5` has a valid npm registry signature and no registry attestation.
`undici@8.10.0` has a valid npm registry signature and SLSA provenance.
`ip-address@10.3.1` has two valid npm registry signatures and SLSA provenance.

## Audit result and temporary dependency remediations

The reviewed audit materializes three production-compatible boundaries: the
remediated reviewed-archive graph, the committed OpenClaw runtime lock, and the
committed mcporter runtime lock.
The August 21 registry-backed checks used Node `22.23.2` and npm `10.9.4`.
Their exact current results are:

- Reviewed archive graph: `info=0`, `low=0`, `moderate=1`, `high=0`,
  `critical=0`, `clean`.
- OpenClaw locked runtime: `info=0`, `low=0`, `moderate=2`, `high=0`,
  `critical=0`, `clean`.
- mcporter runtime: `info=0`, `low=0`, `moderate=0`, `high=0`, `critical=0`,
  `clean`.

Registry signature checks completed within the successful audit.
The critical `tar` finding that blocked the previous pin, the new high
`GHSA-r292-9mhp-454m` finding, and the high Jaeger,
`brace-expansion`, `fast-uri`, `undici`, and `ip-address` findings are gone.
All three post-remediation boundaries report `0` high and `0` critical
findings.
Lower-severity findings remain visible below the configured `high`
threshold.

The independently installed `nemoclaw/` plugin graph reports `0`
vulnerabilities after resolving its direct `tar` dependency to `7.5.21`.

The npm-private remediation rejects affected `tar@7.5.19` and `7.5.20`,
downloads the same exact `tar@7.5.21` archive over HTTPS, verifies its SRI,
and replaces the complete private package tree transactionally. Dockerfile
contract tests require this repair both before and after the complete
`npm@11.18.0` upgrade in every shipped base-image composition and require the
final-image repair before any `npm ci` or `npm install` command.

The separately locked `mcporter@0.7.3` runtime graph originally resolved
`@hono/node-server@1.19.14`, affected by `GHSA-frvp-7c67-39w9`. Its former
`2.0.5` override became affected when `GHSA-9mqv-5hh9-4cgg` was published for
releases through `2.0.9`. The locked `@modelcontextprotocol/sdk@1.29.0` still
declares `@hono/node-server@^1.19.9`, so the dedicated runtime manifest now pins
reviewed `2.0.11`, outside both affected ranges. Its Node `>=20`
requirement remains inside the image's Node contract, and real ESM plus
CommonJS Streamable HTTP transport construction/start/close probes cover the
major-version compatibility boundary.

The SDK graphs in OpenClaw and mcporter request `hono@^4.11.4`.
The committed locks previously selected `4.12.25` and `4.12.27`.
`GHSA-8j4g-w8fx-2239`, `GHSA-54fx-42gc-7vw4`,
`GHSA-f23p-vx2j-j53r`, and `GHSA-79qm-7rj5-m7r9` affect those releases.
Version `4.12.34` fixes all four advisories.
Both runtime manifests now select reviewed `4.12.34` through an exact override
that remains within the declared SDK range.

OpenClaw's `minimatch@10.2.5` edge originally resolved
`brace-expansion@5.0.7`, which is affected by `GHSA-mh99-v99m-4gvg`.
The initial remediation selected `5.0.8` for that advisory.
`GHSA-rgw5-rvv9-x895` affects `brace-expansion` versions `>=4.0.0 <5.0.9`,
and `5.0.9` fixes the advisory.
The current OpenClaw remediation selects `5.0.9`, retains the declared
`balanced-match@^4.0.2` dependency shape, and fails if the upstream shrinkwrap
or replacement archive identity changes.

The AJV graphs in OpenClaw and mcporter request `fast-uri@^3.0.1`.
The reviewed upstream OpenClaw shrinkwrap resolves `3.1.2`, and
`GHSA-v2hh-gcrm-f6hx` affects releases through `3.1.3`.
The initial remediation selected `3.1.4` for that advisory.
The high-severity `GHSA-7p8r-x3mc-p8w7` later affected that release.
Both committed runtime locks now select reviewed `3.1.5`.

The OpenClaw core package manifest and shrinkwrap directly pin `undici@8.5.0`.
The published `@openclaw/discord@2026.7.1` archive also pins that version in
its package manifest and shrinkwrap.
Discord lists `undici` in `bundledDependencies` and contains bundled
`node_modules/undici@8.5.0`.
`GHSA-8xcm-r25x-g524` and `GHSA-4cwx-7wf7-3272` affect releases
`>=8.0.0 <8.9.0`.
The current remediation selects the same reviewed `8.10.0` archive for both
packages.
The replacement retains the no-dependency package shape and Node `>=22.19.0`
engine requirement.
For Discord, the remediation fails closed unless the manifest, shrinkwrap, and
bundled package identities match the reviewed `undici@8.5.0` boundary.
It updates the manifest and shrinkwrap and replaces the complete bundled
package tree with the verified `undici@8.10.0` archive.

The upstream `undici@8.10.0` release CI reported one flaky Node 24 failure in
`test/http2-request-never-settles.js`: 1,502 tests passed, and one failed.
The Node 22 `no-intl` and `no-ssl` jobs, type checks, lint, fuzz, release, and
Scorecard jobs passed.
NemoClaw's focused remediation and locked-install tests, audit validation,
registry-signature verification, and provenance verification provide
compensating evidence for the reviewed archive.

Undici 8.10.0 forwards plain HTTP targets through a configured HTTP or HTTPS proxy by default.
It sends an HTTP/1.1 absolute-form request target unless `proxyTunnel` is enabled.
Undici 8.5.0 used CONNECT by default for the same target.
NemoClaw's managed image registry requests use HTTPS, so they continue to use CONNECT.
The proxy fixture returns `200` for an ordinary HTTP request and `502` for CONNECT.
It verifies the body, method, host, and full target URL for forwarding.

The OpenClaw core and mcporter graphs resolve `express-rate-limit@8.5.2` and
its declared `ip-address@^10.2.0` dependency to affected `10.2.0`.
The high-severity `GHSA-mwp4-54f8-5fhr` affects releases through `10.3.0`
because leading-zero IPv4 inputs can cross SSRF and trust boundaries through
decimal or octal interpretation differences.
Version `10.3.1` also contains the fixes for `GHSA-4xrf-jv44-h6hh` and
`GHSA-22jq-vg5j-6vgg`.
Both committed locks select the first release outside all three affected
boundaries, `10.3.1`, while preserving the declared `^10.2.0` consumer range.

The full non-shallow `v10.2.0..v10.3.1` source range was reviewed.
The change adds correct host-only classification and rejects leading-zero IPv4
inputs.
The annotated `v10.3.1` tag resolves to commit
`be7e626c0d49fccb518899f520a3fb64ee189741` and is unsigned.
Release check `30150298200` succeeded.
Its trusted OpenID Connect (OIDC) publish workflow ran `npm ci` and `npm test`
before publication.
The focused repository tests pass 103/103, and the bundle-specific unit suite
passes 16/16.
Both committed locks report no problems through `npm ls`.
`npm run build:cli`, `npm run typecheck:cli`, and
`npm run checks:repository` pass.

Image assembly reports lower-severity findings and blocks high or critical
findings unless they match the empty-by-default audit exception registry.
Signature verification and the exact committed locks remain mandatory.

The OpenClaw audit first applies the same fail-closed remediation to the
SRI-verified reviewed archive, then independently installs and verifies the
committed lock. The audit configuration pins the official npm registry origin,
package identity, tarball URL, SRI, and lock SHA-256. It rejects repository
path escapes, lock drift, registry-origin drift, or an installed graph that
does not match the lock before evaluating advisories. Remove the OpenClaw core
replacements only after a supported OpenClaw archive publishes every corrected
dependency identity and the regenerated lock, installed-graph verification,
audit, and signature checks all pass.
Remove the Discord `undici` replacement only after a supported Discord plugin
archive publishes the corrected identity in its manifest, shrinkwrap, and
bundled package tree and passes the same audit, signature, and runtime checks.

The published Slack and Microsoft Teams plugin archives bundle `axios@1.16.0`.
That version is in the affected range for the newly disclosed Axios
inherited-proxy advisory. NemoClaw therefore rebuilds only these two reviewed
plugin archives with this exact replacement graph:

- `axios@1.18.0`,
  `sha512-E32NzpYKp++W7XRe52rHiXV2ehxmh3wbdgO7MHeFM+vqxLBYHzt0ElkiImtOBxtOmyp0yoC8C6uESVV84Y2/hw==`;
- `https-proxy-agent@5.0.1`,
  `sha512-dFcAjpTQFgoLMzC2VwU+C/CbS7uRL0lWmxDITmqm7C+7F0Odmj6s9l6alZc6AELXhrnggM2CeWSXHGOdX2YtwA==`;
- `agent-base@6.0.2`,
  `sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==`.

The diagnostics plugin bundles `@opentelemetry/sdk-node@0.219.0`, whose exact
dependency on `@opentelemetry/propagator-jaeger@2.8.0` is affected by
`GHSA-45rx-2jwx-cxfr`. The helper changes only that bundled SDK dependency edge
to the first patched release and installs the matching Core package beneath it:

- `@opentelemetry/propagator-jaeger@2.9.0`,
  `sha512-4mYGty27rYvSM0jtp1ZUOqd3LfVRCYg9H5G9OFzSx5HViYToU21MFhWfco7x1HwXr7ER8yGOiCIHZUwjPksc0Q==`,
  `https://registry.npmjs.org/@opentelemetry/propagator-jaeger/-/propagator-jaeger-2.9.0.tgz`;
- nested `@opentelemetry/core@2.9.0`,
  `sha512-m2nckMT80NnmjTYSPjJQObBJ+8dgkoajEOUbznL8AHZ3T3yHRk2P7gI1PhEBc1+lOnrYE9UWrWHqJDsmqjmNbw==`,
  `https://registry.npmjs.org/@opentelemetry/core/-/core-2.9.0.tgz`.

Both replacements declare `Apache-2.0`. The nested Core keeps every other
consumer on the plugin's reviewed `2.8.0` graph while satisfying Jaeger's exact
`2.9.0` dependency. The helper fails closed unless the source archive still
contains diagnostics `2026.7.1`, SDK Node `0.219.0`, Jaeger `2.8.0`, and no
preexisting nested Core. The resulting package tree is pinned to
`sha512-2qyDTRPqNs97jo/pAWWfxAkVZyCXYqui/IjrGf4eEfYop1eGN8qBMJ/Kp/bJ/V18RNnYpMxHi5ECFelekVxcAQ==`.
The trusted main-only
`test/agents/openclaw/openclaw-diagnostics-jaeger-runtime.test.ts` harness runs with
`NEMOCLAW_REAL_OPENCLAW_JAEGER_HARNESS=1`.
It materializes the exact reviewed diagnostics archive, applies the production
remediation, and installs that local archive with lifecycle scripts disabled.
The child-process probe confirms these results:

- malformed percent-encoded `uber-trace-id` and `uberctx-*` headers do not throw;
- malformed baggage is ignored;
- valid `uberctx-test` baggage remains available;
- a valid Jaeger header produces the expected trace and span context.

`scripts/lib/openclaw-npm-remediation.mts` verifies each original package and
replacement package identities before it writes the archive. It rejects an
upstream graph that no longer resolves the reviewed Axios, Jaeger,
`brace-expansion`, `fast-uri`, `undici`, or `ip-address` source versions and
dependency shapes.
For Discord, it requires the package manifest dependency and
`bundledDependencies`, shrinkwrap, and bundled package tree to retain the
reviewed `undici@8.5.0` identities before replacement.
It then verifies the deterministic remediated package-tree integrity before
installation or lock generation.
This canonical tree digest is independent of npm-generated tar metadata, which
can vary between npm patch releases without changing package contents.
The production plugin installer, OpenClaw lock workflow, and
`reviewed-npm-audit` use this same function.
The tree hash opens each regular file without following symbolic links and
validates the opened descriptor before it reads the content. This keeps the
metadata and content checks bound to the same file.

The Axios remediation is limited to `@openclaw/slack@2026.7.1` and
`@openclaw/msteams@2026.7.1`; the Jaeger remediation is limited to
`@openclaw/diagnostics-otel@2026.7.1`. Remove each branch when a reviewed stable
OpenClaw plugin release bundles the corresponding patched graph and passes the
repository audit.
Issue #7337 tracks removal of the Jaeger branch and its exact replacement pins.

The reviewed installer verifies each registry identity and downloaded tarball
integrity. `scripts/lib/reviewed-npm-archive.mts` uses `npm pack --json` and
rejects reported archive filenames containing unsafe archive paths. Its archive
checks bind reviewed npm installs to verified local archives: they compare each
reviewed npm plugin registry integrity, and the helper returns only the verified
local `.tgz` path. Its locked-runtime
checks bind the OpenClaw and mcporter installs to exact committed lock digests,
the official registry origin, and post-install graph verification.

The final OpenClaw image materializes its optional OTEL and Brave plugins, the
WeChat runtime, the complete managed-messaging dependency graph, and
`@zed-industries/codex-acp@0.11.1` without network access in any package-install
instruction. For these components, BuildKit fetches every source archive
through a checksum-addressed `ADD` instruction.
The optional plugin boundary verifies the committed SHA-512 identities for `@openclaw/diagnostics-otel@2026.7.1` and `@openclaw/brave-plugin@2026.7.1`.
Its diagnostics remediation consumes only the mounted, checksum-addressed `@opentelemetry/propagator-jaeger@2.9.0` and `@opentelemetry/core@2.9.0` archives.
The WeChat dependencies `openclaw-weixin@2.4.3`, `qrcode-terminal@0.12.0`, and `zod@4.4.3` use committed SHA-256 source checksums and their lockfile SHA-512 identities.
Codex ACP uses committed SHA-256 source checksums and SHA-512 identities for the common package and the selected `linux-x64` or `linux-arm64` native package.
`scripts/lib/seed-reviewed-npm-cache.mts` rejects missing, extra, symlinked, off-registry, or integrity-mismatched archives before it creates the minimal npm resolver metadata.
The managed-messaging lock selects 266 archives for each supported platform:
264 common archives and two architecture-specific Davey archives for either
`linux-x64` or `linux-arm64`. The Dockerfile selects that exact platform stage,
verifies every archive again against the committed lockfile SHA-512 identity,
and runs `npm ci` with `NPM_CONFIG_OFFLINE=true` under `RUN --network=none`.
The WeChat stage runs `npm ci` and re-packs every locked archive with `NPM_CONFIG_OFFLINE=true`.
The Codex ACP stage verifies both local archives and installs them with `npm install --offline`.
Only the installed optional-plugin contents, root-owned WeChat cache, installed
managed-messaging packages, and installed Codex ACP payload enter the final
image. The mounted source archives do not enter the final image. Imported build
cache remains an optimization, but the protected OpenClaw GPU rebuild no longer
depends on it to supply the managed-messaging archive graph. Package
materialization cannot fall back to the public registry.

## OpenClaw Compiled-Dist Patch Runtime Boundary

`test/agents/openclaw/openclaw-real-patched-dist-harness.test.ts` materializes the exact public
archive under `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1`, applies every current
NemoClaw patch, verifies syntax, and exercises the live device self-approval
proof. This is not a substitute for focused nightly E2E proof.

The `2026.7.1` dist changed eight reviewed shapes:

- strict managed-proxy activation now uses `isStrictManagedProxyActive`; the
  patch still activates only inside OpenShell and only without an explicit
  dispatcher policy;
- gateway daemon backend calls ignore the inherited `OPENCLAW_GATEWAY_URL` only
  when `process.title === "openclaw-gateway"` and `OPENSHELL_SANDBOX=1`, so
  gateway daemon self-dialback uses loopback. Descendant agents retain the
  environment variable for private-interface routing. Explicit gateway URL
  overrides, local port overrides, configured remote URLs, and behavior outside
  this condition are unchanged.
  `scripts/openclaw/patch-gateway-daemon-dialback.mts` is gated to the exact
  `2026.7.1` version and rejects missing or ambiguous compiled-dist shapes. Its
  regression test covers the daemon and descendant boundaries.
  Remove the patch when upstream OpenClaw distinguishes gateway daemon
  self-dialback from descendant agent routing without changing the inherited
  gateway URL.
- queued follow-up execution now resolves inbound context before allocating a
  run id; `scripts/patch-openclaw-chat-send.mts` preserves the submitted run id
  at that new boundary. It also suppresses the premature empty final event that
  the new queue acknowledgment emits before the correlated follow-up completes;
- device-token authentication now rejects a requested scope upgrade before the
  canonical pairing gate can create its pending request. The compatibility
  patch continues only an exact CLI/operator request limited to
  `operator.pairing`, `operator.read`, and `operator.write` into that gate; the
  requested operation remains blocked until canonical pairing approval;
- shared and per-agent SQLite state now run during the required gateway startup
  checkpoint and apply owner-only modes on each open.
  `scripts/patch-openclaw-shared-state-permissions.mts` keeps the upstream
  `0700` directory and `0600` file modes in same-UID OpenShell sandboxes.
  The entrypoint derives `NEMOCLAW_OPENCLAW_SHARED_STATE=1` only for its root,
  split-user topology; it explicitly removes that marker from non-root
  OpenShell startup. Direct-container `sandbox` and `gateway` users can then
  access the same database through their shared group, while OpenShell keeps
  OpenClaw's native private-mode contract. The image does not retain this
  marker; its descriptor-safe final repair normalizes any build-created global
  SQLite files for a later direct runtime. Gateway workers and direct-container
  connect shells inherit the entrypoint-derived marker.
  It skips `chmod` only when the existing mode already matches and rejects an
  unexpected or ambiguous compiled-dist shape;
- the patch leaves upstream private-store enforcement unchanged, including its
  `0700` directory and `0600` file modes for device identity, device
  authentication, and credential-profile paths. The shared-state marker is not
  consulted by those generic stores;
- generated `models.json` is the reviewed exception to the generic private-store
  rule. Under the split-user NemoClaw marker, the compiled models-config patch
  keeps this non-secret provider configuration at `0660` and skips a non-owner
  `chmod` when the inherited mode is already correct. Same-UID OpenShell and
  runtimes outside NemoClaw preserve the upstream `0600` behavior;
- the legacy update-check migration is skipped only under the split-user marker
  or a validated OpenShell marker. This state contains polling, notification,
  and auto-install cache for an OpenClaw version that NemoClaw pins in the
  image; all other startup migrations and the upstream behavior outside
  NemoClaw are unchanged.

`scripts/patch-openclaw-device-self-approval.mts` remains required. Its new
shape recognizers preserve the bounded stored-device credential flow and keep
the canonical `approveDevicePairing` transaction fail closed.
Until the initial `devices list` succeeds, the startup auto-pair watcher keeps
the loopback shared token and sets a child-only marker. The compiled
gateway-call patch uses that marker only to retain the CLI device identity that
OpenClaw `2026.7.1` otherwise omits for loopback shared-token calls. OpenClaw
then performs its canonical silent local-pairing transaction and issues the
stored device token. Once that credential exists, the patch automatically
retains CLI identity on ordinary loopback shared-token calls; the upstream
local-backend omission remains unchanged. This restores device-scope
enforcement without moving the gateway credential into OpenClaw state.
After bootstrap, ordinary list and `devices approve` calls remove the gateway
URL, port, and shared token so the approval flow uses the stored device
credential.

A restored clone has one bounded exception while its server pairing state
exists but its client-auth state has not converged.
The preflight opens the clone-owned pending, paired, and identity files through
no-follow descriptors.
It accepts only one CLI operator transition that exactly matches the device ID,
public key, request ID, role, and allowed scopes.
The pairing-only operator token remains in the clone-owned
`devices/paired.json` until canonical rotation replaces it.
The wrapper reads the previous token from the pinned descriptor for preflight
and post-state comparison.
The approval child independently reads the inherited descriptor and holds the
token in memory only during the bounded pass.
The child passes the token to the pinned loopback gateway.
It removes shared gateway credentials and the configuration path, and it
disables pathname-backed device-auth reads and writes.
The live pairing list must match the descriptor-backed preflight before one
canonical approval can run.
OpenClaw reloads the state under its pairing lock and the version-scoped patch
requires the authenticated device token to match the operator token in both
the paired-device and stored-auth before-images.
It then rotates the token and records the pending, paired, and
`identity/device-auth.json` before- and after-images in the version 2
self-approval journal.
The canonical writer waits for all three state writes, commits the journal,
and replaces it with the idle form before the handler broadcasts the change
and responds.
If publication is interrupted, the next locked pairing-state read restores a
prepared journal or completes a committed journal across all three files.
On upgrade, that read also replaces an existing version 1 idle journal or
recovers its prepared or committed pairing snapshots before publishing the
version 2 idle form. Recovery accepts stored authentication only when it
matches the operator token and scopes in either version 1 snapshot, and it
derives the selected target credential from that validated paired-device
record.
Prepared and committed journal snapshots contain device tokens only in a
mode-`0600` file under a mode-`0700` directory. Approval returns success only
after the credential-free idle journal replaces those snapshots. If that final
rewrite fails, approval reports failure and the committed journal remains until
the next locked pairing-state read completes and clears it.
The wrapper then verifies the exact pending-to-paired transition and rewrites
the same rotated token to the clone's `identity/device-auth.json` with mode
`0600`; this remains a post-state verification boundary rather than the owner
of stored-auth synchronization.
The wrapper and approval child keep the old token in memory only for the
bounded pass.
Any pre-approval identity, state, transport, or live-preflight mismatch
prevents the approval call.
A post-state mismatch reports failure and does not treat the client credential
as synchronized.

## Transient Remote MCP Startup Recovery

`scripts/patch-openclaw-mcp-reliability.mts` is a version-scoped, fail-closed compatibility patch for issue #7958.
In `2026.7.1`, the compiled `bundle-mcp` session runtime turns one failed remote server startup into an empty tool set plus catalog diagnostics, caches that degraded catalog for the whole session, and never retries.
A single transient Streamable HTTP reset or MCP request timeout therefore removes an expected integration until the user starts a new session, and the agent can report the integration or its credentials as unavailable.

The patch identifies its target by the `"openclaw-bundle-mcp"` client identity and requires each rewritten anchor to appear exactly once.
An unrecognized compiled shape fails the image build instead of silently skipping and forces review before the patch can be updated or removed.
`--audit` re-verifies the applied state.

Reviewed behavior:

- One retry, and only one, for a server *startup* failure on a `streamable-http` transport.
  A refresh failure on an already-connected session is not retried.
- The retry uses a fresh transport from the upstream `resolveMcpTransport` factory after 120 to 299 ms of jitter, and caps its connection timeout at 10,000 ms so a dead server cannot double an agent run's worst-case latency.
  If fresh transport construction fails, the first diagnostic is preserved and NemoClaw does not claim that a retry occurred.
- Classification is a fail-closed allowlist over a bounded `cause` chain: MCP request timeout (`-32001`), the OpenClaw connect-timeout message, undici and POSIX in-flight transport codes, and reset/disconnect-before-headers text.
  A truncated or cyclic cause chain is unclassifiable and is not retried.
  A blocked-code and blocked-text pass runs first, so authentication, authorization, OAuth token rejection, TLS and certificate validation, SSRF and policy denial, and invalid configuration are never retried.
  A refused, unreachable, or unresolvable destination is deliberately excluded from the allowlist.
  An OpenShell L4 policy denial reaches the MCP client as a refused connection, so retrying refusals would risk retrying policy denials.
- An exhausted retry keeps the upstream diagnostic and appends a temporary-transport statement that states that credentials and configuration were not rejected, so the agent does not report missing credentials for a transport failure.
  That statement is added only when the *surviving* failure is itself transient.
  A retry that reaches the server and is then rejected with HTTP 401, a TLS error, or a policy denial keeps its own diagnostic.
- A catalog carrying a server diagnostic is not retained as the session's stable catalog.
  It is dropped at the next agent run boundary, in `acquireLease()` and only while the runtime is idle.
  Upstream fills `catalog.diagnostics` only from a per-server start or refresh failure and omits the key when no server produced a diagnostic, so a non-empty array is the degraded case and a healthy catalog is still reused.
  A credential, TLS, policy, or configuration rejection keeps its own diagnostic and is still never retried inside a run, but its catalog is not sticky either, so a repaired credential is picked up on the next agent run instead of requiring a new session.
  Scoping the drop to a run boundary rather than to every `getCatalog()` call is deliberate.
  `getCatalog()` is also the pre-flight for every `callTool`, `listResources`, `readResource`, `listPrompts`, and `getPrompt`, so dropping it on every call would rebuild the catalog per tool call and turn one unreachable optional server into a per-call reconnect cost.
  Optional MCP servers stay best-effort.
- The patch does not bypass or weaken credential, SSRF, OAuth, or network-policy enforcement.

A first version of this patch was rejected during review on two counts, both now covered by tests.
It retried an OpenShell L4 policy denial because undici reports it as `TypeError: fetch failed`, and it reported a retry that ended in HTTP 401 as a temporary transport failure that had not rejected credentials.

Coverage: `test/agents/openclaw/openclaw-mcp-reliability-patch.test.ts` pins the compiled preimage, patch idempotence, fail-closed rejection of an unrecognized shape, the classification table, and the retry and diagnostic behavior of the injected runtime.
`test/helpers/openclaw-real-mcp-start-retry-proof.ts` runs inside the `NEMOCLAW_REAL_OPENCLAW_DIST_HARNESS=1` harness and drives the real patched runtime against a controlled Streamable HTTP MCP server for three scenarios: first exchange resets then succeeds, every exchange resets, and a persistent 401.
The proof asserts that the rejected-credential scenario is contacted once per run, with no retry inside a run.

Removal criterion: drop this patch when the reviewed OpenClaw release provides equivalent bounded startup retry, negative-catalog invalidation, and temporary-transport failure attribution.

## Managed Outbound Transport Diagnostics

`scripts/patch-openclaw-managed-transport-diagnostics.mts` is a version-scoped, fail-closed compatibility patch for issue #7957.
In `2026.7.1`, a failed remote Streamable HTTP MCP request surfaces only the transport error text, such as `fetch failed` or a request timeout.
That text does not say whether policy evaluation, proxy CONNECT, TLS setup, the upstream connection, the request, or the response headers failed.
An operator therefore has to correlate agent output with OpenShell audit logs by hand.

The patch wraps the `fetch` passed to `StreamableHTTPClientTransport` and identifies the compiled target by the `"openclaw-bundle-mcp"` client identity.
It requires the rewritten anchor to appear exactly once.
The sibling SSE transport boundary is deliberately left unwrapped.
An unrecognized compiled shape fails the image build instead of silently skipping.
`--audit` re-verifies the applied state.

Reviewed behavior:

- Failure-only by default.
  A 2xx response returns untouched and emits nothing unless the OpenClaw gateway process has `NEMOCLAW_MCP_SHADOW_DIAGNOSTICS=1`.
- The opt-in shadow mode attempts to emit successful-request `managed_transport_shadow` timing events without reading their response bodies.
  It does not change a timeout, retry a request, alter a response, or persist samples across an OpenClaw process restart.
  Identifier generation, serialization, or standard-error output failure can omit an event without blocking the request or changing its response.
  Sandbox creation forwards only the literal value `1`, and only for OpenClaw.
- The wrapper never retries, never alters the request, never changes proxy selection, and never weakens TLS verification.
  It rethrows a transport error unchanged.
- `route=proxy_configured` means that `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, or `http_proxy` was configured.
  `route=unknown` means that the diagnostic did not observe one of those variables.
  These values report configuration evidence and do not prove whether the failed request used a proxy.
- For a non-2xx response, the wrapper returns the original response without waiting for asynchronous sampling of `response.clone()`.
  The diagnostic task waits at most 250 ms and retains at most 2,048 response bytes for an allowed content type.
  It limits the redacted `error_body` value to 2,048 UTF-8 bytes before JSON encoding.
- Non-2xx response diagnostics are best-effort.
  If detached collection fails, the wrapper still returns the original response and the diagnostic can be absent.
  The diagnostic can also be absent if the process exits before collection completes.
- The wrapper does not inspect a 2xx response body.
  This fetch boundary cannot classify a failure that occurs while the caller later reads that body.
- Response metadata is an allowlist: `content-type`, `retry-after`, `server`, `via`, `x-request-id`, `x-envoy-attempt-count`, `x-envoy-decorator-operation`, `x-envoy-response-flags`, and `x-envoy-upstream-service-time`.
  Emitted header keys use underscores.
  The wrapper does not access any other response header for diagnostics.
- Allowed header values, error bodies, and cause messages pass the same bounded redaction.
  It removes session identifiers, bearer tokens, known token prefixes, and structured credentials such as `access_token`, `refresh_token`, and `client_secret`.
- The cause chain is bounded to 8 entries and keeps only error name, code, errno, syscall, address family, port, and a redacted message.
  The peer address is not recorded.
- Session state is reported as a boolean.
  The `mcp-session-id` value is never emitted.
- The `transport_phase` field classifies a thrown failure as `policy`, `connect`, `tls`, `app_connect`, `response_headers`, or `request`.
  A policy denial takes precedence over its accompanying transport code.
  Without a higher-priority transport-phase signal, a thrown `UND_ERR_HEADERS_TIMEOUT` failure is classified as `response_headers`.
  That diagnostic has no response headers or `http_status` because `fetch` did not return a response.
- A returned non-2xx response sets `transport_phase=response_headers`.
  It carries `http_status` and any allowlisted response headers that are present.
- The wrapper parses only a string request body of at most 16,384 characters to report a validated JSON-RPC method.
  It never reports JSON-RPC parameters, tool names, tool arguments, or successful response bodies.
  An unsupported request shape reports `rpc/unknown`, and known GET and DELETE transport actions report `transport/listen` and `transport/close`.
- Each event reports the configured server name as `mcp_server` when validation and redaction retain it.
  It also reports the transport generation, the request sequence, and the resolved connection, request, catalog-list, and effective timeout budgets.
- Shadow recommendations apply only to `tools/list`.
  The wrapper retains up to 64 successful elapsed-time samples per target host and port and reports p95 after five samples.
  Different MCP URL paths on the same target host and port share this sample set because the wrapper does not retain URL paths.
  It proposes p95 times 1.5, rounded up to 100 ms, with a 1,500 ms floor and a 10,000 ms ceiling.
  A proposal cannot be less than the active catalog-list budget.
  The wrapper emits no recommendation when that active budget already exceeds 10,000 ms.
  A near-budget abort proposes twice the effective budget under the same constraints.
  An explicit HTTP 503 produces no timeout recommendation.
- The wrapper attempts to create a local 32-character hexadecimal `diagnostic_id` for each request before `fetch` starts.
  If identifier generation fails, the wrapper omits the field and continues the request.
  The wrapper does not add that identifier to the request.
- The wrapper is inert unless `OPENSHELL_SANDBOX=1`, so it does not change host-side behavior.

`diagnostic_id` is not a distributed trace identifier and does not correlate with an OpenShell audit event.
`NVIDIA/OpenShell#2508` tracks span emission from the sandbox supervisor. The OCSF schema vendored by the pinned OpenShell `0.0.99` includes the optional `http_request.uid` field, but OpenShell's Rust `HttpRequest` object and current HTTP audit-event builders neither expose nor populate it. A shared request identifier is therefore not emitted today.
The local identifier distinguishes application-side diagnostics, but operators still correlate each diagnostic with OpenShell audit events by endpoint and time.

Managed transport diagnostics remains separate from `scripts/patch-openclaw-mcp-reliability.mts`.
The diagnostics patch wraps every failed remote Streamable HTTP fetch and has its own exact-shape audit and removal condition.
The reliability patch owns startup catalog and retry behavior.
The two patches compose independently.

The injected helper in `scripts/patch-openclaw-managed-transport-diagnostics.mts` is the shipped runtime source of truth.
`test/agents/openclaw/openclaw-managed-transport-diagnostics-patch.test.ts` executes that exact helper.
It pins the compiled preimage, patch idempotence, fail-closed rejection of an unrecognized shape, and the untouched SSE boundary.
It also covers default failure-only emission, opt-in successful timing events, bounded shadow recommendations, explicit 503 exclusion, no-retry and unchanged-response contracts, validated operation reporting, asynchronous body sampling, byte and time bounds, redaction, the header allowlist, local diagnostic identifiers, session-presence reporting, transport-phase classification, route evidence, and sandbox gating.
A reusable source schema is deferred until a production consumer requires one.

Removal criterion: drop this patch when the reviewed OpenClaw release emits redacted diagnostics classified by transport phase for remote MCP fetch failures.

## Bounded MCP Tool Discovery Timeout

`scripts/patch-openclaw-mcp-tools-list-timeout.mts` is a version-scoped, fail-closed compatibility patch.
The transport symptoms investigated in issue #7957 motivated this bounded follow-up; the patch does not change that issue's diagnostics acceptance criteria.
OpenClaw `2026.7.1` gives `tools/list` 1,500 ms unless an MCP server configuration supplies a request timeout.
The managed mcporter registration does not expose a tool-discovery-only timeout.

The patch identifies the compiled target by the `"openclaw-bundle-mcp"` client identity.
It requires the 1,500 ms constant and the complete catalog-timeout resolver to appear exactly once.
An unrecognized compiled shape fails the image build.
`--audit` re-verifies the applied state.

Reviewed behavior:

- An unset or blank `NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_MS` value adds no override.
  OpenClaw then uses a server-specific request timeout when configured and otherwise uses its 1,500 ms fallback.
- NemoClaw forwards the setting only to an OpenClaw sandbox.
  Host-side validation trims surrounding whitespace, accepts the remaining canonical integer from 1,500 through 10,000 ms, forwards normalized digits, and rejects an invalid value before the sandbox create step, including the replacement create step during rebuild.
- The injected runtime parser repeats the range and integer checks.
  It ignores the host-side setting unless `OPENSHELL_SANDBOX=1` and stops module initialization for an invalid direct runtime value.
- A valid override takes precedence over the server request timeout only for catalog `tools/list` requests.
  It does not change the 30,000 ms connection timeout or the 60,000 ms default used by tool calls and other MCP requests.
- OpenClaw writes one `mcp_tools_list_timeout_override_ms` line when the MCP runtime loads with an override.
  The default path emits no additional log line.
- The existing OpenClaw test-only timeout setter keeps first precedence so upstream runtime tests retain their isolation control.
- The build patch runs only for OpenClaw `2026.7.1`.
  It skips the reviewed `2026.3.11` and `2026.4.24` stale-upgrade E2E fixture versions before bundle discovery and rejects every other version.

`test/agents/openclaw/openclaw-mcp-tools-list-timeout-patch.test.ts` executes the injected parser and pins the compiled preimage.
It covers patch idempotence, fail-closed drift rejection, host and sandbox gates, bounds, invalid values, and composition with managed transport diagnostics.
`src/lib/onboard/sandbox-create-launch.test.ts` covers canonical forwarding, range rejection, and exclusion from Hermes and Deep Agents Code sandboxes.

Removal criterion: drop this patch when the reviewed OpenClaw release provides an equivalent bounded `tools/list`-only runtime setting.

## Gateway Startup Migration Compatibility

OpenClaw `2026.7.1` requires its migration checkpoint to complete without
warnings before the gateway reports readiness.
NemoClaw keeps supported sandbox upgrades compatible with that checkpoint as
follows:

- the final image copies Node `22.23.1` from the builder, including when the
  image layers onto a published base that still contains Node `22.22.2`;
- new images do not seed the legacy `update-check.json` placeholder.
  During an upgrade, the descriptor-pinned config helper removes this obsolete
  update polling and notification cache whether it is empty or populated when
  the entrypoint can mutate the parent. A non-root gateway under the exact
  root-owned shields-up topology retains the stable cache because it cannot
  unlink it; the patched OpenClaw migration ignores that non-authoritative
  pinned-version cache without producing a startup warning.
  Without the compatibility patch, OpenClaw would try to harden and archive the
  retained cache inside a shields-protected parent. Symbolic links, hard links,
  directories, oversized files, or a file that changes during validation are
  rejected;
- a root entrypoint starts the `gateway` user with `HOME=/sandbox`, so startup
  migrations do not probe the inaccessible `/root/.openclaw` path.

Installed-base coverage is the `v0.0.89-x86_64` row in the
`openshell-gateway-upgrade` E2E matrix. It installs the immutable v0.0.89
release with OpenClaw `2026.6.10`, seeds its legacy Memory Core SQLite and
update-check state plus a durable marker in the per-agent database materialized
by the legacy CLI, then upgrades through the current installer. The row proves
the per-agent database survives intact, the global database remains healthy,
the legacy sidecar migration and `2026.7.1` startup checkpoint complete, and
the restored `apiKey: "unused"` config still receives its gateway-held
credential only at the OpenShell boundary.
This custom route supplies `COMPATIBLE_API_KEY` only to the frozen v0.0.89
install, then deliberately withholds it from the current installer so the
post-upgrade turn proves the existing gateway-held credential was reused. The
frozen runtime intentionally creates no NVIDIA auth-profile key reference; the
E2E preserves any references that do exist without inventing one for this route.

During image assembly, the shared-state repair rejects symbolic links,
non-regular entries, and multiply linked files before it changes the ownership
or mode of `exec-approvals.json` or SQLite state. This prevents a stale image
entry from redirecting those mutations to another path or inode.

These repairs run during image build or sandbox startup.
They do not change the documented update and rebuild workflow.
Regression coverage lives in `test/agents/openclaw/openclaw-2026-7-startup-compat.test.ts` and
`test/agents/openclaw/openclaw-shared-state-permissions-patch.test.ts`.
Remove the legacy cache repair after every supported upgrade source stops
seeding the file or OpenClaw can migrate it across split users and a protected
parent without a warning.

## Gateway Security Audit Suppression Boundary

NemoClaw's generated OpenClaw audit configuration keeps intentional loopback
`allowInsecureAuth` findings and provenance-known loopback device-auth opt-out
findings visible as accepted findings.
`test/generate-openclaw-config-security-audit.test.ts` locks the generated
suppression scope, and `test/agents/openclaw/openclaw-security-audit-suppressions-real.test.ts`
locks the pinned OpenClaw check IDs and details.
`test/e2e/live/dashboard-remote-bind.test.ts` proves that a clean-host remote
bind leaves the device-auth, insecure-auth, and Host-header fallback findings
active.

Remove the `allowInsecureAuth` suppressions only after the pinned OpenClaw audit
contract proves that OpenClaw natively classifies intentional loopback
development HTTP without them, or after NemoClaw onboarding defaults
`CHAT_UI_URL` to `https://localhost` with a generated local certificate.
Remove the device-auth suppressions only after managed onboarding no longer
applies the loopback device-auth compatibility opt-out.

## Existing security and runtime contracts

The OpenClaw Diagnostics OTEL Host Gateway Boundary remains unchanged. The
`openclaw-diagnostics-otel-local` policy is limited to the diagnostics plugin,
which imports `OTLPTraceExporter` and contains no `web_fetch`, `fetchWithSsrFGuard`
call path.

Messaging contracts remain pinned to the reviewed runtime shapes:

- `dist/pipeline.runtime-*.js`, which exports `prepareSlackMessage`;
- the preload imports the hashed pipeline runtime for `prepareSlackMessage` and
  only reports `openclaw-pipeline-runtime` after allowed prepare;
- `dist/extensions/telegram/runtime-api.js`, which exports `sendMessageTelegram`;
- runtime validation fails closed if the installed runtime file is missing;
- tests reject claiming `openclaw-pipeline-runtime` inbound proof when a fixture
  imports `dist/extensions/telegram/test-api.js`.

Legacy upgrade fixtures remain gated behind
`NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1`. The
`scripts/check-production-build-args.sh` guard rejects those fixture-only
production build args.

## Issue #4434 full live acceptance

`scripts/patch-openclaw-issue-4434-diagnostics.mts` and
`test/e2e-runtime/issue-4434-error-fields.test.ts` remain tied to the gateway/upstream
reporting layer. The #4434 compatibility-shim disposition is explicitly accepted
for this release. 3/3 fields are present in the NemoClaw-patched runtime output,
while 3/3 fields are missing in the upstream-shaped `openclaw@2026.7.1` output.

The live acceptance requires the recovery text:
`Recovery hint: check sandbox egress and provider reachability, then retry.`
The focused live guard retains its default 180-second timeout.
