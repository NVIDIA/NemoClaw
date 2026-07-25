<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox base libexpat and jq dependency review

Review date: 2026-07-24

## Decision

Upgrade only the affected `sandbox-base` operating-system packages:

- `libexpat1` from `2.7.1-2` to `2.8.2-1` for CVE-2026-45186;
- `jq` and `libjq1` from `1.7.1-6+deb13u2` to `1.8.2-1` for CVE-2026-49839.

As of the review date, Debian Trixie does not carry either fixed version.
`Dockerfile.base` therefore installs the official Debian packages from the immutable `20260724T000000Z` snapshot and verifies an architecture-specific SHA-256 before installation.
The fixed packages are installed before the existing apt layer commits, so that layer does not retain a superseded jq or Expat package.

This review deliberately excludes Perl, Vim, gosu, npm, and repository-level `node-tar` findings.
Those findings have separate owners and remediation paths.

## Reviewed identities

| Component | Current identity | Target identity | Required fix |
| --- | --- | --- | --- |
| Expat source | `R_2_7_1` / `f9a3eeb3e09fbea04b1c451ffc422ab2f1e45744` | `R_2_8_2` / `c61098da494eea1cbd091118118dcee417faacea` | CVE-2026-45186 is fixed by `4cd4eb0683e04cd45a2ffc81a08ca2a2663994b5` and released in 2.8.1 |
| Debian Expat package | `libexpat1=2.7.1-2` | `libexpat1=2.8.2-1` | Debian records 2.8.2-1 as fixed |
| jq source | `jq-1.7.1` / `71c2ab509a8628dbbad4bc7b3f98a64aa90d3297` | `jq-1.8.2` / `34f7186b86743a083a589741b6cea95293524108` | CVE-2026-49839 is fixed by `e987df0d463d85fd70825e042a082427e8275b86` |
| Debian jq packages | `jq=1.7.1-6+deb13u2`, `libjq1=1.7.1-6+deb13u2` | `jq=1.8.2-1`, `libjq1=1.8.2-1` | Debian records 1.8.2-1 as fixed |

The affected published image was
`ghcr.io/nvidia/nemoclaw/sandbox-base:d87acc16`, index digest
`sha256:7df21f757f2cb9d1840ddf21db87e5d70e335734f01b3f1ed5bda43a85f98ffc`.
Its amd64 child was
`sha256:981a8d0d094b7498e0894c1300aa400d4f522e0d8d6385c4ad29436ff45da68d`,
and its arm64 child was
`sha256:a99bf6500b946a3b8e30f85859621f88827f63e5e4563ed5128005adfde29dfb`.

## Artifact integrity

The package identities and SHA-256 values were read from Debian's signed package indexes.
Builds fetch the same immutable snapshot paths over TLS and fail closed unless these hashes match:

| Package | amd64 SHA-256 | arm64 SHA-256 |
| --- | --- | --- |
| `libexpat1_2.8.2-1` | `37d24b40a745107941f823d1f22c38f197f01981f7f0783777fe0026af016463` | `df928e3a8e4da79408d4b18e8cd80a03dffa90130d0698e50041aab5e14f9397` |
| `libjq1_1.8.2-1` | `9a5bf964cef39ed8f0f162e20d856e31961d28a57772b5313989b42a8be7e941` | `eae4a828df2eb53d728f88109d9f9549e0983a90b573cf0c7fa1e4bbc7533a7e` |
| `jq_1.8.2-1` | `b973a5d304f666845e8ccefab492e3850d4bc2e7aa2a1e7450862095125f2cc0` | `c25086443abd04d1457cbb322a0837f9ba986f82b28f44670467c8dc9be1f696` |

The target packages require only dependencies already satisfied by the Trixie base:
`libjq1` requires `libc6 >= 2.39` and `libonig5 >= 6.8.1`, while `libexpat1`
requires `libc6 >= 2.38`.
The pinned base provides `libc6 2.41` and `libonig5 6.9.9`.

## Complete source range ledger

The release-ledger collector rejects the upstream `jq-*` and `R_*` tag formats as non-semantic-version tags.
The equivalent audit used full sanitized clones, explicit adjacent ancestry ranges, release notes, changed paths, fix diffs, and regression tests.
No upstream code was executed.

### jq

| Range | Commits | NemoClaw-relevant result |
| --- | ---: | --- |
| `jq-1.7.1` to `jq-1.8.0` | 155 | Security fixes, parser limits, and CLI/function behavior changes. NemoClaw uses ordinary object selection, construction, comparison, and mutation and does not depend on the documented breaking cases. |
| `jq-1.8.0` to `jq-1.8.1` | 17 | Security, portability, and performance fixes; the 1.8.0 `reduce`/`foreach` state-variable change was reverted. |
| `jq-1.8.1` to `jq-1.8.2` | 86 | Security hardening and bug fixes, including the exact raw-file heap-overflow fix at `e987df0d`. |

The CVE fix stops raw-file loading after `jv_string_append_buf` returns an invalid value.
It changes two lines in `src/jv_file.c` and does not alter successful jq filter output.

### Expat

| Range | Commits | NemoClaw-relevant result |
| --- | ---: | --- |
| `R_2_7_1` to `R_2_7_2` | 105 | Adds allocation-amplification protection and two opt-in tuning APIs. Existing callers retain default protection. |
| `R_2_7_2` to `R_2_7_3` | 53 | Correctness and portability fixes, including non-amd64 allocation alignment. |
| `R_2_7_3` to `R_2_7_4` | 158 | Security and overflow fixes plus optional symbol versioning, which Debian does not enable incompatibly for the existing ABI. |
| `R_2_7_4` to `R_2_7_5` | 49 | Three denial-of-service and error-path security fixes. |
| `R_2_7_5` to `R_2_8_0` | 117 | Strengthens hash-flooding entropy and adds `XML_SetHashSalt16Bytes`; existing APIs remain present. |
| `R_2_8_0` to `R_2_8_1` | 35 | Fixes CVE-2026-45186 by replacing quadratic default-attribute collision checks with a hash lookup. |
| `R_2_8_1` to `R_2_8_2` | 201 | Additional parser memory-safety and integer-overflow fixes without an ABI-major change. |

The CVE pull request includes seven duplicate-attribute regression cases.
Expat retains `libexpat.so.1`; its version moves from `1.10.2` to `1.12.2`.
New public APIs are additive, and existing Python and Git consumers remain dynamically compatible.

## Downstream contract audit

`jq` is a runtime tool in the base image.
NemoClaw uses it for JSON construction, selection, validation, and safe configuration merges.
The reviewed release notes do not remove or incompatibly change those operations.

`libexpat1` is a transitive runtime library.
The base image's Python `pyexpat` binding and Git executable load and execute with 2.8.2.
No NemoClaw source calls the newly added Expat APIs or the deprecated hash-salt API.

The child `Dockerfile` installs unrelated exact packages and does not request a jq or Expat downgrade.
No lockfile, generated manifest, cache key, migration, persisted state, rollback data, or compatibility shim carries a second production selector for these packages.

## Concern ledger

| ID | Severity | Failure mode | Evidence and disposition |
| --- | --- | --- | --- |
| `OSPKG-1` | High | A mutable download or wrong-architecture package could replace a reviewed binary | Immutable snapshot paths, separate architecture branches, exact package names, and SHA-256 verification fail the build before installation. Resolved. |
| `OSPKG-2` | High | jq 1.8 behavior changes could break configuration mutation | Both architectures pass a runtime object-selection probe; the audited breaking cases are outside NemoClaw's jq usage. Resolved. |
| `OSPKG-3` | High | Expat's minor-version and shared-library changes could break Python or Git | Both architectures import Python `pyexpat` as `expat_2.8.2` and execute Git successfully while retaining `libexpat.so.1`. Resolved. |
| `OSPKG-4` | High | Installing fixed packages could unintentionally modify the separately owned Perl remediation | The Docker build captures the installed Perl package version before the three package installs and fails if it changes. Both architecture proofs retain `perl=5.40.1-6`. Resolved. |
| `OSPKG-5` | Medium | Mixing fixed Debian packages into Trixie could leave unsatisfied dependencies | Target dependency floors are below the pinned Trixie `libc6` and `libonig5` versions; `dpkg -i` and runtime probes pass on amd64 and arm64. Resolved. |
| `OSPKG-6` | Medium | A scanner could classify a fixed package using Trixie advisory metadata instead of its installed version | Docker Scout sees the target package versions and reports zero Critical or High for the two CVEs, but its current Debian feed still labels them Low and Unspecified with an imprecise `>0` range. The authoritative nSpect rescan of published digests remains a promotion gate. |

Unresolved high-severity concerns: `0`.

## Verification and remaining gates

Completed evidence:

- the focused provisioning and security contract run passed all 97 tests;
- normal pre-commit hooks passed;
- `npm run docs` passed;
- Dockerfile static build check passed with no warnings;
- amd64 and arm64 package-layer builds downloaded and verified all six package artifacts;
- complete 21-stage `Dockerfile.base` builds passed for amd64 and arm64;
- both images report `libexpat1=2.8.2-1`, `libjq1=1.8.2-1`, and `jq=1.8.2-1`;
- jq object selection, Python `pyexpat`, and Git runtime probes passed on both architectures;
- both builds retained `perl=5.40.1-6` and `perl-base=5.40.1-6`;
- Docker Scout indexed 455 packages on each architecture and reported zero Critical and zero High for CVE-2026-45186 and CVE-2026-49839.

Before promotion:

- build and publish the complete `sandbox-base` image for amd64 and arm64 under a new immutable tag and digest;
- register and rescan both published child digests with nSpect;
- require zero Critical and zero High findings before promotion;
- keep the Perl, Vim, gosu, npm, and repository `node-tar` work in their independently owned changes.
