<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Sandbox base native package review: libssh2 and Python HTMLParser

Date: 2026-07-27

## Scope

This review covers two temporary native-package remediations shared by the OpenClaw, Hermes, and Deep Agents Code base images:

- backport the reviewed upstream fixes for CVE-2026-66032, CVE-2026-66033, CVE-2026-66034, and CVE-2026-66035 to libssh2 1.11.1; and
- backport the reviewed CPython 3.13 fix for CVE-2026-15308 to Debian's Python 3.13.5 standard library.

The supported Debian suite has not published packages containing these fixes.
The changes preserve the existing image behavior and do not create a new integration or product surface.

## Reviewed identities

| Component | Input identity | Fixed identity | Upstream fix |
| --- | --- | --- | --- |
| libssh2 | `libssh2-1t64=1.11.1-1+deb13u1` | `libssh2-1t64=1.11.1-1+deb13u1+nemoclaw1` | `5e4776146552d898b9c0e1b313cd093fa8dc92d0`, `a2ed82d40964bbc0d64cd717aa0a5a892117d2e6`, `a13bb6c773f0d55ad1628cede57e99803cd898d9`, and `42e33d81577ed4b95d4b4f6f845e5ee8efe5eeb4` |
| Python HTMLParser | `libpython3.13-stdlib=3.13.5-2+deb13u4` | `nemoclaw-python3.13-htmlparser-fix=3.13.5-2+deb13u4+nemoclaw1` | `7933f4bf7131aa4140750f9404f5de0aa2969ced` |

The libssh2 source archive is bound to SHA-256 `9954cb54c4f548198a7cbebad248bdc87dd64bd26185708a294b2b50771e3769`.
The original Debian packages are downloaded from the immutable `20260724T000000Z` Debian snapshot.
The original Debian package SHA-256 values are:

| Package | amd64 | arm64 |
| --- | --- | --- |
| `libssh2-1t64_1.11.1-1+deb13u1` | `915c4ec450a369d430e0151f9e10e25044ea2f0d6e41901e00a9317e232e5683` | `600c2a845d6d14d292c765382bc7e644898762e1634a4aecf5b85329622dbbfe` |
| `libpython3.13-stdlib_3.13.5-2+deb13u4` | `0def2d972310b59704ad119abee5a97f95409e14ff1359edd8cc7b8892cfd43f` | `37cce6086b7c1ca93086f83b68761737607689e634693b6972b5dbfd6c080872` |

The unmodified Debian `html/parser.py` input is bound to SHA-256 `f91ec3de6331206bbe2ec3e54a05f646bd23d3c61a18d4a01b25164e070bacc9`.
The fixed file is bound to SHA-256 `4ff43a8578bda2f14686c67911b64c18e869841973722b1c623b5727491bdaf7`.
The file contains the reviewed upstream batching fix plus an empty-input guard so repeated `feed("")` calls remain no-ops instead of accumulating pending entries.

## Package contracts

The shared builder applies the reviewed patches only after verifying the source artifacts.
It builds libssh2 with OpenSSL and zlib support and runs all 43 upstream test cases against a local OpenSSH fixture.
The builder disables only libssh2's nested Docker orchestration, which is unavailable during an image build, and executes those same cases against the fixture directly.
It then verifies the `libssh2.so.1` soname and rejects a build that removes any exported symbol from the original Debian library.
It then replaces only the shared library in the original Debian runtime package and records the NemoClaw package revision.

The Python fix package owns only `/usr/lib/python3.13/html/parser.py`.
It depends on the exact Debian `libpython3.13-stdlib=3.13.5-2+deb13u4` input and declares the narrow file replacement for that version.
This avoids changing Python's exact internal package dependency chain while making the fixed file visible as a separate dpkg identity.

Every managed base image:

1. installs both native packages;
2. verifies their exact dpkg versions;
3. verifies the fixed HTMLParser file hash;
4. verifies that `html.parser` resolves to the exact hashed file;
5. verifies 20,000 empty `feed()` calls leave no pending entries and exercises incremental HTML comment parsing across 20,000 input chunks;
6. loads `libssh2.so.1` and verifies the 1.11.1 runtime identity;
7. records both packages in the root-owned, read-only security inventory; and
8. removes the temporary package artifacts.

The completed production images repeat the inventory, package, file, and runtime checks and require an empty `dpkg --audit` result.

## Concern ledger

### SEC-1: libssh2 1.11.1 lacks four upstream memory-safety fixes

- Surface: native SSH2 client library
- Severity: high
- Confidence: high
- Failure mode: malformed SSH, SFTP, or public-key data can reach missing bounds or lifetime checks.
- Disposition: backport, build, test, package, runtime-proof
- Validation: native amd64 and arm64 image builds passed for all managed images.

### SEC-2: Python 3.13.5 HTMLParser repeatedly rescans incomplete input

- Surface: Python standard library
- Severity: high
- Confidence: high
- Failure mode: repeated small `feed()` calls with an unterminated construct can cause quadratic CPU consumption.
- Disposition: backport, package, file-hash-proof, behavior-test
- Validation: native amd64 and arm64 image builds passed for all managed images.

## Removal conditions

Remove the libssh2 backport after the supported Debian suite publishes a package containing all four reviewed commits and that package passes the same symbol, upstream test, runtime, and multi-architecture image checks.

Remove the Python file replacement after the supported Debian suite publishes a Python 3.13 package containing commit `7933f4bf7131aa4140750f9404f5de0aa2969ced` or its reviewed successor and the replacement passes the same incremental-parser and multi-architecture image checks.

## Verification

Required evidence for the final pull-request head:

- shared-builder syntax and immutable-input contract tests;
- exact base-package and completed-image contract tests for all three managed images on amd64 and arm64;
- the full libssh2 upstream test suite in each native builder;
- symbol and soname compatibility against the original Debian libssh2 package;
- repository formatting and type checks; and
- successful native base-image builds for all managed images.
