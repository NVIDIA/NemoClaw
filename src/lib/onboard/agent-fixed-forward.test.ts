// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureAgentFixedForward } from "./agent-fixed-forward";

vi.mock("./forward-start", () => ({
  buildDetachedForwardStartSpawn: vi.fn(() => vi.fn()),
  buildForwardStartProgressLogger: vi.fn(() => vi.fn()),
  runDetachedForwardStartWithRetries: vi.fn(() => ({ ok: true, diagnostic: "" })),
}));

function makeDeps(runCaptureOpenshell: () => string | null) {
  return {
    runOpenshell: vi.fn(() => ({ status: 0 })),
    runCaptureOpenshell: vi.fn(runCaptureOpenshell),
    openshellArgv: (args: string[]) => ["openshell", ...args],
    cliName: () => "nemoclaw",
    sleep: vi.fn(),
  };
}

describe("ensureAgentFixedForward", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips the stop when the capture runner reports a failed `forward list` (#8522)", () => {
    const deps = makeDeps(() => null);

    const started = ensureAgentFixedForward(deps, "my-sandbox", 18789, "messaging webhook");

    expect(started).toBe(true);
    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(deps.runOpenshell).not.toHaveBeenCalled();
  });

  it("runs a sandbox-scoped `forward stop` when the `forward list` is genuinely empty (#8522)", () => {
    const deps = makeDeps(() => "SANDBOX   BIND        PORT   PID    STATUS");

    const started = ensureAgentFixedForward(deps, "my-sandbox", 18789, "messaging webhook");

    expect(started).toBe(true);
    expect(deps.runCaptureOpenshell).toHaveBeenCalledWith(
      ["forward", "list"],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(deps.runOpenshell).toHaveBeenCalledWith(["forward", "stop", "18789", "my-sandbox"], {
      ignoreError: true,
      suppressOutput: true,
    });
  });
});
