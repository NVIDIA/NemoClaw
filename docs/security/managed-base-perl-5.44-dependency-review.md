<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Managed base-image Perl 5.44 review

Date: 2026-07-29

## Scope

This review extends the existing Perl 5.44.0 remediation to the Hermes and LangChain Deep Agents Code base images.

The OpenClaw base image already installs the reviewed packages.
The sibling images used Debian Perl 5.40.1-6 before this change.

This change does not cross an upstream Perl release range.
It preserves these reviewed identities:

- source release: Perl 5.44.0;
- source SHA-256: `505cf43912e9480495c344c70260452e32aa2a73c546a026b3f100053b23ce91`;
- package revision: `1nemoclaw1`; and
- package versions: `perl-base=5.44.0-1nemoclaw1` and `perl=5.44.0-1nemoclaw1`.

The public vulnerability set includes `CVE-2026-12087`, `CVE-2026-13221`, `CVE-2026-48959`, `CVE-2026-48961`, `CVE-2026-48962`, `CVE-2026-57432`, `CVE-2026-57433`, and `CVE-2026-7017`.

## Artifact flow

`scripts/security/build-perl-security-packages.sh` owns the source download, checksum verification, configuration, test selection, install, and Debian package metadata.

Each managed base image uses this flow:

1. Build the existing libssh2 and Python security packages.
2. Build Perl from the checksum-pinned CPAN archive.
3. Run the complete upstream test selection.
4. Build native `perl-base` and `perl` Debian packages.
5. Install both packages before deleting the build artifacts.
6. Execute exact interpreter, module, behavior, and dpkg assertions.

The package metadata replaces the Debian `libperl5.40` and `perl-modules-5.40` ownership without leaving unmanaged files.

## Build topology

The complete Perl suite approaches the image-job timeout under QEMU arm64 emulation.

The base-image publisher now builds these image and platform pairs on native runners:

- OpenClaw on amd64 and arm64;
- Hermes on amd64 and arm64; and
- Deep Agents Code on amd64 and arm64.

All six platform builds run independently.
Each final publisher creates tags only after both platform digests for its image pass.
The publisher then verifies that the manifest contains amd64 and arm64.
Clean unversioned development checkouts resolve an available exact source-SHA image before attempting a local rebuild.
Dirty base-image inputs still require a local build and cannot consume a published candidate.

## Runtime proof

Each completed image must report these values:

| Component | Required value |
|---|---|
| Perl | `v5.44.0` |
| Socket | `2.041` |
| Storable | `3.41` |
| HTTP::Tiny | `0.096` |
| IO::Compress::Base | `2.223` |
| IO::Uncompress::Unzip | `2.223` |
| File::GlobMapper | `1.001` |

The image build also executes the reviewed Socket argument-length rejection and regular-expression behavior checks.
`dpkg --audit` must return no output.

## Concern ledger

| ID | Surface | Failure mode | Disposition | Evidence |
|---|---|---|---|---|
| PERL-01 | Source identity | A moving or modified archive changes the runtime behind the package version. | Pin | The CPAN URL contains `5.44.0`, and SHA-256 verification precedes extraction. |
| PERL-02 | Test coverage | A sibling image installs an untested native build. | Test | The shared builder runs the complete selection-equivalent upstream suite before packaging. |
| PERL-03 | Package ownership | Replacing Perl leaves conflicting Debian package ownership. | Guard | Package metadata declares `Provides`, `Conflicts`, `Breaks`, and `Replaces`; every image runs `dpkg --audit`. |
| PERL-04 | Image selection | One managed image continues to copy packages from the older native-only stage. | Guard | All three Dockerfiles copy `/out` from `perl-builder`. |
| PERL-05 | Runtime selection | The expected package exists but another interpreter or module executes. | Runtime proof | Every final image executes the interpreter, module, Socket, and regex checks. |
| PERL-06 | Platform execution | arm64 emulation exceeds the job timeout or hides architecture-specific failure. | Migrate | Hermes and Deep Agents Code use native amd64 and arm64 platform jobs with atomic manifests. |
| PERL-07 | Published identity | One platform tag becomes visible before its sibling platform passes. | Guard | Platform jobs push by digest. Manifest jobs publish tags after both digest artifacts exist. |

## Downstream boundaries

The change does not modify agent configuration, credentials, network policy, runtime entrypoints, or persistent state.
It changes the Perl files and dpkg identities inside the three existing managed base images.
It also lets a clean unversioned development checkout resolve its exact published source-SHA candidate before the committed-input divergence check requires a local build.
Dirty base-image inputs still require a local build.

Rollback selects an earlier immutable base-image digest.
The change does not add a data migration or a compatibility fallback.

## Verification

The repository tests verify:

- one shared package definition and checksum identity;
- complete upstream test selection before packaging;
- package ownership and cleanup order;
- exact runtime and module assertions in all three images;
- native amd64 and arm64 jobs for both sibling images; and
- atomic multi-platform manifest publication.

The remaining external gates are the six production platform builds, manifest publication, and a vulnerability rescan of the published image digests.
