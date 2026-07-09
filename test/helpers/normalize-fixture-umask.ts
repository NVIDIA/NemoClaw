// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Normalize the test worker's file-creation umask to the conventional CI value
// (0o022) before any test runs.
//
// Several Hermes/OpenClaw suites build fixture files (config.yaml, .env,
// .config-hash, strict hash files) in system temp directories and then feed
// them to the production runtime-config guard
// (agents/hermes/runtime-config-guard.py). That guard fails closed on
// group/world-writable runtime config paths (`mode & 0o022`). On a fresh
// developer checkout whose ambient umask is permissive (for example 0002 on
// Ubuntu 24.04 / CI-like hosts), fixture files are created group-writable
// (0o664) and the guard rejects them with
// `UnsafePathError: refusing group/world-writable runtime config path`, failing
// the tests before they reach their intended assertions (#6448).
//
// Child fixture processes (python3/bash spawned via spawnSync) inherit this
// umask, so pinning it once per worker makes every fixture file be created with
// the same deterministic modes CI produces.
//
// The value is exactly 0o022 — the conventional CI umask the fixture tests were
// written against. Several tests assert those exact group-readable modes (for
// example a Hermes .env at 0o640), so the baseline must be 0o022 rather than the
// caller's ambient umask: a permissive caller (0o002) would create
// group-writable fixtures the guard rejects, and a stricter caller (0o077) would
// drop the group-read bit those assertions expect. This setup is intentionally
// not applied to the live-E2E project, which handles real credentials and sets
// its own strict `umask 077` inline where privacy matters.
process.umask(0o022);
