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
// umask, so setting it once per worker makes every fixture file be created with
// the same non group/world-writable modes CI already produces under its default
// 0022 umask. We deliberately use 0o022 rather than a stricter value: it strips
// only the group/world *write* bits the guard cares about while leaving read
// bits untouched, so no test that depends on default read permissions changes
// behavior. The production guard stays strict; only the test fixture creation
// environment is normalized.
process.umask(0o022);
