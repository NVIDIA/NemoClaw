<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox base dependency review: Vim, Perl modules, and bundled npm

Date: 2026-07-25

## Scope

This review covers the sandbox dependency changes that:

- replace Debian trixie's `vim-common` and `vim-tiny` `2:9.1.1230-2`
  packages with fixed Debian `2:9.2.0782-1` packages;
- replace the `brace-expansion@5.0.7` copy inside the reviewed `npm@11.18.0`
  package with `brace-expansion@5.0.8`;
- verify the security-relevant dual-life module versions shipped by the
  checksum-pinned Perl 5.44.0 build; and
- retain the already-fixed `libexpat1=2.8.2-1`, `libjq1=1.8.2-1`, and
  `jq=1.8.2-1` packages.

The Vim and npm changes preserve the existing supported image behavior. They
do not create a new integration or product surface.

## Release and artifact identities

| Dependency | Previous identity | Reviewed identity | Artifact binding |
| --- | --- | --- | --- |
| Vim | Debian trixie `2:9.1.1230-2` | Debian sid `2:9.2.0782-1` | Debian Snapshot `20260724T000000Z`, package SHA-256 values below |
| npm | `npm@11.18.0` | unchanged | Existing reviewed npm archive and integrity |
| npm private `brace-expansion` | `5.0.7` | `5.0.8` | Registry tarball and SHA-512 integrity below |
| Perl | `5.44.0-1nemoclaw1` | unchanged | Existing CPAN archive SHA-256 and complete upstream test suite |
| Expat | `libexpat1=2.8.2-1` | unchanged | Existing Debian Snapshot package and architecture-specific SHA-256 |
| jq | `libjq1=1.8.2-1`, `jq=1.8.2-1` | unchanged | Existing Debian Snapshot packages and architecture-specific SHA-256 values |

The fixed Vim source package is later than every reviewed 9.2 patch boundary.
The Debian security tracker records `2:9.2.0782-1` as fixed for the affected
Vim issues while trixie's `2:9.1.1230-2` remains affected.

The immutable Vim package SHA-256 values are:

| Package | amd64 | arm64 |
| --- | --- | --- |
| `vim-common_9.2.0782-1_all.deb` | `6b063038246492c4a20e0a212c896dde4d5aa9f59d6fb43ff33d10080bc53a39` | same architecture-independent package |
| `vim-tiny_9.2.0782-1` | `0e6e231d6d2430a92cf76f8a78506090418fa37758c33b31ed50dfbfc76e22ed` | `be30f7e9de0b872bec0128ccd890452c0e0e29d99017d16c0f3aa74164f6700d` |

The reviewed npm replacement is:

- version: `brace-expansion@5.0.8`;
- integrity:
  `sha512-JZyDyq3D4AUifKTPOB7DELf6XsB3WdPuNxCtob1vFXPsSXhdAiHBWJ/tJ8HAc9aH84BK+5JFZLNkJKx3G9kzQg==`;
- tarball:
  `https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz`.

## Contract audit

### Vim package compatibility

`vim-tiny=2:9.2.0782-1` depends on:

- `vim-common=2:9.2.0782-1`;
- `libacl1 >= 2.2.23`;
- `libc6 >= 2.38`;
- `libselinux1 >= 3.1~`; and
- `libtinfo6 >= 6`.

The pinned trixie base satisfies those library floors. The image installs the
matching `vim-common` and `vim-tiny` packages together, verifies both dpkg
versions, checks the package checksums before installation, and verifies the
runtime reports Vim 9.2.

The packages remain visible to dpkg and the generated software inventory. No
manual file overlay is used.

### Bundled npm package compatibility

The npm release remains `11.18.0`. Its private dependency tree contains one
top-level `brace-expansion@5.0.7` package with the existing
`balanced-match@^4.0.2` contract. The replacement `5.0.8` package preserves
that dependency contract and its Node engine floor is compatible with the
Node 22 and Node 24 base images.

The replacement helper:

1. rejects npm identities other than the reviewed `11.18.0`;
2. rejects unexpected, duplicate, nested, or symlinked package layouts;
3. downloads the exact registry tarball without invoking npm;
4. verifies the packed bytes against the reviewed SHA-512 integrity;
5. extracts without restoring archive owners or modes;
6. rejects unsafe extracted members;
7. replaces the complete private package directory transactionally;
8. restores the original directory if verification fails; and
9. invokes npm and npx only after the fixed package is active.

All managed base images apply the helper after the complete npm upgrade. Their
final images reassert the same idempotent contract so the scanned filesystem,
not an intermediate stage, owns the dependency boundary.

### Perl component versions

Perl remains the checksum-pinned 5.44.0 source release. The existing build runs
the complete upstream test selection on native amd64 and arm64 runners before
building native packages.

Perl 5.44.0 includes these reviewed component versions:

- `Socket 2.041`;
- `Storable 3.41`;
- `HTTP::Tiny 0.096`;
- `IO::Compress 2.223`;
- `IO::Uncompress::Unzip 2.223`; and
- `File::GlobMapper 1.001`.

The image build now checks the IO::Compress distribution version through
`IO::Compress::Base` and checks each affected module directly. The HTTP::Tiny
floor is `0.095`; the reviewed IO::Compress fixes are in `2.223`. The core
interpreter version check also remains the binding for core-language fixes
included after Perl 5.43.10.

### Existing jq and Expat packages

The previous review already binds fixed Debian packages, verifies their
architecture-specific hashes, checks their dpkg versions, and exercises both
runtime libraries. Installing another package version would not add a fix and
would expand cross-suite package risk, so this change preserves those package
identities and evidence.

## Concern ledger

### DEP-1: affected trixie Vim package

- Range: `2:9.1.1230-2..2:9.2.0782-1`
- Surface: native package and runtime editor
- Severity: high
- Confidence: high
- Failure mode: attacker-controlled editor inputs can reach defects fixed
  across the reviewed Vim 9.2 patch range.
- Disposition: migrate, pin, test
- Implementation: install the matching immutable Debian Snapshot packages for
  amd64 and arm64 after SHA-256 verification.
- Verification: dpkg identity checks, Vim runtime version check, and focused
  Dockerfile execution tests.
- Remaining gate: multi-architecture base-image build.

### DEP-2: affected package inside npm's private tree

- Range: `brace-expansion 5.0.7..5.0.8`
- Surface: transitive bundled npm dependency
- Severity: high
- Confidence: high
- Failure mode: changing NemoClaw lockfiles does not replace npm's private
  package copy.
- Disposition: migrate, pin, guard, test
- Implementation: transactional, SRI-pinned complete-directory replacement
  after the reviewed npm archive is installed.
- Verification: rollback, idempotence, unsafe-tree, layout-drift, command-order,
  Dockerfile-order, and real-registry tests.
- Remaining gate: multi-image CI.

### DEP-3: Perl package identity does not expose dual-life module versions

- Range: Perl `5.44.0` with bundled component versions
- Surface: native package inventory and runtime modules
- Severity: high
- Confidence: high
- Failure mode: a package-only inventory can miss that the fixed module
  versions are already present in the interpreter distribution.
- Disposition: runtime-proof, test, document
- Implementation: exact runtime version assertions for every reviewed module
  family in addition to the existing interpreter and regression checks.
- Verification: native amd64 and arm64 image builds.
- Remaining gate: multi-architecture base-image build.

### DEP-4: fixed jq and Expat packages already installed

- Range: unchanged fixed package identities
- Surface: native packages and runtime libraries
- Severity: high
- Confidence: high
- Failure mode: unnecessary replacement could weaken package compatibility
  without improving the fixed-version boundary.
- Disposition: no-impact
- Implementation: retain the existing snapshot, checksum, dpkg, and runtime
  guards.
- Verification: existing security-package contract tests.
- Remaining gate: none.

## Removal conditions

Remove the Vim snapshot override only when the supported Debian suite publishes
a package at or beyond the reviewed fix boundary and the replacement passes the
same amd64 and arm64 package and runtime checks.

Remove the private brace-expansion helper only when every pinned Node base
installs a reviewed npm release whose complete private tree contains no
brace-expansion version below 5.0.8. Updating the npm archive without revisiting
this helper must fail the image contract.

## Verification

Required evidence for the final pull-request head:

- focused helper and Dockerfile contract tests;
- source-identity and optimized build-context tests;
- real reviewed npm archive replacement using the registry artifact;
- repository formatting and type checks;
- amd64 and arm64 base-image builds; and
- completed-image dependency inventory.
