<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Managed Base Image libssh2 1.11.1 NemoClaw Revision 2 Dependency Review

Date: August 12, 2026

## Scope

This review covers two additional libssh2 security backports in the OpenClaw, Hermes, and LangChain Deep Agents Code base images.
The change preserves the reviewed libssh2 1.11.1 source and adds the upstream fixes for `CVE-2026-58050` and `CVE-2026-58051`.
The resulting Debian package identity changes from `libssh2-1t64=1.11.1-1+deb13u1+nemoclaw1` to `libssh2-1t64=1.11.1-1+deb13u1+nemoclaw2`.

The July 27 native-package review remains the historical record for the four fixes in `+nemoclaw1` and the Python HTMLParser package.
This review records only the libssh2 revision 2 delta.

The change preserves the existing SSH2 client library interface and managed base-image behavior.
It does not create a new supported surface.

## Reviewed Artifact Identities

The builder preserves these reviewed inputs:

- libssh2 source release `1.11.1`;
- source SHA-256 `9954cb54c4f548198a7cbebad248bdc87dd64bd26185708a294b2b50771e3769`;
- Debian package version `1.11.1-1+deb13u1`; and
- Debian Snapshot `20260724T000000Z`.

The patch set contains these additional upstream commits:

| Vulnerability | Upstream commit | Changed contract |
| --- | --- | --- |
| `CVE-2026-58051` | `a9758da45a52bc8c630ec9493804d0c6ea30b24a` | Initialize each expanded public-key list entry before later parsing or cleanup. |
| `CVE-2026-58050` | `7c8a170c6dca3cd4cf24de836f43ba1a20e662d5` | Reject public-key packet element lengths greater than `LIBSSH2_PACKET_MAXPAYLOAD`. |

The aggregate patch retains the four commits recorded for `+nemoclaw1`.
The build applies the reviewed changes from all six commits to the checksum-verified source before compilation.

## Package Contract

The shared native-package builder applies the patch only after verifying the source archive.
It runs the complete existing libssh2 test selection against the local OpenSSH fixture.
That selection contains 22 Docker-defined cases, two SSH server cases, and 18 algorithm cases.

The builder verifies that the replacement library preserves the `libssh2.so.1` soname.
It also rejects a replacement that omits an exported symbol from the original Debian library.
The package replaces only the shared library in the original Debian runtime package.

Every managed base image verifies these requirements:

1. `dpkg-query` reports `1.11.1-1+deb13u1+nemoclaw2`.
2. `libssh2_version(0)` reports `1.11.1`.
3. The root-owned, read-only security inventory records the exact package identity.
4. `dpkg --audit` returns no output in the completed image.

The completed OpenClaw, Hermes, and Deep Agents Code image stages repeat the package, inventory, and runtime assertions.

## Concern Ledger

### LIBSSH2-5 Expanded Public-Key Lists Contain an Uninitialized Entry

- Surface: libssh2 public-key list parsing in all managed base images.
- Severity: High.
- Confidence: high.
- Failure mode: error cleanup can free an uninitialized pointer after the list expands.
- Disposition: backport, build, test, package, and verify the runtime.
- Implementation: initialize the new list entry immediately after a successful allocation.
- Verification: bind the upstream commit, inspect the patch contract, run the complete upstream test selection, and build every managed image on amd64 and arm64.

### LIBSSH2-6 Public-Key Packet Lengths Can Exceed the Packet Limit

- Surface: libssh2 public-key packet parsing in all managed base images.
- Severity: High.
- Confidence: high.
- Failure mode: an oversized length field can cause an offset wrap on a 32-bit build.
- Disposition: backport, build, test, package, and verify the runtime.
- Implementation: reject each affected variable-length element above `LIBSSH2_PACKET_MAXPAYLOAD`.
- Verification: bind the upstream commit, inspect every affected length guard, run the complete upstream test selection, and build every managed image on amd64 and arm64.

The managed image matrix publishes amd64 and arm64 images.
The shared package still carries the upstream size limits so its parsing contract does not depend on the build architecture.

## Downstream Boundaries

The change updates only the patched libssh2 shared library and its package and inventory identities.
It does not change agent configuration, credentials, network policy, runtime entrypoints, or persistent state.

A rollback can select an earlier immutable base-image digest.
That rollback restores the affected libssh2 package and is not a security remediation.

## Removal Condition

Remove the custom libssh2 package after the supported Debian suite publishes a package containing all six reviewed commits.
The Debian package must pass the same source verification, patch, upstream test, symbol, soname, runtime, inventory, and multi-architecture image checks.

## Verification

Required evidence for the commit under review is:

- focused tests for the six upstream commit identities and the two added patch contracts;
- successful patch application to the checksum-verified libssh2 1.11.1 source;
- the complete libssh2 test selection in each native package builder;
- symbol and soname compatibility with the original Debian package;
- exact package and security inventory assertions in all three managed images;
- an empty `dpkg --audit` result in every completed image; and
- successful native amd64 and arm64 builds for the OpenClaw, Hermes, and Deep Agents Code base images.

The native image builds, publication, and vulnerability rescan remain external gates.
