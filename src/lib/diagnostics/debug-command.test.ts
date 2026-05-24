// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runDebugCommandWithOptions } from "../../../dist/lib/diagnostics/debug-command";

describe("debug command", () => {
  it("runs parsed debug options and falls back to the default sandbox", () => {
    const runDebug = vi.fn();
    runDebugCommandWithOptions(
      { quick: true, output: "/tmp/out.tgz" },
      {
        getDefaultSandbox: () => "alpha",
        runDebug,
      },
    );
    expect(runDebug).toHaveBeenCalledWith({
      quick: true,
      output: "/tmp/out.tgz",
      sandboxName: "alpha",
    });
  });

  it("calls runDebug when explicit --sandbox passes validation", () => {
    const runDebug = vi.fn();
    const validateExplicitSandbox = vi.fn(() => ({ ok: true as const }));
    runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        getDefaultSandbox: () => undefined,
        validateExplicitSandbox,
        runDebug,
      },
    );
    expect(validateExplicitSandbox).toHaveBeenCalledWith("alpha");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("fails when explicit --sandbox is not in the registry and does not call runDebug", () => {
    const runDebug = vi.fn();
    const fail = vi.fn((_msg: string, _code?: number) => {
      throw new Error("fail-called");
    }) as unknown as (message: string, exitCode?: number) => never;
    const validateExplicitSandbox = vi.fn(() => ({
      ok: false as const,
      message: "Error: sandbox 'does-not-exist' is not in the local registry.",
    }));
    expect(() =>
      runDebugCommandWithOptions(
        { sandboxName: "does-not-exist", output: "/tmp/x.tgz" },
        {
          getDefaultSandbox: () => undefined,
          validateExplicitSandbox,
          runDebug,
          fail,
        },
      ),
    ).toThrow("fail-called");
    expect(validateExplicitSandbox).toHaveBeenCalledWith("does-not-exist");
    expect(fail).toHaveBeenCalledWith(
      expect.stringContaining("is not in the local registry"),
      1,
    );
    expect(runDebug).not.toHaveBeenCalled();
  });

  it("does not call validateExplicitSandbox when --sandbox is absent", () => {
    const runDebug = vi.fn();
    const validateExplicitSandbox = vi.fn();
    runDebugCommandWithOptions(
      { quick: true },
      {
        getDefaultSandbox: () => "alpha",
        validateExplicitSandbox,
        runDebug,
      },
    );
    expect(validateExplicitSandbox).not.toHaveBeenCalled();
    expect(runDebug).toHaveBeenCalledWith({ quick: true, sandboxName: "alpha" });
  });
});
