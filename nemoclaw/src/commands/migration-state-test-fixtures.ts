// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { HostOpenClawState, SnapshotManifest } from "./migration-state.js";

/**
 * Data builders for the migration-state test suites. Each builder returns the
 * ordinary valid baseline with fresh nested arrays and objects; tests override
 * only the fields their scenario changes. The sanitizer module mock lives in
 * migration-state-sanitizer-test-fixture.ts.
 */

/** The detected host state for a standard ~/.openclaw installation. */
export function makeHostOpenClawState(overrides?: Partial<HostOpenClawState>): HostOpenClawState {
  return {
    exists: true,
    homeDir: "/home/user",
    stateDir: "/home/user/.openclaw",
    configDir: "/home/user/.openclaw",
    configPath: "/home/user/.openclaw/openclaw.json",
    workspaceDir: null,
    extensionsDir: null,
    skillsDir: null,
    hooksDir: null,
    externalRoots: [],
    warnings: [],
    errors: [],
    hasExternalConfig: false,
    ...overrides,
  };
}

/** A version 2 snapshot manifest for the standard ~/.openclaw installation. */
export function makeSnapshotManifest(overrides?: Partial<SnapshotManifest>): SnapshotManifest {
  return {
    version: 2,
    createdAt: "2026-03-01T00:00:00.000Z",
    homeDir: "/home/user",
    stateDir: "/home/user/.openclaw",
    configPath: null,
    hasExternalConfig: false,
    externalRoots: [],
    warnings: [],
    ...overrides,
  };
}
