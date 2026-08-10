// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dockerExecFileSync, dockerSpawnSync, run } = vi.hoisted(() => ({
  dockerExecFileSync: vi.fn(() => ""),
  dockerSpawnSync: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
  run: vi.fn(() => ({ status: 0 })),
}));

vi.mock("../runner", () => ({
  ROOT: "/mock/root",
  redact: vi.fn((value) => value),
  run,
  runCapture: vi.fn(() => "version: 1\nnetwork_policies: {}"),
  shellQuote: vi.fn((value) => `'${value}'`),
  validateName: vi.fn((value) => value),
}));

vi.mock("../adapters/docker/exec", () => ({
  dockerExecFileSync,
  dockerSpawnSync,
}));

let testRoot: string;

function stateDir(): string {
  return path.join(testRoot, ".nemoclaw", "state");
}

describe("pinned Shields startup access", () => {
  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shields-startup-access-"));
    vi.stubEnv("HOME", testRoot);
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(testRoot, { force: true, recursive: true });
  });

  it("refuses expired inline auto-restore before mutating a replacement container (#8662)", async () => {
    const sandboxName = "openclaw";
    const snapshotPath = path.join(stateDir(), "policy-snapshot-pinned-startup.yaml");
    const statePath = path.join(stateDir(), `shields-${sandboxName}.json`);
    const markerPath = path.join(stateDir(), `shields-timer-${sandboxName}.json`);
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(snapshotPath, "version: 1\nnetwork_policies: {}\n");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        shieldsDown: true,
        shieldsDownAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        shieldsDownPolicy: "permissive",
        shieldsDownReason: "testing pinned startup",
        shieldsDownTimeout: 300,
        shieldsPolicySnapshotPath: snapshotPath,
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      markerPath,
      JSON.stringify({
        pid: 2_147_483_647,
        processToken: "a".repeat(32),
        restoreAt: new Date(Date.now() - 1_000).toISOString(),
        sandboxName,
        snapshotPath,
      }),
      { mode: 0o600 },
    );
    const stateBefore = fs.readFileSync(statePath, "utf8");
    const { restoreLockedStateDirStartupAccess } = await import("./index");

    let failure: unknown;
    try {
      restoreLockedStateDirStartupAccess(sandboxName, "b".repeat(64));
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "NEMOCLAW_SHIELDS_AUTO_RESTORE_REQUIRED",
      message: expect.stringContaining(
        "Expired Shields auto-restore must complete before startup access can be repaired",
      ),
    });
    expect(run).not.toHaveBeenCalled();
    expect(dockerExecFileSync).not.toHaveBeenCalled();
    expect(dockerSpawnSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath, "utf8")).toBe(stateBefore);
    expect(fs.existsSync(markerPath)).toBe(true);
  });
});
