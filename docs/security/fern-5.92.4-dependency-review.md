<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Fern 5.92.4 Dependency Review

Review date: 2026-08-10

## Decision

Pin the documentation tool to `fern-api@5.92.4`.
This replaces `5.80.1` without changing a supported NemoClaw runtime or product integration.
All production, staging, pull-request preview, validation, and local preview commands read the version from `fern/fern.config.json`.

The upgrade spans 194 contiguous source commits.
The review found no unresolved high-severity concerns.
The archive structure, dependency closure, lifecycle-script surface, and licenses are unchanged.
The Fern root package version, archive bytes, and integrity values differ.
Versions `5.92.3` and `5.92.4` correct Markdown image destinations with bracketed alternative text and angle-bracket delimiters, so `5.92.4` is the reviewed target.

## Reviewed Identities

The npm registry is the artifact authority.
Fern does not publish semantic Git tags for these CLI versions, so npm provenance identifies the source revisions.

| Identity | Value |
| --- | --- |
| Current package | `fern-api@5.80.1` |
| Current source commit | `76de91e1216afbdb56a36d3389ee6b91d3e59a9e` |
| Current integrity | `sha512-1GZglZnA8T1JogREverqNwIY5G9e3e6uRHv1bpMjX0iIJVr+Dh+5MMPSBq6NegTmBjppqRHF6PVNbnuuO9VfRA==` |
| Target package | `fern-api@5.92.4` |
| Target source commit | `f501eb09d3a31776d54beaa70346af4174d09664` |
| Target integrity | `sha512-+vOR7M+G98poLJTSnyx2gw3Si+5AT/cTF7yRAdFst+977+DsTxWmUDx4RtajvR75EFqEOERwUcmDDUa2vCUerw==` |
| Target SHA-1 | `fd89c28f9f72d41be7d0a021da3a0136f88027c9` |
| Target publish time | `2026-08-10T22:34:31.983Z` |
| Target provenance workflow | `.github/workflows/publish-cli.yml` |
| Target provenance run | `31437991221`, attempt `1`, successful push to `main` |

The current and target archives each contain only `cli.cjs`, `package.json`, and `LICENSE`.
`cli.cjs` is the only executable.
Neither archive contains links, devices, unsafe paths, install scripts, a `NOTICE` file, or an SBOM.
Both archives include an Apache-2.0 license and expose `fern` through `cli.cjs`.

`npm audit signatures` reports verified registry signatures for all four packages installed on the review host and verified attestations for three.
The target npm provenance binds the registry artifact to the source revision and a successful GitHub-hosted publication run on `main`.

## Complete Source Range Ledger

Every range is contiguous, reports `behind_by=0`, and starts at the preceding range's endpoint.
The five ranges cover all 194 commits between the reviewed packages.

| Range | Commits | NemoClaw-relevant change |
| --- | ---: | --- |
| `5.80.1` to `5.80.5` | 60 | Markdown image titles resolve correctly. Generator and API import changes do not apply to the NemoClaw docs-only configuration. |
| `5.80.5` to `5.86.0` | 42 | The CLI adds packaging, organization bounds, and OpenAPI options that NemoClaw does not invoke. |
| `5.86.0` to `5.89.6` | 40 | Named preview listing and Markdown substitution improve commands that NemoClaw uses. OAuth login and package-generation paths remain unused. |
| `5.89.6` to `5.92.2` | 46 | Git-ref docs versioning, MCP installation, and importer changes are inactive because NemoClaw does not configure or invoke them. Optional-request-body fixes do not affect this docs tree. |
| `5.92.2` to `5.92.4` | 6 | Markdown images with bracketed alternative text and angle-bracket destinations resolve correctly. |

The published CLI source manifest adds only development dependencies for ZIP typing and implementation.
The published package still declares only the optional `@boundaryml/baml@^0.219.0` dependency.

## Dependency Closure and Advisory Result

Lifecycle scripts were disabled while materializing the current and target graphs.
Each graph contains 11 packages:

- `@boundaryml/baml@0.219.0`;
- eight matching `@boundaryml/baml-*` platform packages at `0.219.0`;
- `@scarf/scarf@1.4.0`;
- the selected `fern-api` version.

All transitive versions and licenses are identical between current and target.
The BAML packages use the MIT license, and Scarf uses Apache-2.0.
`npm audit --omit=dev` reports zero info, low, moderate, high, or critical findings for both graphs.

The package still declares optional `@boundaryml/baml@^0.219.0`, so a future fresh `npx` install can select another compatible `0.219.x` release.
The currently resolved graph remains `0.219.0`.
This is a pre-existing reproducibility residual, not a change introduced by `5.92.4`.

`@scarf/scarf@1.4.0` still has a best-effort postinstall telemetry script inherited through BAML.
The script honors `SCARF_ANALYTICS=false`, `SCARF_NO_ANALYTICS=true`, and `DO_NOT_TRACK=1`, redacts package names and paths before reporting, and does not fail installation when reporting fails.
NemoClaw's `npx` commands do not disable lifecycle scripts, so this remains a pre-existing low-severity side effect.
The target does not add or change that script or dependency path.

NemoClaw pins Fern by version, uses it only for contributor and CI documentation tooling, and does not ship this graph in its CLI, plugin, blueprint, or runtime images.

## Downstream Contract Audit

`fern/fern.config.json` is the single version authority.
The following consumers read that file before constructing a versioned `fern-api` selector:

- the `docs:deps`, `docs:validate`, `docs:live`, and `docs:preview:watch` npm scripts;
- public and staging publication;
- pull-request previews;
- staging preview deletion.

No lockfile, generated manifest, workflow input, environment default, cache key, or runtime image contains a second production Fern version.
The synthetic `3.67.1` in `test/fern-preview-config.test.ts` is an opaque unit-test input, not a production selector.

NemoClaw has no Fern API definition or generator manifest.
Its Fern tree contains docs configuration, theme assets, components, and CSS.
The API importer, SDK generator, OAuth login, MCP installation, packaging, and organization-management paths are therefore not invoked.

The staging preview workflow uses named preview listing and deletion.
The relevant Fern changes preserve that contract, and NemoClaw tests the constructed command arguments.
Markdown-path fixes apply during docs validation and publication and are covered by the docs build.

## Concern Ledger

| ID | Severity | Failure mode | Evidence and disposition |
| --- | --- | --- | --- |
| `FERN-1` | Medium | New login or MCP commands could expose credentials during normal docs commands | NemoClaw does not invoke those commands, and no reviewed configuration activates them. Normal docs commands keep their existing entry points. |
| `FERN-2` | Medium | Git-ref docs versioning could publish a different source tree | NemoClaw does not configure the new `ref` field. Publication still checks out the repository revision selected by GitHub Actions. |
| `FERN-3` | Medium | Markdown parser changes could omit or rewrite local assets | `5.92.4` includes follow-up fixes for bracketed alternative text and angle-bracket destinations. The full docs build validates the current tree. |
| `FERN-4` | Medium | Named preview changes could delete or retain the wrong preview | The staging workflow constructs a repository-owned preview identifier, and focused workflow tests cover listing and deletion arguments. |
| `FERN-5` | Medium | The target archive could be substituted | Registry integrity, signatures, provenance, source revision, and successful publication run bind the reviewed artifact. |
| `FERN-6` | Medium | A changed dependency could introduce a vulnerability or license conflict | The current and target closures are identical apart from the Fern root package, and both advisory audits report zero findings. |
| `FERN-7` | Low | Scarf postinstall telemetry can run during a fresh `npx` install | The path and script are unchanged from `5.80.1`, opt-out variables remain available, and Fern is docs-only tooling. The residual is accepted for this upgrade. |
| `FERN-8` | Low | The compatible BAML range could resolve differently in a future install | The range is unchanged, the current resolution is `0.219.0`, and registry signature checks cover the materialized graph. |
| `FERN-9` | Low | New package-generation or importer features could alter shipped artifacts | NemoClaw has no generator manifest and does not invoke these commands. The Fern graph is not included in product artifacts. |
| `FERN-10` | Low | Persisted state could retain incompatible Fern behavior | Fern caches and generated docs are disposable build outputs with no product migration, rollback state, or runtime compatibility shim. |

Unresolved high-severity concerns: `0`.

## Verification and Remaining Gates

Completed audit evidence:

- 194 contiguous source commits reviewed across five non-overlapping ranges;
- target SHA-1 and SHA-512 identities matched npm registry metadata;
- package structure and licenses inspected without executing upstream lifecycle scripts;
- npm signatures and SLSA provenance verified for current and target graphs;
- current and target dependency closures compared;
- current and target advisory audits reported zero findings;
- the target source manifest and NemoClaw command consumers reviewed.

Before merge, the reviewed PR must still pass:

- the focused dependency-review and staging workflow tests;
- the full documentation build with `fern-api@5.92.4`;
- normal commit hooks and required GitHub checks;
- automated review with no unresolved actionable finding;
- documentation writer review.

No live sandbox E2E, migration, rollback, compatibility shim, or runtime changelog entry is required because the dependency is not part of a supported NemoClaw runtime or user-visible product behavior.
