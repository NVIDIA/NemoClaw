// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { printSandboxCreateRecoveryHints, shouldIncludeBuildContextPath } from "../../dist/lib/build-context";

type ConsoleErrorSpy = ReturnType<typeof vi.spyOn>;

describe("build context filtering", () => {
  it("filters local-only artifacts out of the sandbox build context", () => {
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/orchestrator/main.py",
      ),
    ).toBe(true);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/.venv/bin/python",
      ),
    ).toBe(false);
    expect(
      shouldIncludeBuildContextPath(
        "/repo/nemoclaw-blueprint",
        "/repo/nemoclaw-blueprint/.ruff_cache/cache",
      ),
    ).toBe(false);
  });
});

describe("printSandboxCreateRecoveryHints", () => {
  let errorSpy: ConsoleErrorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function stderr(): string {
    return errorSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
  }

  it("prints resume guidance when sandbox image upload times out", () => {
    printSandboxCreateRecoveryHints("failed to read image export stream");

    expect(stderr()).toContain("image upload into the OpenShell gateway timed out");
    expect(stderr()).toContain("onboard --resume");
    expect(stderr()).toContain("Docker memory");
  });

  it("prints progress-specific resume guidance when upload reached the gateway", () => {
    printSandboxCreateRecoveryHints(
      [
        "[progress] Uploaded to gateway",
        "failed to read image export stream",
      ].join("\n"),
    );

    expect(stderr()).toContain("reuse existing gateway state");
  });

  it("prints resume guidance when sandbox image upload resets after transfer progress", () => {
    printSandboxCreateRecoveryHints(
      [
        "Image openshell/sandbox-from:123 is available in the gateway.",
        "Connection reset by peer",
      ].join("\n"),
    );

    expect(stderr()).toContain("image push/import stream was interrupted");
    expect(stderr()).toContain("onboard --resume");
    expect(stderr()).toContain("reached the gateway");
  });
});
