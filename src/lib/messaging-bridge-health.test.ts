// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./resolve-openshell.js", () => ({
  resolveOpenshell: vi.fn(() => "/usr/local/bin/openshell"),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

import { checkMessagingBridgeHealth } from "./messaging-bridge-health.js";
import { spawnSync } from "node:child_process";
import { resolveOpenshell } from "./resolve-openshell.js";

const spawnSyncMock = vi.mocked(spawnSync);
const resolveOpenshellMock = vi.mocked(resolveOpenshell);

type SpawnResult = ReturnType<typeof spawnSync>;
function mockSpawn(overrides: Partial<SpawnResult> = {}): void {
  spawnSyncMock.mockReturnValue({
    pid: 0,
    output: [],
    stdout: "",
    stderr: "",
    status: 0,
    signal: null,
    ...overrides,
  } as unknown as SpawnResult);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveOpenshellMock.mockReturnValue("/usr/local/bin/openshell");
});

describe("checkMessagingBridgeHealth", () => {
  it("returns empty and does not spawn when channels does not include telegram", () => {
    const result = checkMessagingBridgeHealth("alpha", ["discord", "slack"]);
    expect(result).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns empty and does not spawn when channels is null/undefined", () => {
    expect(checkMessagingBridgeHealth("alpha", null)).toEqual([]);
    expect(checkMessagingBridgeHealth("alpha", undefined)).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns empty when openshell binary cannot be resolved", () => {
    resolveOpenshellMock.mockReturnValue(null);
    const result = checkMessagingBridgeHealth("alpha", ["telegram"]);
    expect(result).toEqual([]);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });

  it("returns a conflict entry when gateway log reports N conflicts", () => {
    mockSpawn({ stdout: "32\n" });
    expect(checkMessagingBridgeHealth("alpha", ["telegram"])).toEqual([
      { channel: "telegram", conflicts: 32 },
    ]);
  });

  it("returns empty when the conflict count is zero", () => {
    mockSpawn({ stdout: "0\n" });
    expect(checkMessagingBridgeHealth("alpha", ["telegram"])).toEqual([]);
  });

  it("returns empty when the count is non-numeric", () => {
    mockSpawn({ stdout: "\n" });
    expect(checkMessagingBridgeHealth("alpha", ["telegram"])).toEqual([]);
  });

  it("returns empty when spawnSync throws", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("spawn EPIPE");
    });
    expect(checkMessagingBridgeHealth("alpha", ["telegram"])).toEqual([]);
  });

  it("returns empty when spawnSync reports a non-zero exit status (exec failed)", () => {
    mockSpawn({ stderr: "/bin/bash: alpha: command not found\n", status: 127 });
    expect(checkMessagingBridgeHealth("alpha", ["telegram"])).toEqual([]);
  });

  it("returns empty when spawnSync returns an error object (e.g. timeout)", () => {
    mockSpawn({
      stdout: null as unknown as string,
      stderr: null as unknown as string,
      status: null,
      signal: "SIGTERM",
      error: new Error("spawnSync timed out"),
    });
    expect(checkMessagingBridgeHealth("alpha", ["telegram"])).toEqual([]);
  });

  // Regression for #2018: `openshell sandbox exec` requires the --name/-n
  // flag. Passing the sandbox name as a positional causes the name to be
  // interpreted as the first word of the command and fails with exit 127.
  describe("argv shape (#2018 regression)", () => {
    beforeEach(() => mockSpawn({ stdout: "5\n" }));

    it("passes the sandbox name via --name/-n, not as a positional", () => {
      checkMessagingBridgeHealth("tele-brev", ["telegram"]);

      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [binary, args] = spawnSyncMock.mock.calls[0];
      expect(binary).toBe("/usr/local/bin/openshell");

      const argsArray = args as string[];
      const nameFlagIdx = argsArray.indexOf("-n");
      expect(nameFlagIdx).toBeGreaterThan(-1);
      expect(argsArray[nameFlagIdx + 1]).toBe("tele-brev");

      // Pre-fix, args were ["sandbox", "exec", "<name>", "sh", "-c", <script>].
      // Ensure the sandbox name is not directly adjacent to "exec" (positional).
      const execIdx = argsArray.indexOf("exec");
      expect(argsArray[execIdx + 1]).not.toBe("tele-brev");
    });

    it("separates the command from flags with `--`", () => {
      checkMessagingBridgeHealth("tele-brev", ["telegram"]);
      const [, args] = spawnSyncMock.mock.calls[0];
      const argsArray = args as string[];
      const sepIdx = argsArray.indexOf("--");
      expect(sepIdx).toBeGreaterThan(-1);
      expect(argsArray[sepIdx + 1]).toBe("sh");
      expect(argsArray[sepIdx + 2]).toBe("-c");
    });
  });
});
