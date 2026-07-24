<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fern 5.80.1 dependency review

Review date: 2026-07-23

## Decision

Pin the documentation tool to `fern-api@5.80.1`.
This replaces `5.72.1` without changing a supported NemoClaw runtime or product integration.
All production, staging, pull-request preview, validation, and local preview commands read the exact version from `fern/fern.config.json`.

The upgrade spans 21 adjacent published versions and 225 source commits.
The review found no unresolved high-severity concerns.
The only accepted residuals are pre-existing properties of the upstream package: its optional BAML dependency uses a compatible range, and its provenance does not include an SBOM or the complete build dependency graph.
The point-in-time dependency closure is identical for `5.72.1` and `5.80.1` except for the root package version and integrity.

## Reviewed identities

The npm registry is the artifact authority.
Fern does not publish semantic Git tags for these CLI versions, so the npm provenance source commits define the release boundaries.

| Identity | Value |
| --- | --- |
| Current package | `fern-api@5.72.1` |
| Current source commit | `238ff9d037fc7653661a6850dc6dab47712b5bfb` |
| Current integrity | `sha512-b8qOEZ5vYQ7k0cbQMlS9sLEqyj0mdA+bjDZAPHqd5CpMeNO1tgFMp8shFLGVS7FHxUNmjxOVLxyXnduwTe3tuQ==` |
| Target package | `fern-api@5.80.1` |
| Target source commit | `76de91e1216afbdb56a36d3389ee6b91d3e59a9e` |
| Target integrity | `sha512-1GZglZnA8T1JogREverqNwIY5G9e3e6uRHv1bpMjX0iIJVr+Dh+5MMPSBq6NegTmBjppqRHF6PVNbnuuO9VfRA==` |
| Target SHA-1 | `a06a295390f91b8bbd42de56d0d481f545642595` |
| Target publish time | `2026-07-23T19:39:21.720Z` |
| Target provenance workflow | `.github/workflows/publish-cli.yml` |
| Target provenance run | `30038076483`, attempt `1`, successful push to `main` |

The current and target archives each contain only `cli.cjs`, `package.json`, and `LICENSE`.
`cli.cjs` is the only executable.
Neither archive contains links, devices, unsafe paths, install scripts, a `NOTICE` file, or an SBOM.
Both packages declare Apache-2.0 and expose `fern` through `cli.cjs`.

`npm audit signatures` reports zero invalid and zero missing signatures for both installed graphs.
Their npm signatures and SLSA provenance bind the registry artifacts to the source commits above.
The target provenance run completed successfully with the attested head commit on `main`.

## Complete source range ledger

Every adjacent comparison is contiguous: each target is ahead of its source with `behind_by=0`, and local ancestry checks agree.
A full sanitized upstream clone passed `git fsck --full --strict`; no upstream code was executed.

| Range and source commits | Commits | NemoClaw-relevant change |
| --- | ---: | --- |
| `5.72.1` (`238ff9d`) to `5.73.0` (`60a6649`) | 15 | GitHub OIDC variables reach local generator containers; NemoClaw does not use this generator path. |
| `5.73.0` (`60a6649`) to `5.74.0` (`0ed4690`) | 15 | Webhook body hashes; no NemoClaw API or webhook generation. |
| `5.74.0` (`0ed4690`) to `5.74.1` (`63b552f`) | 2 | Generator attribution fix; no NemoClaw generator manifest. |
| `5.74.1` (`63b552f`) to `5.74.2` (`9b116de`) | 10 | OpenAPI union import fix; NemoClaw publishes documentation only. |
| `5.74.2` (`9b116de`) to `5.74.3` (`5802970`) | 13 | Internal docs publish logs move from info to debug; exit behavior is unchanged. |
| `5.74.3` (`5802970`) to `5.75.0` (`ec8bd05`) | 2 | Optional smart casing, disabled by default and absent from NemoClaw config. |
| `5.75.0` (`ec8bd05`) to `5.75.1` (`ddc0b4e`) | 22 | Theme uploads use an organization-scoped content-addressed path and explicit origin precedence. |
| `5.75.1` (`ddc0b4e`) to `5.75.2` (`c378ff0`) | 2 | Import warning for unmapped unions; no NemoClaw API import. |
| `5.75.2` (`c378ff0`) to `5.75.3` (`c4f032d`) | 2 | OpenAPI `allOf` example performance; no NemoClaw API import. |
| `5.75.3` (`c4f032d`) to `5.75.4` (`94fd7e3`) | 3 | `fern check` compiles MDX and reports malformed MDX as warnings. |
| `5.75.4` (`94fd7e3`) to `5.75.5` (`02364eb`) | 20 | Faster content-only reloads for `fern docs dev`; publish behavior is unchanged. |
| `5.75.5` (`02364eb`) to `5.75.6` (`36b3a5e`) | 15 | PHP package naming; no NemoClaw generator manifest. |
| `5.75.6` (`36b3a5e`) to `5.75.7` (`527c2ca`) | 3 | Generator changelog and header fix; no NemoClaw generator manifest. |
| `5.75.7` (`527c2ca`) to `5.75.8` (`474447f`) | 2 | Multi-API environment grouping; no NemoClaw API configuration. |
| `5.75.8` (`474447f`) to `5.75.9` (`bfa7994`) | 2 | Generator-specific follow-up; no NemoClaw generator manifest. |
| `5.75.9` (`bfa7994`) to `5.76.0` (`5416ce9`) | 3 | Webhook URL normalization; no NemoClaw webhook generation. |
| `5.76.0` (`5416ce9`) to `5.77.0` (`c031254`) | 34 | Optional OpenAPI tag filtering; no NemoClaw API import. |
| `5.77.0` (`c031254`) to `5.78.0` (`db64dc1`) | 7 | OpenAPI path-parameter deconfliction; no NemoClaw API import. |
| `5.78.0` (`db64dc1`) to `5.79.0` (`1d6a7e7`) | 6 | Optional external sitemaps; absent from NemoClaw config. |
| `5.79.0` (`1d6a7e7`) to `5.80.0` (`35b6f73`) | 26 | Optional navigation availability badges, disabled by default and absent from NemoClaw config. |
| `5.80.0` (`35b6f73`) to `5.80.1` (`76de91e`) | 21 | Preserve nested `allOf` descriptions in generated API docs; no NemoClaw API import. |

The repository's documented release-ledger collector is not present on the reviewed `main` branch.
The audit therefore used equivalent read-only npm registry and GitHub API evidence plus the sanitized local clone.
This method exception changes how the ledger was collected, not its release boundaries or coverage.

## Dependency closure and advisory result

Lifecycle scripts were disabled while materializing both exact graphs.
Each graph contains 11 packages:

- `@boundaryml/baml@0.219.0`;
- eight matching `@boundaryml/baml-*` platform packages at `0.219.0`;
- `@scarf/scarf@1.4.0`;
- the selected `fern-api` version.

All transitive versions and licenses are identical between current and target.
The BAML packages are MIT and Scarf is Apache-2.0.
`npm audit --omit=dev` reports zero info, low, moderate, high, or critical findings for both graphs.

The package declares optional `@boundaryml/baml@^0.219.0`, so a future fresh `npx` install could select a later compatible BAML release.
This is a pre-existing reproducibility residual, not a change introduced by `5.80.1`.
NemoClaw pins Fern exactly, uses it only as contributor and CI documentation tooling, and does not ship this graph in its CLI, plugin, blueprint, or runtime images.

## Downstream contract audit

`fern/fern.config.json` is the single version authority.
The following consumers all read that file before constructing an exact `fern-api@<version>` selector:

- the `docs:deps`, `docs:validate`, `docs:live`, and `docs:preview:watch` npm scripts;
- public and staging publication;
- pull-request previews;
- staging preview deletion.

No lockfile, generated manifest, workflow input, environment default, cache key, or runtime image contains a second production Fern version.
The synthetic `3.67.1` in `test/fern-preview-config.test.ts` is an opaque unit-test input, not a production selector.

NemoClaw has no Fern API definition or generator manifest.
Its Fern tree contains only the docs configuration, theme assets, components, and CSS.
Consequently, the OpenAPI, webhook, SDK generator, and multi-API changes in the range cannot affect a shipped artifact.

The CLI emits human-readable logs, but NemoClaw does not parse them.
Workflows use the process exit status; the pull-request preview workflow captures output only to publish the preview URL.
The upstream log-level reduction therefore does not change a machine-consumed contract.

## Concern ledger

| ID | Severity | Failure mode | Evidence and disposition |
| --- | --- | --- | --- |
| `FERN-1` | Medium | Changed publish logging could break an output parser | No consumer parses publish log text; exit status and preview URL behavior remain authoritative, so there is no impact. |
| `FERN-2` | Medium | MDX compilation during `fern check` could expose invalid current docs | `npm run docs` passes with the target CLI, and current and target report the same two pre-existing warnings and zero errors, which resolves the concern with runtime proof. |
| `FERN-3` | Medium | Theme upload or preview behavior could target the wrong organization or URL | Upstream adds organization scoping and regression tests, while NemoClaw's staging deletion workflow remains covered with executed fake-CLI arguments as runtime proof. |
| `FERN-4` | Low | Incremental local preview state could serve stale content | The change is limited to `docs dev` content reloads, does not persist release state, and leaves local preview as an advisory developer surface, so there is no impact. |
| `FERN-5` | Low | New sitemap or navigation options could change the published site by default | Both settings are optional, availability badges default to false, and neither key is present in `fern/docs.yml`, so there is no impact. |
| `FERN-6` | Low | API importer and generator changes could alter generated SDK or API documentation | NemoClaw has no Fern API definition or generator manifest, so there is no impact. |
| `FERN-7` | Medium | The target archive or dependency graph could be substituted or add a vulnerable package | Registry integrity, npm signatures, SLSA provenance, the successful producer run, archive structure, licenses, and both exact graphs were verified, which resolves the concern. |
| `FERN-8` | Low | A hard-coded test version could drift from the production version authority | The staging workflow test now derives its expected exact selector from `fern/fern.config.json`, which resolves the concern. |
| `FERN-9` | Low | A persisted cache or migration could retain incompatible Fern state | Fern caches and generated docs are disposable build outputs with no migration, rollback data, or product state, so there is no impact. |
| `FERN-10` | Low | Live sandbox E2E exclusion could leave a runtime behavior untested | Fern is docs-only tooling that never runs inside a NemoClaw sandbox, so docs validation and workflow contract tests are the relevant lanes and live E2E is excluded. |

Unresolved high-severity concerns: `0`.

## Verification and remaining gates

Completed audit evidence:

- 21 adjacent source ranges and 225 commits reviewed;
- target SHA-1 and SHA-512 matched the downloaded archive;
- package structure and licenses inspected without executing upstream code;
- npm signatures and SLSA provenance verified for current and target;
- source provenance runs checked for successful completion and matching heads;
- full current and target dependency closures compared;
- current and target advisory audits reported zero findings.
- six focused dependency-review and staging workflow tests passed;
- source-shape validation reported no unapproved source-shape tests;
- Vitest project membership was exact across all eight projects;
- `npm run docs` passed with `fern-api@5.80.1`.
- `npm run check:diff` passed after generating the isolated worktree's local compiled artifacts.

`fern check --warnings` reports zero errors and the same two warnings under both `5.72.1` and `5.80.1`: unauthenticated local validation cannot check remote redirects, and the existing light-theme accent contrast is 2.41:1.
Neither warning is introduced by this dependency change.
Authenticated publication and preview checks remain GitHub gates.

Before merge, the reviewed PR head must still pass:

- normal commit hooks and required GitHub checks;
- automated review with no unresolved actionable finding;
- documentation writer review tied to the final pushed head.

No live E2E, sandbox build, migration, rollback, compatibility shim, or changelog entry is required because the dependency is not part of a supported runtime or user-visible product behavior.
