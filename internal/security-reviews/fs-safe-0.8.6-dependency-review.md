<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# fs-safe 0.8.6 Dependency Review

> Internal engineering evidence. This file is not part of the public documentation set.

## Status and Scope

Issue #11174 accepts `@openclaw/fs-safe@0.8.6` for the snapshot sanitizer boundary.
The dependency replaces the host `python3` helper with the current Node.js executable and the package's native filesystem operations.
The root CLI package and standalone plugin package both declare the exact dependency because each is installed independently in a supported distribution path.

This review covers snapshot tree reads, identity checks, bounded content reads, atomic replacements, exclusive file creation, and contained removal.
It does not qualify other `fs-safe` APIs or replace the separate in-sandbox Python runtime requirements.

## Source and Package Identity

The upstream source audit started at `v0.4.1`, the version already present in the reviewed OpenClaw runtime graph, and ended at `v0.8.6`.
The release-ledger collector verified the canonical `openclaw/fs-safe` repository identity twice and traversed every adjacent release and commit.

| Evidence | Reviewed value |
| --- | --- |
| Start tag commit | `de07f4f69176a69de2ca389fd49d63454b42322b` |
| Target tag commit | `733bc50c81b9d84c5cb075f5760150bacc9b58c6` |
| Target annotated tag object | `ef14852f85825568a38f383302192e81d0216575` |
| Package | `@openclaw/fs-safe@0.8.6` |
| Package integrity | `sha512-0Rc0bzd7zz26PiRGzeFtK3VLdKtCQSUu/mXsKC6T6/FlVDvKmz8PU87AdFMWBxo2zge1nZC0vuPegaJB+bnO5w==` |
| Package license | MIT |
| Release-ledger SHA-256 | `ace2213bcfdf3eac249889b756ac4cee720a03e8d555464fcb77bb81ba9adaa1` |
| Audit date | September 7, 2026 |

The selected native packages are exact optional dependencies of `@openclaw/fs-safe`.

| Platform package | SHA-512 integrity |
| --- | --- |
| `@openclaw/fs-safe-darwin-arm64@0.8.6` | `sha512-zNlkX361isXsN0exKQnp2bAhJ7A5XuHjoaklXxc6UTqNaMF9rppYyJguwnWhF2J9sszDjuZ4CpO0wHfydD+xiQ==` |
| `@openclaw/fs-safe-darwin-x64@0.8.6` | `sha512-J7bV+MQYfnjcc/ZGgTk4M3YgCaZ9HQKUjmP+fyadvgIYcRUwXiobuHfOkJ4K+Yu3T+/p/XRCvMQ8v2IyhERbvg==` |
| `@openclaw/fs-safe-linux-arm64-gnu@0.8.6` | `sha512-JxRHRsd2hynt9h5yr/W3e7OhTwxu5LhZ0LTOrKj1cEJbCkD+HJgRRh7t7LRHvH4cLSJ+n24UjcqZ3bYZjibz1w==` |
| `@openclaw/fs-safe-linux-arm64-musl@0.8.6` | `sha512-vj8avfGOYadlYIWPE0Dk9RB90fLPtfAfXzDCT/3PJKzB38oKcB732johDr7i85K6uTCf085x8yTZ0anzhvNCKw==` |
| `@openclaw/fs-safe-linux-x64-gnu@0.8.6` | `sha512-MFZZiYDz1scX/tNgIa93rqTrWJXVxV8+HY7E1vwJxwIX7ucgP/H6BLXWGdu6FYokhY6hHSeAsfOY/8sw1mMxPg==` |
| `@openclaw/fs-safe-linux-x64-musl@0.8.6` | `sha512-rtc1Kw9igbG3CB/x7FqT62tcqxKDIXHn0EIE6DafxfSPJIJWTsmSth3k/JH+CJXI9aRPF+4EtrzL7cZhtDamHw==` |
| `@openclaw/fs-safe-win32-x64-msvc@0.8.6` | `sha512-x0nmvrubsC0AulfSuyNWcIUkq1gR/y8Fw0Ztk5uvwfCVrPELI9UEZtgT3S3nC+tHp1dBsspfBSid1LrQMWY1LA==` |

The root and plugin locks bind these packages to the public npm registry and the listed integrity values.
The packages declare no install lifecycle scripts.
The native packages are MIT licensed.
The optional archive graph is not imported by the sanitizer and resolves to MIT, ISC, Zlib, and dual MIT or GPL-3.0-or-later licensed packages.
The checked-in Linux x64 glibc npm cache seed was regenerated from the plugin lock.
Its 100-archive manifest binds lock SHA-256 `3a3eab9fc8062d0073b132b4d4c2994308497410d37fe1170899642a97451add` and includes the exact `fs-safe` package, selected native package, and reachable optional archive graph for offline image builds.

## Adjacent Release Audit

The audit covered `0.4.2` through `0.8.6` without skipping an adjacent release.
The relevant changes are:

- `0.5.0` introduced the native helper, descriptor-relative root operations, guarded directory creation, hard-link controls, and atomic no-replace publication.
- `0.5.1` through `0.5.6` tightened path parsing, descriptor modes, overwrite containment, file identity, cleanup, and publication verification.
- `0.6.0` moved native binaries into exact-version, platform-specific optional packages and removed consumer-side native builds.
- `0.7.0` through `0.7.2` strengthened exact file identities, nonblocking special-file handling, retained staging, and cleanup outcomes.
- `0.8.0` through `0.8.6` tightened native-required behavior, mode and durability semantics, lock handling, mutation authority, hard-link policy, and platform-filesystem guidance.

No adjacent release reintroduced an install script, runtime download, Python interpreter dependency, or consumer Rust build.

## Runtime Contract

The sanitizer launches the already-running `process.execPath` with a packaged `.mjs` helper and a minimal environment.
The helper configures `fs-safe` with `configureFsSafeNative({ mode: "require" })` and completes a native-required retained-directory staging probe before it reads a snapshot.
The probe uses the host temporary directory, verifies native publication support, removes its identity-bound empty stage, and rejects any incomplete cleanup.
It uses a capability root that rejects symlinks, reads through verified open handles, compares complete bigint metadata before mutation, rejects multiply linked mutation targets, and retains the existing 16 MiB per-file, 32 MiB aggregate, and 100,000-entry limits.
Replacements and exclusive creates use `fs-safe`'s native publication path.
Removal uses the package's root-contained removal operation after the same identity and hard-link checks.

The helper returns only a structured success or failure envelope.
It does not return dependency paths, native loader details, snapshot content, or exception text.
When native-probe cleanup retains its empty staged file, the envelope includes only that validated direct-child path under the system temporary directory so the operator can remove it before retrying.
The shared protocol module owns the per-file limit, request and response types, and accepted failure-code set used by both processes.
The parent maps a missing or unsupported native binding to the existing prerequisite error class with a fixed remediation message and maps other helper or process failures to fixed, non-sensitive operation codes.

## Concern Records

### DEP-1 Package or Native Artifact Substitution

- Severity and confidence: high, high confidence.
- Failure mode: candidate code loads another package version or a native binary for a different release.
- Control: both manifests pin `0.8.6`; both lockfiles bind registry URLs and SHA-512 integrity; all platform packages are exact `0.8.6` dependencies.
- Verification: package-contract tests, reviewed npm graph audit, registry signature verification, and lockfile review.

### DEP-2 Missing Optional Native Package

- Severity and confidence: high, high confidence.
- Failure mode: an install that omits optional dependencies falls back to weaker pathname operations.
- Control: the helper requires native mode, completes a native-required capability probe before reading the snapshot, and reports a fixed prerequisite error when the platform binding is unavailable.
- Verification: focused unavailable-helper tests and the compiled package test.

### DEP-3 Snapshot Containment Regression

- Severity and confidence: high, high confidence.
- Failure mode: a changed file, parent, symlink, or hard link redirects a credential-bearing read or mutation.
- Control: the capability root rejects symlinks; open-handle metadata is compared before mutation; multiply linked targets are rejected; native publication pins the destination root and parent.
- Verification: sanitizer behavior, parent-swap, destination-symlink, root-disappearance, hard-link, malformed-protocol, and noncanonical-content tests.

### DEP-4 Unbounded Input or Output

- Severity and confidence: high, high confidence.
- Failure mode: a hostile snapshot exhausts memory or leaves the synchronous parent blocked.
- Control: the helper preserves entry and byte limits; the parent preserves a 48 MiB output limit and 60-second process timeout.
- Verification: maximum-size, oversized, malformed base64, and tree sanitation tests.

### DEP-5 Install-Time Code Execution and License Drift

- Severity and confidence: medium, high confidence.
- Failure mode: installation executes dependency code or redistributes incompatible license terms.
- Control: the reviewed graph declares no install lifecycle script; the selected runtime and optional graph licenses are compatible with redistribution under the repository's existing third-party notice process.
- Verification: lockfile metadata review and package-install commands with scripts disabled.

### DEP-6 Independent Distribution Paths

- Severity and confidence: high, high confidence.
- Failure mode: the root CLI works from a source checkout but the standalone plugin image or published package cannot resolve the native helper.
- Control: the dependency is direct in both manifests; the shared compiler emits the boundary, helper, and protocol modules; CLI artifact packaging and restoration require all three modules; the locked Linux x64 glibc npm cache seed contains the complete target-specific graph.
- Verification: clean shared-boundary build, plugin build, package contract, E2E artifact packaging tests, cache-seed integrity contract, and native amd64/arm64 PR CI.

## Verification Evidence

On September 7, 2026:

- `npm audit --omit=dev` reported zero vulnerabilities in the root production graph.
- `npm --prefix nemoclaw audit --omit=dev` reported zero vulnerabilities in the plugin production graph.
- `npm audit signatures --omit=dev` reported no missing or invalid registry signatures.
- A Linux arm64 glibc host loaded the locked native package and passed the focused sanitizer suite.
- The cache-seed exporter validated 100 lock-pinned Linux x64 glibc archives, including `fs-safe-0.8.6.tgz` and `fs-safe-linux-x64-gnu-0.8.6.tgz`.

## Remaining Gates

- Required CI must exercise the locked packages on its supported host matrix.
- The reviewed npm audit and signature gates must accept the final lockfiles.
- A later `fs-safe` version requires a new adjacent release audit and updated immutable identities.
