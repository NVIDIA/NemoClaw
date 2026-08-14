<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Base Image Vim 9.2.0858 Dependency Review

> Internal engineering evidence. This file is not part of the public documentation set.

Date: August 12, 2026

## Scope

This review covers the Vim security package upgrade in the OpenClaw, Hermes, and LangChain Deep Agents Code base images.
The change replaces Debian `vim-common=2:9.2.0782-1` and `vim-tiny=2:9.2.0782-1` with `2:9.2.0858-1`.
The replacement contains the upstream patches for these vulnerabilities:

- `CVE-2026-73077`, fixed in Vim patch 9.2.0839;
- `CVE-2026-73078`, fixed in Vim patch 9.2.0840;
- `CVE-2026-73074`, fixed in Vim patch 9.2.0841;
- `CVE-2026-73070`, fixed in Vim patch 9.2.0842;
- `CVE-2026-73072`, fixed in Vim patch 9.2.0846; and
- `CVE-2026-73076`, fixed in Vim patch 9.2.0847.

The change preserves the existing editor command and managed base-image behavior.
It does not create a new supported surface.

## Reviewed Artifact Identities

The package source is Debian Snapshot `20260727T143429Z`.
The image build downloads the packages over HTTPS and verifies these SHA-256 values before installation:

| Package | amd64 | arm64 |
| --- | --- | --- |
| `vim-common_9.2.0858-1_all.deb` | `c21aad77632ef790d2352f1c38e688069980bbd530034248dd5e1158da9c9fe3` | Same architecture-independent package. |
| `vim-tiny_9.2.0858-1_amd64.deb` | `df2d037d405f1376d1d8025d022dba81fbfed8695f68a131b788d16d3b68cf83` | Not applicable. |
| `vim-tiny_9.2.0858-1_arm64.deb` | Not applicable. | `3948582a06ba027513d036c446f6dc9b7a9ed344a460ad05f232e2779f484cd1` |

The image build rejects architectures other than amd64 and arm64 before package installation.

## Package Contract

Each managed base image installs the matching `vim-common` and `vim-tiny` package pair.
The image build verifies these requirements after installation:

1. `dpkg-query` reports `2:9.2.0858-1` for both packages.
2. `vim.tiny --version` reports Vim 9.2.
3. `vim.tiny --version` reports `Included patches: 1-858`.
4. The root-owned, read-only security inventory records both exact package identities.
5. `dpkg --audit` returns no output in the completed image.

The completed OpenClaw, Hermes, and Deep Agents Code image stages repeat the inventory and runtime assertions.

## Concern Ledger

### VIM-1 Earlier Vim Package Omits Six Security Patches

- Surface: Vim runtime in all managed base images.
- Severity: five High findings and one Medium finding.
- Confidence: high.
- Failure mode: attacker-controlled editor input can reach defects that the six upstream patches correct.
- Disposition: upgrade, pin, and test.
- Implementation: install checksum-pinned Debian packages that contain patches 1 through 858.
- Verification: reject incorrect checksums or package identities, inspect the runtime patch range, and build every managed image on amd64 and arm64.
- Remaining gate: publish all six platform images and rescan their immutable digests.

## Downstream Boundaries

The upgrade changes only the Vim package files and their recorded package identities.
It does not change agent configuration, credentials, network policy, runtime entrypoints, or persistent state.

A rollback can select an earlier immutable base-image digest.
That rollback also restores the affected Vim package and is not a security remediation.

## Removal Condition

Remove the Debian Snapshot override after the supported Debian suite publishes Vim at or beyond `2:9.2.0858-1`.
The replacement must pass the same checksum, package identity, runtime patch-range, inventory, and multi-architecture image checks.

## Verification

Required evidence for the commit under review is:

- focused tests for the exact package URLs, checksums, identities, and security inventory in all three Dockerfiles;
- rejection tests for unsupported architectures and incorrect package content;
- successful runtime assertions for Vim patch range 1 through 858;
- an empty `dpkg --audit` result in every completed image; and
- successful native amd64 and arm64 builds for the OpenClaw, Hermes, and Deep Agents Code base images.
