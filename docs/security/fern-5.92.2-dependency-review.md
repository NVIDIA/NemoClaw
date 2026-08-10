<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fern 5.92.2 dependency review

Review date: 2026-08-10

## Decision

Pin the documentation tool to `fern-api@5.92.2`.
This replaces `5.80.1` without changing a supported NemoClaw runtime or product integration.
Production, staging, pull-request preview, validation, and local preview commands continue to read the version from `fern/fern.config.json`.

The upgrade spans 26 adjacent published versions and 188 source commits.
The review found no unresolved high-severity concerns.
The accepted residuals are properties of the upstream package: its optional BAML dependency uses a compatible range, its provenance does not include an SBOM or complete build dependency graph, and an authorized Fern organization policy can constrain the configured CLI version.
The resolved dependency closure is identical for `5.80.1` and `5.92.2` except for the root package version and integrity.

## Reviewed identities

The npm registry is the artifact authority.
Fern does not publish semantic Git tags for these CLI versions, so the npm provenance source commits define the release boundaries.

| Identity | Value |
| --- | --- |
| Current package | `fern-api@5.80.1` |
| Current source commit | `76de91e1216afbdb56a36d3389ee6b91d3e59a9e` |
| Current integrity | `sha512-1GZglZnA8T1JogREverqNwIY5G9e3e6uRHv1bpMjX0iIJVr+Dh+5MMPSBq6NegTmBjppqRHF6PVNbnuuO9VfRA==` |
| Target package | `fern-api@5.92.2` |
| Target source commit | `ac0f7cf4247e8bcab09bef82be01b083d83f502e` |
| Target integrity | `sha512-a6mpETDVxEAABuBTMbo0my/Z8PGZBWvs95MCFnHUhWQne5fLbNSri/2FJrsLOZBhuBJ7MLg9ebpnCTE4kywoVA==` |
| Target SHA-1 | `a8b9bd143c2ad08b704eee9b4b331fd60c3f92fc` |
| Target publish time | `2026-08-10T18:16:30.536Z` |
| Target provenance workflow | `.github/workflows/publish-cli.yml` |
| Target provenance run | `31417180222`, attempt `1`, successful push to `main` |

The current and target archives each contain only `cli.cjs`, `package.json`, and `LICENSE`.
`cli.cjs` is the only executable.
Neither archive contains links, devices, unsafe paths, install scripts, a `NOTICE` file, or an SBOM.
Both packages declare Apache-2.0 and expose `fern` through `cli.cjs`.

`npm audit signatures` reports four verified registry signatures and three verified attestations for each installed graph.
The npm signatures and SLSA provenance bind the registry artifacts to the source commits above.
The target producer run completed successfully with the attested source commit on `main`.

## Complete source range ledger

Every adjacent comparison is contiguous: each target is ahead of its source with `behind_by=0`.
The audit used the npm registry and official GitHub API because Fern does not publish semantic Git tags for these CLI releases.

| Range and source commits | Commits | NemoClaw-relevant change |
| --- | ---: | --- |
| `5.80.1` (`76de91e`) to `5.80.2` (`69d9ca2`) | 28 | Global header client defaults; NemoClaw has no Fern API or generator manifest. |
| `5.80.2` (`69d9ca2`) to `5.80.3` (`f1c26f6`) | 17 | Generator CLI release; no NemoClaw generator consumer. |
| `5.80.3` (`f1c26f6`) to `5.80.4` (`efd172d`) | 3 | Local filesystem package identity; no NemoClaw package generation. |
| `5.80.4` (`efd172d`) to `5.80.5` (`7d6ac2d`) | 12 | Markdown images with titles parse correctly; current docs validation covers the affected parser. |
| `5.80.5` (`7d6ac2d`) to `5.81.0` (`134b13f`) | 6 | OAuth authorization and device-code intermediate representation; no NemoClaw API import. |
| `5.81.0` (`134b13f`) to `5.82.0` (`81643fc`) | 6 | Fern organizations can set minimum and maximum CLI versions. |
| `5.82.0` (`81643fc`) to `5.83.0` (`13f9894`) | 10 | OAuth redirect backup ports; no NemoClaw API generation. |
| `5.83.0` (`13f9894`) to `5.83.1` (`82128f8`) | 2 | OpenRPC example paths; no NemoClaw OpenRPC input. |
| `5.83.1` (`82128f8`) to `5.84.0` (`d56b12b`) | 4 | New `fern generate --pack` command; NemoClaw does not call it. |
| `5.84.0` (`d56b12b`) to `5.85.0` (`76d9f33`) | 6 | Go source ZIP package artifacts; no NemoClaw package generation. |
| `5.85.0` (`76d9f33`) to `5.86.0` (`72fd74f`) | 8 | Optional OpenAPI `preserve-one-of-in-all-of`; absent from NemoClaw configuration. |
| `5.86.0` (`72fd74f`) to `5.87.0` (`3f8e1aa`) | 1 | Optional playground `send-optional-defaults`; absent from NemoClaw configuration. |
| `5.87.0` (`3f8e1aa`) to `5.88.0` (`4216575`) | 2 | OAuth public-client login flows; no NemoClaw API generation. |
| `5.88.0` (`4216575`) to `5.89.0` (`36c80ab`) | 2 | Renames `--pack` to `--package`; NemoClaw calls neither flag. |
| `5.89.0` (`36c80ab`) to `5.89.1` (`3cb7f88`) | 5 | Named preview listing through `fern docs preview list --id`; NemoClaw does not call the list command. |
| `5.89.1` (`3cb7f88`) to `5.89.2` (`684e1c1`) | 2 | OpenAPI null-branch propagation; no NemoClaw OpenAPI input. |
| `5.89.2` (`684e1c1`) to `5.89.3` (`64c0ccb`) | 6 | Dotted operation identifiers collapse; no NemoClaw API generation. |
| `5.89.3` (`64c0ccb`) to `5.89.4` (`2861fa8`) | 4 | Markdown substitution after a literal `<`; current docs validation covers the affected parser. |
| `5.89.4` (`2861fa8`) to `5.89.5` (`c9052e8`) | 16 | Runnable package artifacts; no NemoClaw package generation. |
| `5.89.5` (`c9052e8`) to `5.89.6` (`c86bda4`) | 2 | Local automatic-version placeholder; no NemoClaw generator consumer. |
| `5.89.6` (`c86bda4`) to `5.90.0` (`8867c45`) | 9 | Git library references and override-parameter merging; absent from NemoClaw configuration. |
| `5.90.0` (`8867c45`) to `5.90.1` (`2c610cb`) | 5 | PHP local-filesystem package version; no NemoClaw package generation. |
| `5.90.1` (`2c610cb`) to `5.91.0` (`ce38a5c`) | 8 | Adds MCP installation, Git-ref docs versions, and request-body import fixes; NemoClaw does not use those inputs or commands. |
| `5.91.0` (`ce38a5c`) to `5.92.0` (`6c85294`) | 3 | Optional request-body examples; no NemoClaw API import. |
| `5.92.0` (`6c85294`) to `5.92.1` (`2929ecd`) | 19 | Java package-name resolution; no NemoClaw package generation. |
| `5.92.1` (`2929ecd`) to `5.92.2` (`ac0f7cf`) | 2 | Inline `oneOf` discriminant inference; no NemoClaw API import. |

## Dependency closure and advisory result

Lifecycle scripts were disabled while materializing both exact graphs.
Each resolved graph contains 11 package identities: `fern-api`, `@boundaryml/baml`, eight platform-specific BAML packages, and `@scarf/scarf`.
Both graphs resolve BAML packages at `0.219.0` and Scarf at `1.4.0`.
The BAML packages are MIT, and Scarf is Apache-2.0.
`npm audit --omit=dev` reports zero info, low, moderate, high, or critical findings for both graphs.

The package declares optional `@boundaryml/baml@^0.219.0`, so a future fresh `npx` install can select a later compatible BAML release.
This is a pre-existing reproducibility residual.
The resolved BAML package depends on `@scarf/scarf@1.4.0`, which declares `postinstall: node ./report.js` and enables installation analytics by default.
Every NemoClaw Fern `npx` consumer passes `--ignore-scripts`, so npm does not execute that lifecycle script during local validation, preview, or publication.
NemoClaw pins Fern exactly, uses it only as contributor and CI documentation tooling, and does not ship this graph in its CLI, plugin, blueprint, or runtime images.

## Downstream contract audit

`fern/fern.config.json` remains the single repository version authority.
The `docs:deps`, `docs:validate`, `docs:live`, and preview-watcher npm scripts read that file before constructing a `fern-api@<version>` selector.
Public publication, staging publication, pull-request previews, and staging preview deletion use the same selector.
No lockfile, generated manifest, workflow input, cache key, or runtime image contains a second production Fern version.

Starting in `5.82.0`, Fern can clamp the configured version to organization-level minimum and maximum bounds.
The authoritative `nvidia` Fern organization owns those bounds, and the CLI fails open to the repository version when the bounds service is unavailable.
This centralized constraint does not let repository content or an untrusted contributor select another package.

NemoClaw has no Fern API definition or generator manifest.
Its Fern tree contains docs configuration, theme assets, components, and CSS.
OpenAPI, OpenRPC, OAuth, webhook, SDK generator, and package-generation changes therefore do not affect a shipped artifact.
NemoClaw does not call the new MCP, package, preview-list, or Git-ref versioning commands.

## Concern ledger

| ID | Severity | Failure mode | Evidence and disposition |
| --- | --- | --- | --- |
| `FERN-1` | Medium | Organization version bounds could select a different CLI than the repository pin. | Only the authenticated `nvidia` Fern organization controls the bounds. The CLI fails open to the reviewed repository version when the service is unavailable, so this is an accepted centralized-policy constraint. |
| `FERN-2` | Medium | Markdown parser changes could reject or reinterpret current MDX. | `npm run docs` passes with `5.92.2`, which resolves the concern for current source pages and generated guide variants. |
| `FERN-3` | Medium | Preview command changes could alter preview creation or deletion. | NemoClaw does not call the changed list command. Focused preview and staging workflow tests pass with the exact selector, which resolves the concern. |
| `FERN-4` | Low | New docs or generator options could change output by default. | The changed options are absent from NemoClaw configuration, and NemoClaw has no API or generator manifest. |
| `FERN-5` | Medium | The target archive or dependency graph could be substituted or add a vulnerable package. | Registry integrity, npm signatures, SLSA provenance, producer success, archive structure, licenses, dependency closure, and both advisory audits were verified. |
| `FERN-6` | Low | A second selector could leave publication or local validation on `5.80.1`. | Repository searches and focused workflow tests show that active consumers read `fern/fern.config.json`. |
| `FERN-7` | Low | A cache or migration could retain incompatible Fern state. | Fern caches and generated docs are disposable build outputs with no product state or rollback migration. |
| `FERN-8` | Medium | A fresh Fern resolution could execute Scarf analytics while a publication job holds `FERN_TOKEN`. | Every Fern `npx` consumer passes `--ignore-scripts`, and the dependency-review test rejects a consumer that omits the flag. This blocks the Scarf lifecycle script and future package lifecycle scripts. |
| `FERN-9` | Low | Docs-only validation could omit a runtime product regression. | Fern does not run in a NemoClaw sandbox or shipped runtime. Docs validation and workflow contract tests are the applicable evidence. |

Unresolved high-severity concerns: `0`.

## Verification and remaining gates

Completed local evidence:

- 26 adjacent source ranges and 188 commits reviewed;
- target SHA-1 and SHA-512 matched the published archive;
- package structure and licenses inspected without executing lifecycle scripts;
- npm signatures and SLSA provenance verified for current and target;
- the target producer run completed successfully at the attested source commit;
- current and target dependency closures compared;
- current and target advisory audits reported zero findings;
- focused dependency-review, docs-route, variant, preview, and staging workflow tests passed;
- `npm run docs` passed with `fern-api@5.92.2`, zero errors, and one light-theme contrast warning.

The warning reports a 2.41:1 ratio between the light-theme accent and background colors, below Fern's recommended 3:1 ratio.
The warning predates this upgrade and remains a theme-accessibility follow-up; it does not identify a changed `5.92.2` contract.

GitHub CI, Fern publication, and Fern preview remain external gates.
No live E2E, sandbox build, migration, rollback, compatibility shim, or release entry is required because Fern is not part of a supported runtime or user-visible product behavior.
