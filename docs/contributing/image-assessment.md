<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Assess Saved Image Inventories

Use the source-built assessment command to check saved release SBOMs for known vulnerabilities.
It reads local inputs and a prepared Grype database, invokes the pinned scanner, and prints a report.
It does not pull or run images, update the database, change registry resources, or authorize publication.

This command supplies the raw assessment for [#13523](https://github.com/NVIDIA/NemoClaw/issues/13523).
The separate release controller evaluates reviewed exceptions and controls disclosure and publication.

## Prepare the Inputs

Use the pinned Rust toolchain from [build prerequisites](../build.md) and a verified Grype 0.121.0 binary.
Prepare a Grype database cache before assessment using the scanner's [database commands](https://oss.anchore.com/docs/reference/grype/cli/).
Choose the maximum database age explicitly for the assessment; that local choice does not establish a release policy.

Keep these inputs together:

- The expected image inventory, including each image's name, repository, and platform manifest descriptors.
- The `sboms.json` mapping, with each executable platform's immutable image reference, platform, SPDX asset name, and SHA-256.
- The saved SPDX 2.3 assets named by that mapping.

Use the mapping and SPDX assets produced by [release staging](releases.md#sbom-assets).
The image and release workflows own SBOM generation and reuse; assessment consumes their saved assets.
The assessment command does not generate an inventory or an SBOM.
Keep candidate acquisition locations separate from eventual public publication locations when producing the inputs.
The inventory supplied by the caller defines expected coverage; passing its consistency checks does not authenticate its source.

The input checks require both Linux AMD64 and ARM64 executable platform subjects for every expected image.
Clearly identified attestation descriptors do not require a package scan.
Missing, duplicate, ambiguous, or substituted subjects prevent a complete assessment.

Each SPDX document must identify its creators and creation time and give packages unique IDs and usable names.
Assessable packages need a version and a versioned package URL or CPE reference for matching.
Structural source entries do not count as software inventory; at least one identifiable software package is required.
A package missing its required matching identity makes the input invalid instead of being silently omitted.
These checks establish minimum matching information, not complete SPDX conformance or source-image package coverage.

## Run an Assessment

From the repository root, use absolute paths to the prepared inputs, scanner, and database cache:

```sh
cargo run --locked -p nemoclaw-build --no-default-features -- release-assess \
  --inventory /path/to/inventory.json \
  --sboms /path/to/sboms.json \
  --sbom-directory /path/to/sboms \
  --grype /path/to/grype \
  --database /path/to/grype-database \
  --max-db-age-hours 24
```

The example chooses a 24-hour age limit for this invocation.
Use `--timeout-seconds` to change the per-process timeout from its 120-second default.
Use `--format json` for structured output; text is the default.
Use `--format sarif` to generate a local SARIF 2.1.0 report without uploading it.
JSON output includes scanner and database identities, original source ratings, and problems categorized as `input`, `database`, or `scanner`.
Scanner problems identify the operation and exit status when available.

Keep reports from private candidates in a location approved for that inventory.
Package names and advisory details can disclose unreleased contents even when no credentials appear.
Do not send that output to public workflow logs or artifacts without disclosure approval.

## Interpret the Result

| Result | Exit code | Action |
|---|---|---|
| Assessment passed | `0` | No blocking finding was identified in complete, valid inputs; handle release approvals separately. |
| Assessment blocked | `2` | Update the affected dependency or base-image pin and assess the new image digest. |
| Assessment incomplete | `3` | Repair invalid or missing evidence, refresh the database, or review an unusable finding severity, then rerun. |

Argument-usage errors also use exit code `2`, with the parser's usage diagnostic rather than an assessment report.
Every assessment reports that publication is not authorized.
An incomplete assessment retains any findings already obtained; it does not establish an absence of vulnerabilities.

Known High and Critical findings block the assessment, including findings inherited from a base image.
The report preserves the scanner's selected severity and source, package version, advisory aliases, and available fixed versions.
A High or Critical finding still blocks when no fixed version is reported.
The raw assessment accepts no risk exceptions; exception evaluation keeps these findings intact.

After changing a dependency, regenerate the affected inventory and SBOM assets and reassess them.
An old result does not apply to a new image digest.
If a scanner or database check fails, preserve the report, correct the reported problem, and rerun with the intended saved inputs.

## Evidence Limits

A checksum verifies saved bytes against the caller's mapping; it does not establish image ownership, package completeness, runtime linkage, or exploitability.
In particular, Rust lockfile entries can include build dependencies.
A targeted vulnerable/fixed fixture establishes detection of that advisory through the inventory handoff, not that a production image or a later database has no vulnerabilities.

To run the optional real-tool acceptance test, set `NEMOCLAW_TEST_SYFT`, `NEMOCLAW_TEST_GRYPE`, and `NEMOCLAW_TEST_GRYPE_DB` to absolute paths for verified Syft 1.55.0, Grype 0.121.0, and a prepared database cache no older than 24 hours:

```sh
cargo test --locked -p nemoclaw-build --no-default-features --test integration \
  release_assessment::real_image_catalogs_retain_four_ecosystems_and_targeted_fixes \
  -- --ignored --exact
```

The test generates metadata-only OCI images locally and runs both tools without starting a workload.
It checks AMD64 and ARM64 inventories, vulnerable/fixed advisory pairs for Debian, npm, Python, and Rust, and a passing fixture.
It reads the prepared database without updating it.

The [release procedure](releases.md) still owns publication.
Its protected controller must approve the policy and disclosure, protect private candidates, and verify the approved digests before publication.

## Bind a Release Assessment

`release-gate` reads the saved inputs and runs a fresh scan; it never accepts a saved passing report as authority.
The inventory must also contain each image's `index_digest`, observed from the registry index.
Use the same scanner and input flags as `release-assess`, then add these controller inputs:

```sh
cargo run --locked -p nemoclaw-build --no-default-features -- release-gate \
  --inventory /private/inventory.json --sboms /private/sboms.json \
  --sbom-directory /private/sboms --grype /tools/grype --database /private/grype-db \
  --max-db-age-hours 24 --release-tag v0.1.0-rc1 \
  --controller-revision <full-reviewed-controller-commit> \
  --exceptions .github/security/v1-vulnerability-exceptions.json \
  --reviewed-policy-sha256 <approved-policy-sha256> \
  --output-directory /private/new-assessment
```

The output directory must be fresh and absolute.
It receives `assessment.json` and `assessment.sarif`; complete evidence also produces `gate.json`.
The receipt binds the exact inventory, mapping, compact assessment bytes, policy checksum, controller revision, image indexes, and platform subjects.
Status uses the same `0`, `2`, and `3` exit codes, but accounts for matched exception candidates.
Every local result still reports `publication_authorized: false`.
A locally supplied policy checksum proves consistency, not independent review.

`release-verify-promotion --expected PATH --actual PATH` compares the expected inventory with fresh registry observations of every index and platform manifest.
It rejects missing, added, substituted, or invalid subjects.
These local checks cannot prevent a repository writer or package administrator from bypassing a publication workflow.

## Review Upstream Exceptions

The default policy at `.github/security/v1-vulnerability-exceptions.json` is empty.
It has `schema_version: 1` and an `exceptions` array.
An exception must identify one exact image reference, platform, advisory, package, version, and PURL, together with the upstream base digest, rationale, current validity window, and a project issue tracking the pin update.
Its origin evidence names an immutable GitHub blob and its SHA-256.
Reviewers must check that evidence establishes an inherited upstream finding; the evaluator does not fetch it or infer ownership from a package manager or file path.
NemoClaw-controlled findings remain blocking.

This candidate limits an exception to 30 days from `valid_from` and rejects future, expired, duplicate, unmatched, or ambiguous entries.
Entries apply only to the exact assessed image digest and platform, so another release's exceptions do not invalidate this assessment.
That lifetime is a proposed policy choice for maintainer review, not a previously established release policy.
The protected controller binds the reviewed policy bytes before approval.
An editable reviewer name or approval boolean cannot authorize an exception.
Unknown severity and incomplete scan evidence remain incomplete even when an exception matches.
Raw JSON and SARIF retain every finding without suppression.

## Configure Hosted Enforcement

Before activating this workflow, protect the `v1` controller branch and release tags and limit who can change publishing workflows or bypass their checks.
Configure `v1-release-security` and `v1-release-publication` with required independent reviewers, prevention of self-review, and exactly the `v0.1.*` tag deployment policy.
Missing protections or API failures deny the controlled path.
Review publisher credentials and repository/package administrator privileges separately: job dependencies do not revoke those powers.

Security approval authorizes public disclosure of the exact candidate inventories and findings to code scanning and workflow artifacts.
The controller is frozen before approval and used again by the publisher; candidate source is not executed by those jobs.
The publisher prepares a fresh advisory database, reassesses the saved inputs, verifies current registry digests, and only then publishes the draft.
`V1_SECURITY_PUBLICATION_ENABLED` must be explicitly set to `true` after the existing product and QA sign-offs; it defaults off.
The workflow does not change package visibility.
The candidate's Bake catalog supplies the production agent image names as validated data; the controller appends the proxy and runtime images.
New harnesses join vulnerability coverage through that catalog, without a separate scanner allowlist or changes to Fabric's adapter contract.

SARIF identifies the saved SPDX artifact and logical package, without inventing source-code lines.
Its per-release analysis category and finding fingerprints remain stable across rescans.
Uploads exceeding the supported result limit fail rather than silently dropping findings; the complete local report is retained.
Successful local schema validation does not establish successful hosted ingestion or alert rendering.

## Monitor Supported Releases

`.github/security/v1-supported-releases.json` explicitly lists supported published releases and defaults to an empty list.
Each entry pins `tag`, `inventory_sha256`, `sboms_sha256`, `policy_sha256`, and RFC 3339 `support_until`.
Review those hashes and the support period before adding an actual release.
The monitor rejects draft releases, mismatched evidence, and packages that are not public before reporting findings.
It prepares a fresh database and uploads a separate SARIF category for each active release.
An empty list means there are no configured scan targets, not that images were scanned clean.

GitHub runs schedules from the default branch.
Because `v1` is not the default branch, the reviewed monitoring dispatcher must also be deployed to the default branch and configured with `V1_SECURITY_CONTROLLER_REVISION`, a full reviewed controller commit.
Adding the workflow only to `v1` does not activate scheduled scanning.
No hosted protections, dispatcher installation, code-scanning uploads, or publication settings are configured by local development.

The pinned controller supplies one global exception-policy file for every active release.
Every active entry's `policy_sha256` must match the SHA-256 of those exact file bytes, even when a policy change concerns only another release.
To rotate the policy or change the supported-release list:

1. Have maintainers review the policy's effect on every release whose `support_until` is still in the future, including each applicable exception's origin evidence and validity window.
   Review any addition or extension of release support explicitly; an elapsed `support_until` removes that release from the monitoring matrix.
2. Put the policy and supported-release manifest updates in the same reviewed controller commit.
   Set `policy_sha256` for **every active release** to the new global policy checksum.
   Preserve each release's approved inventory and SBOM checksums unless those inputs also receive review.
3. After review, set `V1_SECURITY_CONTROLLER_REVISION` to that full immutable commit containing both files, then dispatch the monitor and confirm that every intended release is assessed and its report is processed by code scanning.
   Editing a later branch revision alone has no effect while the dispatcher remains pinned to the old commit.

A policy checksum mismatch stops that release before assessment or upload; it never silently adopts the changed policy.
Repair stale manifest hashes through the reviewed update above, then rerun the monitor.
A current hash does not extend an exception: an expired applicable exception makes the assessment incomplete, retains the raw findings, and cannot produce a passing release gate.
Review an exception's continued justification and expiry before changing its validity window; the 30-day limit still applies.

## Qualify Actual Release Images

The metadata-only OCI test above does not qualify NVIDIA release image contents.
Use `release-qualify` on the saved staging assets to check representative packages against independent observations of the selected images.
It accepts only canonical `ghcr.io/nvidia/nemoclaw/v1/<image>` repositories and requires both Linux architectures for every selected image.
Use the complete staged inventory to qualify a whole release; selecting a subset establishes coverage only for that subset.
It reads local files without pulling images, running scanners or workloads, or publishing evidence.

Prepare an expectations JSON array with one object per selected image/platform, containing `image`, `platform`, and a nonempty `packages` array.
Each package object contains `family`, `name`, `version`, `purl`, and `source_path`.
Obtain those values from the image's installed package metadata or retained build inventory independently of the SPDX document being checked.
Copying expectations from that document cannot establish independent coverage.

| Family | Expected package and source |
|---|---|
| `os` | An OS package with its absolute package-metadata path. |
| `fabric_python` | A Python package under `/opt/fabric/`. |
| `node` | An npm package with a source path containing `/node_modules/`. |
| `supervisor_rust` | A Cargo package from `/opt/nemoclaw/source/supervisor/Cargo.lock`. |
| `proxy_rust` | A Cargo package from `/usr/share/doc/nemoclaw-ollama-proxy/Cargo.lock`. |

Across the selected images, expectations must cover `os`, `fabric_python`, `node`, and `supervisor_rust` on each architecture.
Every selected `ollama-proxy` subject also requires a `proxy_rust` observation.
Every selected `vllm` and `ollama` subject requires a `supervisor_rust` observation.
Missing subjects, duplicate observations, mismatched package identities or paths, and substituted SPDX bytes prevent a coverage receipt.

From the repository root, use absolute input paths and a fresh absolute path for the output file whose parent directory already exists:

```sh
cargo run --locked -p nemoclaw-build --no-default-features -- release-qualify \
  --inventory /private/actual-release/inventory.json \
  --sboms /private/actual-release/sboms.json \
  --sbom-directory /private/actual-release/sboms \
  --expectations /private/actual-release/expectations.json \
  --output /private/actual-release/coverage.json
```

Exit code `0` means the saved inventories contain the independently expected representative packages; validation failures use `3` and do not create a new coverage receipt.
The receipt binds the inventory, mapping, and expectations checksums, each platform subject and SPDX checksum, and the checked packages.
It reports `representative_coverage_verified: true`, while `package_completeness_verified`, `image_source_authenticated`, and `publication_authorized` remain `false`.
A coverage receipt neither authenticates the images or observations nor establishes a passing vulnerability assessment.
Keep it private with the saved inputs, then perform fresh registry observations and the separate `release-gate` assessment before release approval.
