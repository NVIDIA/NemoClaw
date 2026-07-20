// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runDebugCommandWithOptions } from "./debug-command";

describe("debug command", () => {
  it("runs parsed debug options and falls back to the default sandbox", async () => {
    const runDebug = vi.fn().mockResolvedValue(undefined);
    await runDebugCommandWithOptions(
      { quick: true, output: "/tmp/out.tgz" },
      {
        getDefaultSandbox: () => "alpha",
        isSandboxKnown: () => true,
        runDebug,
      },
    );
    expect(runDebug).toHaveBeenCalledWith({
      quick: true,
      output: "/tmp/out.tgz",
      sandboxName: "alpha",
    });
  });

  it("accepts an explicit --sandbox name that is registered", async () => {
    const runDebug = vi.fn().mockResolvedValue(undefined);
    const isSandboxKnown = vi.fn().mockReturnValue(true);
    await runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        getDefaultSandbox: () => undefined,
        isSandboxKnown,
        runDebug,
      },
    );
    expect(isSandboxKnown).toHaveBeenCalledWith("alpha");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("returns the debug operation completion promise", async () => {
    let resolveDebug!: () => void;
    const debugCompletion = new Promise<void>((resolve) => {
      resolveDebug = resolve;
    });
    const runDebug = vi.fn(() => debugCompletion);

    const completion = runDebugCommandWithOptions(
      { quick: true },
      {
        getDefaultSandbox: () => "alpha",
        isSandboxKnown: () => true,
        runDebug,
      },
    );

    expect(completion).toBe(debugCompletion);
    resolveDebug();
    await expect(completion).resolves.toBeUndefined();
  });

  it("propagates a rejected debug operation", async () => {
    const failure = new Error("diagnostic collection failed");
    const runDebug = vi.fn().mockRejectedValue(failure);

    await expect(
      runDebugCommandWithOptions(
        { quick: true },
        {
          getDefaultSandbox: () => "alpha",
          isSandboxKnown: () => true,
          runDebug,
        },
      ),
    ).rejects.toBe(failure);
  });

  it("rejects an explicit --sandbox name that is not registered, exits non-zero, skips runDebug", () => {
    const runDebug = vi.fn();
    const errorLines: string[] = [];
    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;
    expect(() =>
      runDebugCommandWithOptions(
        { sandboxName: "does-not-exist", output: "/tmp/out.tgz" },
        {
          getDefaultSandbox: () => "alpha",
          isSandboxKnown: () => false,
          runDebug,
          errorLine: (msg) => errorLines.push(msg),
          exit,
        },
      ),
    ).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(runDebug).not.toHaveBeenCalled();
    expect(errorLines[0]).toContain("does-not-exist");
    expect(errorLines[0]).toContain("not registered");
    expect(errorLines.join("\n")).toContain("nemoclaw list");
  });

  it("validates an env-sourced sandbox name and reports the env source on failure", () => {
    const runDebug = vi.fn();
    const errorLines: string[] = [];
    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;
    expect(() =>
      runDebugCommandWithOptions(
        {},
        {
          env: { NEMOCLAW_SANDBOX_NAME: "ghost" } as NodeJS.ProcessEnv,
          getDefaultSandbox: () => "alpha",
          isSandboxKnown: () => false,
          runDebug,
          errorLine: (msg) => errorLines.push(msg),
          exit,
        },
      ),
    ).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(runDebug).not.toHaveBeenCalled();
    expect(errorLines[0]).toContain("ghost");
    expect(errorLines[0]).toContain("NEMOCLAW_SANDBOX_NAME");
  });

  it("prefers NEMOCLAW_SANDBOX_NAME over NEMOCLAW_SANDBOX and SANDBOX_NAME", async () => {
    const runDebug = vi.fn().mockResolvedValue(undefined);
    const isSandboxKnown = vi.fn().mockReturnValue(true);
    await runDebugCommandWithOptions(
      {},
      {
        env: {
          NEMOCLAW_SANDBOX_NAME: "primary",
          NEMOCLAW_SANDBOX: "secondary",
          SANDBOX_NAME: "tertiary",
        } as NodeJS.ProcessEnv,
        getDefaultSandbox: () => undefined,
        isSandboxKnown,
        runDebug,
      },
    );
    expect(isSandboxKnown).toHaveBeenCalledWith("primary");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "primary" });
  });

  it("flag overrides env vars when both are present", async () => {
    const runDebug = vi.fn().mockResolvedValue(undefined);
    const isSandboxKnown = vi.fn().mockReturnValue(true);
    await runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        env: { NEMOCLAW_SANDBOX: "beta" } as NodeJS.ProcessEnv,
        getDefaultSandbox: () => undefined,
        isSandboxKnown,
        runDebug,
      },
    );
    expect(isSandboxKnown).toHaveBeenCalledWith("alpha");
    expect(isSandboxKnown).not.toHaveBeenCalledWith("beta");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("falls back to getDefaultSandbox when neither flag nor env is set", async () => {
    const runDebug = vi.fn().mockResolvedValue(undefined);
    const isSandboxKnown = vi.fn();
    await runDebugCommandWithOptions(
      {},
      {
        env: {} as NodeJS.ProcessEnv,
        getDefaultSandbox: () => "alpha",
        isSandboxKnown,
        runDebug,
      },
    );
    expect(isSandboxKnown).not.toHaveBeenCalled();
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });
});
