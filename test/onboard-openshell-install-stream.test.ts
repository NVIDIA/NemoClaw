// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));

import {
  type RunOpenshellInstallDeps,
  runOpenshellInstall,
} from "../src/lib/onboard/openshell-pin";

function makeDeps(overrides: Partial<RunOpenshellInstallDeps> = {}): RunOpenshellInstallDeps {
  return {
    getBlueprintMaxOpenshellVersion: () => null,
    versionGte: () => true,
    scriptsDir: "/fake/scripts",
    cwd: "/fake/cwd",
    resolveOpenshell: () => null,
    getFutureShellPathHint: () => null,
    setOpenshellBin: () => {},
    ...overrides,
  };
}

describe("runOpenshellInstall progress streaming (#4431)", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("inherits stdio so install-openshell.sh output streams live", () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    runOpenshellInstall(makeDeps());
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const options = spawnSyncMock.mock.calls[0][2];
    expect(options.stdio).toEqual(["ignore", "inherit", "inherit"]);
  });

  it("does not pipe/buffer the child output anymore", () => {
    spawnSyncMock.mockReturnValue({ status: 0 });
    runOpenshellInstall(makeDeps());
    const options = spawnSyncMock.mock.calls[0][2];
    expect(options.stdio).not.toContain("pipe");
  });

  it("normalizes relative component overrides before changing the installer cwd", () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_BIN", "components/openshell-gateway");
    vi.stubEnv("NEMOCLAW_OPENSHELL_SANDBOX_BIN", "components/openshell-sandbox");
    spawnSyncMock.mockReturnValue({ status: 0 });

    runOpenshellInstall(makeDeps());

    const options = spawnSyncMock.mock.calls[0][2];
    expect(options.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN).toBe(
      path.resolve("components/openshell-gateway"),
    );
    expect(options.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN).toBe(
      path.resolve("components/openshell-sandbox"),
    );
  });

  it("removes whitespace-only component overrides before invoking the installer", () => {
    vi.stubEnv("NEMOCLAW_OPENSHELL_GATEWAY_BIN", "   ");
    vi.stubEnv("NEMOCLAW_OPENSHELL_SANDBOX_BIN", "\t");
    spawnSyncMock.mockReturnValue({ status: 0 });

    runOpenshellInstall(makeDeps());

    const options = spawnSyncMock.mock.calls[0][2];
    expect(options.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN).toBeUndefined();
    expect(options.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN).toBeUndefined();
  });

  it("returns a not-installed result without throwing on non-zero exit", () => {
    spawnSyncMock.mockReturnValue({ status: 1 });
    const result = runOpenshellInstall(makeDeps());
    expect(result.installed).toBe(false);
    expect(result.localBin).toBeNull();
    expect(result.futureShellPathHint).toBeNull();
  });
});
