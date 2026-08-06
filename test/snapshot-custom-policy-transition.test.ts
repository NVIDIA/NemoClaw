// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("snapshot policy transition guard (#8176)", () => {
  let tempHome: string;
  let registry: typeof import("../src/lib/state/registry");
  let backupSandboxState: typeof import("../src/lib/state/sandbox").backupSandboxState;

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-snapshot-policy-journal-"));
    vi.stubEnv("HOME", tempHome);
    vi.resetModules();
    registry = await import("../src/lib/state/registry");
    ({ backupSandboxState } = await import("../src/lib/state/sandbox"));
    registry.registerSandbox({ name: "alpha", agent: "openclaw" });
    const previous = {
      name: "private-api",
      content: "network_policies:\n  private_api: {}\n",
      appliedAt: "2026-08-06T12:00:00.000Z",
    };
    expect(registry.addCustomPolicy("alpha", previous)).toBe(true);
    expect(
      registry.beginCustomPolicyTransition("alpha", {
        version: 1,
        id: "123e4567-e89b-42d3-a456-426614174091",
        operation: "remove",
        name: previous.name,
        previous,
        desired: null,
        startedAt: "2026-08-06T12:02:00.000Z",
      }),
    ).toBe(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("fails before creating backup artifacts", () => {
    const result = backupSandboxState("alpha", { name: "must-not-exist" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("needs repair before snapshot or rebuild backup"),
    });
    expect(fs.existsSync(path.join(tempHome, ".nemoclaw", "rebuild-backups", "alpha"))).toBe(false);
  });

  it("fails before creating backup artifacts for a baseline policy journal", () => {
    expect(
      registry.clearCustomPolicyTransition("alpha", "123e4567-e89b-42d3-a456-426614174091"),
    ).toBe(true);
    expect(
      registry.beginBaselineExclusionTransition("alpha", {
        id: "0b2f3297-a9ab-4c2f-80da-bf1760a1afbf",
        operation: "restore",
        exclusion: {
          version: 1,
          agent: "openclaw",
          key: "agents.openclaw.default",
          digest: "a".repeat(64),
        },
        startedAt: "2026-08-06T12:02:00.000Z",
        targetLiveDigest: "b".repeat(64),
      }),
    ).toBe(true);

    const result = backupSandboxState("alpha", { name: "must-not-exist" });

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("needs repair before snapshot or rebuild backup"),
    });
    expect(fs.existsSync(path.join(tempHome, ".nemoclaw", "rebuild-backups", "alpha"))).toBe(false);
  });
});
