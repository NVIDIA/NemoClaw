// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureAgentFixedForward } from "./agent-fixed-forward";
import { runDetachedForwardStartWithRetries } from "./forward-start";

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

  it("rechecks sandbox identity before each fixed-forward start (#9833)", () => {
    const deps = makeDeps(() => "");
    const revalidateSandboxIdentity = vi
      .fn<(operation: string) => void>()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });
    vi.mocked(runDetachedForwardStartWithRetries).mockImplementationOnce((runSpawn) => {
      runSpawn({ stdout: 1, stderr: 2 });
      return { ok: true, diagnostic: "", reason: "ok" };
    });

    expect(() =>
      ensureAgentFixedForward(
        deps,
        "my-sandbox",
        18789,
        "messaging webhook",
        revalidateSandboxIdentity,
      ),
    ).toThrow("sandbox identity changed");

    expect(deps.runOpenshell).toHaveBeenCalledWith(
      ["forward", "stop", "18789", "my-sandbox"],
      expect.anything(),
    );
    expect(revalidateSandboxIdentity).toHaveBeenCalledTimes(2);
  });
});
