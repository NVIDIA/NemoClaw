<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox base dependency review: Vim, jq, Expat, Perl modules, and bundled npm

Date: 2026-07-25

## Scope

This review covers the sandbox dependency changes that:

- standardize the OpenClaw, Hermes, and Deep Agents Code base images on fixed Debian `libexpat1=2.8.2-1`, `libjq1=1.8.2-1`, `jq=1.8.2-1`, `vim-common=2:9.2.0782-1`, and `vim-tiny=2:9.2.0782-1` packages, with the reviewed `libonig5=6.9.9-1+b1` jq runtime dependency;
- replace the `brace-expansion@5.0.7` copy inside the reviewed `npm@11.18.0` package with `brace-expansion@5.0.8`; and
- verify the security-relevant dual-life module versions shipped by the checksum-pinned Perl 5.44.0 build.

The OpenClaw base image retains its existing reviewed jq and Expat identities, while the Hermes and Deep Agents Code base images move to the same package boundary.
These changes preserve the existing supported image behavior and do not create a new integration or product surface.

## Release and artifact identities

| Dependency | Previous identity | Reviewed identity | Artifact binding |
| --- | --- | --- | --- |
| Vim | All managed images: Debian trixie `2:9.1.1230-2` | Debian sid `2:9.2.0782-1` | Debian Snapshot `20260724T000000Z` and package SHA-256 values below |
| jq | OpenClaw: `1.8.2-1`; Hermes and Deep Agents Code: `1.7.1-6+deb13u2` | All managed images: `libjq1=1.8.2-1` and `jq=1.8.2-1` | Debian Snapshot `20260724T000000Z` and architecture-specific SHA-256 values below |
| Oniguruma | Distro-selected jq runtime dependency | All managed images: `libonig5=6.9.9-1+b1` | Debian Snapshot `20260724T000000Z` and architecture-specific SHA-256 values below |
| Expat | OpenClaw: `2.8.2-1`; Hermes and Deep Agents Code: distro-selected package | All managed images: `libexpat1=2.8.2-1` | Debian Snapshot `20260724T000000Z` and architecture-specific SHA-256 values below |
| npm | `npm@11.18.0` | unchanged | Existing reviewed npm archive and integrity |
| npm private `brace-expansion` | `5.0.7` | `5.0.8` | Registry tarball and SHA-512 integrity below |
| Perl | `5.44.0-1nemoclaw1` | unchanged | Existing CPAN archive SHA-256 and complete upstream test suite |

The fixed Vim source package is later than every reviewed 9.2 patch boundary.
The Debian security tracker records `2:9.2.0782-1` as fixed for the affected Vim issues while trixie's `2:9.1.1230-2` remains affected.

The immutable Debian package SHA-256 values are:

| Package | amd64 | arm64 |
| --- | --- | --- |
| `libexpat1_2.8.2-1` | `37d24b40a745107941f823d1f22c38f197f01981f7f0783777fe0026af016463` | `df928e3a8e4da79408d4b18e8cd80a03dffa90130d0698e50041aab5e14f9397` |
| `libonig5_6.9.9-1+b1` | `3abee130696244050500bcc7870e3b4cb82ddd87149ece3fd55010c3d4e1d18c` | `137e708575c0622d347815d19cb471a107546b16e9602805ee27afad7bba107f` |
| `libjq1_1.8.2-1` | `9a5bf964cef39ed8f0f162e20d856e31961d28a57772b5313989b42a8be7e941` | `eae4a828df2eb53d728f88109d9f9549e0983a90b573cf0c7fa1e4bbc7533a7e` |
| `jq_1.8.2-1` | `b973a5d304f666845e8ccefab492e3850d4bc2e7aa2a1e7450862095125f2cc0` | `c25086443abd04d1457cbb322a0837f9ba986f82b28f44670467c8dc9be1f696` |
| `vim-common_9.2.0782-1_all` | `6b063038246492c4a20e0a212c896dde4d5aa9f59d6fb43ff33d10080bc53a39` | same architecture-independent package |
| `vim-tiny_9.2.0782-1` | `0e6e231d6d2430a92cf76f8a78506090418fa37758c33b31ed50dfbfc76e22ed` | `be30f7e9de0b872bec0128ccd890452c0e0e29d99017d16c0f3aa74164f6700d` |

The reviewed npm replacement is:

- version: `brace-expansion@5.0.8`;
- integrity: `sha512-JZyDyq3D4AUifKTPOB7DELf6XsB3WdPuNxCtob1vFXPsSXhdAiHBWJ/tJ8HAc9aH84BK+5JFZLNkJKx3G9kzQg==`; and
- tarball: `https://registry.npmjs.org/brace-expansion/-/brace-expansion-5.0.8.tgz`.

## Contract audit

### Managed-image Debian package compatibility

Each managed base image downloads the six exact Debian packages from the same immutable snapshot and verifies every package checksum before installation.
Each image installs the complete jq runtime closure and matching Vim package pair together, verifies every dpkg identity, confirms that jq links to `libonig.so.5`, exercises jq and Python Expat, and verifies that the Vim runtime reports version 9.2.
The package architecture is selected from `dpkg --print-architecture`, and any architecture other than amd64 or arm64 fails closed.
The base writes that architecture and the six exact package identities to a root-owned, read-only inventory.
Each completed OpenClaw, Hermes, and Deep Agents Code image reasserts the inventory metadata and exact content, every installed dpkg identity, jq-to-Oniguruma linkage, jq, Expat, and Vim runtime probes, and an empty `dpkg --audit` result.

`vim-tiny=2:9.2.0782-1` depends on:

- `vim-common=2:9.2.0782-1`;
- `libacl1 >= 2.2.23`;
- `libc6 >= 2.38`;
- `libselinux1 >= 3.1~`; and
- `libtinfo6 >= 6`.

The pinned trixie bases satisfy those library floors.
`libjq1=1.8.2-1` requires `libonig5 >= 6.9.7.1`; the exact `libonig5=6.9.9-1+b1` artifact closes that dependency on both architectures.
The packages remain visible to dpkg and the generated software inventory, and no manual file overlay is used.

The final reviewed dependency set and range evidence is:

| Package or component | Previous or affected boundary | Final reviewed boundary | Runtime and inventory proof |
| --- | --- | --- | --- |
| `libexpat1` | distro-selected package or `2.8.2-1` | `2.8.2-1` | exact dpkg identity and Python `pyexpat` reports Expat 2.8.2 |
| `libonig5` | jq dependency floor `>= 6.9.7.1` | `6.9.9-1+b1` | exact dpkg identity and `/usr/bin/jq` links to `libonig.so.5` |
| `libjq1` | `1.7.1-6+deb13u2..1.8.2-1` | `1.8.2-1` | exact dpkg identity and matching `jq` runtime |
| `jq` | `1.7.1-6+deb13u2..1.8.2-1` | `1.8.2-1` | exact dpkg identity, `jq-1.8.2`, and a JSON expression probe |
| `vim-common` and `vim-tiny` | `2:9.1.1230-2..2:9.2.0782-1` | `2:9.2.0782-1` | exact dpkg identities and Vim 9.2 runtime probe |
| npm private `brace-expansion` | `5.0.7..5.0.8` | `5.0.8` | complete-tree identity, dependency-shape, SRI, rollback, and npm/npx ordering guards |
| Perl and reviewed dual-life modules | Perl `5.43.10..5.44.0`; `HTTP::Tiny < 0.095`; `IO::Compress < 2.223` | Perl `5.44.0`; `HTTP::Tiny 0.096`; `IO::Compress 2.223`; component identities listed below | native package identity and direct interpreter/module version probes |

### Bundled npm package compatibility

The npm release remains `11.18.0`.
Its private dependency tree contains one top-level `brace-expansion@5.0.7` package with the existing `balanced-match@^4.0.2` contract.
The replacement `5.0.8` package preserves that dependency contract, and its Node engine floor is compatible with the Node 22 and Node 24 base images.

The replacement helper:

1. rejects npm identities other than the reviewed `11.18.0`;
2. rejects every symlink except a `node_modules/.bin` link that resolves to a regular file inside the reviewed `node_modules` root;
3. downloads the exact registry tarball without invoking npm;
4. verifies the packed bytes against the reviewed SHA-512 integrity;
5. extracts without restoring archive owners or modes;
6. rejects unsafe extracted members;
7. replaces the complete private package directory transactionally;
8. restores the original directory if verification fails;
9. disarms rollback immediately after the verified replacement becomes authoritative, then retries backup cleanup without risking the live tree; and
10. invokes npm and npx only after the fixed package is active.

All managed base images apply the helper after the complete npm upgrade.
Their final images reassert the same idempotent contract so the scanned filesystem, not an intermediate stage, owns the dependency boundary.

### Perl component versions

Perl remains the checksum-pinned 5.44.0 source release.
The existing build runs the complete upstream test selection on native amd64 and arm64 runners before building native packages.

Perl 5.44.0 includes these reviewed component versions:

- `Socket 2.041`;
- `Storable 3.41`;
- `HTTP::Tiny 0.096`;
- `IO::Compress 2.223`;
- `IO::Uncompress::Unzip 2.223`; and
- `File::GlobMapper 1.001`.

The image build checks the IO::Compress distribution version through `IO::Compress::Base` and checks each affected module directly.
The HTTP::Tiny floor is `0.095`, and the reviewed IO::Compress fixes are in `2.223`.
The core interpreter version check also remains the binding for core-language fixes included after Perl 5.43.10.

## Concern ledger

### DEP-1: affected trixie Vim package

- Range: `2:9.1.1230-2..2:9.2.0782-1`
- Surface: native package and runtime editor
- Severity: high
- Confidence: high
- Failure mode: attacker-controlled editor inputs can reach defects fixed across the reviewed Vim 9.2 patch range.
- Disposition: migrate, pin, test
- Implementation: install the matching immutable Debian Snapshot packages for amd64 and arm64 after SHA-256 verification in every managed base image.
- Verification: exact `RUN`-chain execution, checksum-rejection tests, dpkg identity checks, Vim runtime checks, and native image builds.
- Remaining gate: multi-image, multi-architecture CI.

### DEP-2: affected package inside npm's private tree

- Range: `brace-expansion 5.0.7..5.0.8`
- Surface: transitive bundled npm dependency
- Severity: high
- Confidence: high
- Failure mode: changing NemoClaw lockfiles does not replace npm's private package copy.
- Disposition: migrate, pin, guard, test
- Implementation: transactional, SRI-pinned complete-directory replacement after the reviewed npm archive is installed.
- Verification: pre-swap and post-swap rollback, idempotence, unsafe-tree, layout-drift, command-order, Dockerfile-order, and real-registry tests.
- Remaining gate: multi-image CI.

### DEP-3: Perl package identity does not expose dual-life module versions

- Range: Perl `5.44.0` with bundled component versions
- Surface: native package inventory and runtime modules
- Severity: high
- Confidence: high
- Failure mode: a package-only inventory can miss that the fixed module versions are already present in the interpreter distribution.
- Disposition: runtime-proof, test, document
- Implementation: exact runtime version assertions for every reviewed module family in addition to the existing interpreter and regression checks.
- Verification: native amd64 and arm64 image builds.
- Remaining gate: multi-architecture base-image build.

### DEP-4: managed jq, Oniguruma, and Expat identities differ

- Range: `libexpat1` distro-selected or `2.8.2-1` to `2.8.2-1`; `libjq1` and `jq` `1.7.1-6+deb13u2..1.8.2-1`; `libonig5 >= 6.9.7.1` to exact `6.9.9-1+b1`.
- Surface: native packages and runtime libraries
- Severity: high
- Confidence: high
- Failure mode: a managed image can retain an older jq or Expat runtime, or fail to configure jq when its architecture-specific Oniguruma dependency is absent.
- Disposition: migrate, pin, test, runtime-proof
- Implementation: use the same snapshot, architecture-specific checksums, dpkg identities, and runtime guards in every managed base image.
- Verification: exact base-package and completed-image `RUN`-chain execution, immutable inventory content and metadata checks, checksum-rejection tests, installed dpkg identities, runtime probes, and empty dpkg audit for all three images on amd64 and arm64.
- Remaining gate: multi-image, multi-architecture CI.

## Removal conditions

Remove the Debian snapshot override only when the supported Debian suite publishes packages at or beyond every reviewed fix boundary and the replacements pass the same amd64 and arm64 package and runtime checks for all managed base images.

Remove the private brace-expansion helper only when every pinned Node base installs a reviewed npm release whose complete private tree contains no brace-expansion version below 5.0.8.
Updating the npm archive without revisiting this helper must fail the image contract.

## Verification

Required evidence for the final pull-request head:

- focused helper and exact security-package `RUN`-chain tests for every managed base image and architecture;
- source-identity and optimized build-context tests;
- real reviewed npm archive replacement using the registry artifact;
- repository formatting and type checks;
- amd64 and arm64 builds for the OpenClaw, Hermes, and Deep Agents Code base images; and
- completed-image dependency inventory.
