// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { runDebugCommandWithOptions } from "./debug-command";

describe("debug command", () => {
  it("runs parsed debug options and falls back to the default sandbox", async () => {
    const runDebug = vi.fn();
    await runDebugCommandWithOptions(
      { quick: true, output: "/tmp/out.tgz" },
      {
        getDefaultSandbox: async () => "alpha",
        getSandboxAvailability: async () => "available",
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
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn().mockReturnValue("available");
    await runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        getDefaultSandbox: async () => "default",
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).toHaveBeenCalledWith("alpha");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("rejects an explicit --sandbox name that is not registered, exits non-zero, skips runDebug", async () => {
    const runDebug = vi.fn();
    const errorLines: string[] = [];
    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;
    await expect(
      runDebugCommandWithOptions(
        { sandboxName: "does-not-exist", output: "/tmp/out.tgz" },
        {
          getDefaultSandbox: async () => "alpha",
          getSandboxAvailability: async () => "unregistered",
          runDebug,
          errorLine: (msg) => errorLines.push(msg),
          exit,
        },
      ),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(runDebug).not.toHaveBeenCalled();
    expect(errorLines[0]).toContain("does-not-exist");
    expect(errorLines[0]).toContain("not registered");
    expect(errorLines.join("\n")).toContain("nemoclaw list");
  });

  it("identifies an explicit registered sandbox missing from OpenShell", async () => {
    const runDebug = vi.fn();
    const errorLines: string[] = [];
    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;

    await expect(
      runDebugCommandWithOptions(
        { sandboxName: "alpha" },
        {
          getDefaultSandbox: async () => "alpha",
          getSandboxAvailability: async () => "missing",
          runDebug,
          errorLine: (msg) => errorLines.push(msg),
          exit,
        },
      ),
    ).rejects.toThrow("exit");

    expect(runDebug).not.toHaveBeenCalled();
    expect(errorLines.join("\n")).toContain("local registry but not in OpenShell");
    expect(errorLines.join("\n")).toContain("nemoclaw onboard");
  });

  it("validates an env-sourced sandbox name and reports the env source on failure", async () => {
    const runDebug = vi.fn();
    const errorLines: string[] = [];
    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;
    await expect(
      runDebugCommandWithOptions(
        {},
        {
          env: { NEMOCLAW_SANDBOX_NAME: "ghost" } as NodeJS.ProcessEnv,
          getDefaultSandbox: async () => "alpha",
          getSandboxAvailability: async () => "unregistered",
          runDebug,
          errorLine: (msg) => errorLines.push(msg),
          exit,
        },
      ),
    ).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(runDebug).not.toHaveBeenCalled();
    expect(errorLines[0]).toContain("ghost");
    expect(errorLines[0]).toContain("NEMOCLAW_SANDBOX_NAME");
  });

  it("prefers NEMOCLAW_SANDBOX_NAME over NEMOCLAW_SANDBOX and SANDBOX_NAME", async () => {
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn().mockReturnValue("available");
    await runDebugCommandWithOptions(
      {},
      {
        env: {
          NEMOCLAW_SANDBOX_NAME: "primary",
          NEMOCLAW_SANDBOX: "secondary",
          SANDBOX_NAME: "tertiary",
        } as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => "default",
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).toHaveBeenCalledWith("primary");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "primary" });
  });

  it("flag overrides env vars when both are present", async () => {
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn().mockReturnValue("available");
    await runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        env: { NEMOCLAW_SANDBOX: "beta" } as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => "default",
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).toHaveBeenCalledWith("alpha");
    expect(getSandboxAvailability).not.toHaveBeenCalledWith("beta");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });

  it("stops before diagnostics when the configured default sandbox is rejected", async () => {
    const runDebug = vi.fn();

    await runDebugCommandWithOptions(
      {},
      {
        env: {} as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => null,
        getSandboxAvailability: async () => "available",
        runDebug,
      },
    );

    expect(runDebug).not.toHaveBeenCalled();
  });

  it("falls back to getDefaultSandbox when neither flag nor env is set", async () => {
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn();
    await runDebugCommandWithOptions(
      {},
      {
        env: {} as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => "alpha",
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).not.toHaveBeenCalled();
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha" });
  });
});
