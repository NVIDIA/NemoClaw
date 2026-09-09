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
        getDefaultSandbox: async () => ({ name: "alpha", gatewayName: "nemoclaw" }),
        getSandboxAvailability: async () => ({ state: "available", gatewayName: "nemoclaw" }),
        runDebug,
      },
    );
    expect(runDebug).toHaveBeenCalledWith({
      quick: true,
      output: "/tmp/out.tgz",
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
    });
  });

  it("accepts an explicit --sandbox name that is registered", async () => {
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn().mockResolvedValue({ state: "available", gatewayName: "nemoclaw" });
    await runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        getDefaultSandbox: async () => ({ name: "default", gatewayName: "nemoclaw" }),
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).toHaveBeenCalledWith("alpha");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha", gatewayName: "nemoclaw" });
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
          getDefaultSandbox: async () => ({ name: "alpha", gatewayName: "nemoclaw" }),
          getSandboxAvailability: async () => ({ state: "unregistered" }),
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

  it("reports safe recovery for an invalid sandbox gateway binding", async () => {
    const runDebug = vi.fn();
    const errorLine = vi.fn();
    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;

    await expect(
      runDebugCommandWithOptions(
        { sandboxName: "alpha" },
        {
          getDefaultSandbox: async () => ({ name: "default", gatewayName: "nemoclaw" }),
          getSandboxAvailability: async () => ({ state: "invalid_gateway" }),
          runDebug,
          errorLine,
          exit,
        },
      ),
    ).rejects.toThrow("exit");

    expect(errorLine).toHaveBeenCalledWith(
      "  Restore gatewayName and gatewayPort from a trusted backup. Otherwise, back up and remove the sandbox before onboarding it again. Do not copy a gateway binding from another sandbox.",
    );
    expect(runDebug).not.toHaveBeenCalled();
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
          getDefaultSandbox: async () => ({ name: "alpha", gatewayName: "nemoclaw" }),
          getSandboxAvailability: async () => ({ state: "missing" }),
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
          getDefaultSandbox: async () => ({ name: "alpha", gatewayName: "nemoclaw" }),
          getSandboxAvailability: async () => ({ state: "unregistered" }),
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
    const getSandboxAvailability = vi.fn().mockResolvedValue({ state: "available", gatewayName: "nemoclaw" });
    await runDebugCommandWithOptions(
      {},
      {
        env: {
          NEMOCLAW_SANDBOX_NAME: "primary",
          NEMOCLAW_SANDBOX: "secondary",
          SANDBOX_NAME: "tertiary",
        } as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => ({ name: "default", gatewayName: "nemoclaw" }),
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).toHaveBeenCalledWith("primary");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "primary", gatewayName: "nemoclaw" });
  });

  it("flag overrides env vars when both are present", async () => {
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn().mockResolvedValue({ state: "available", gatewayName: "nemoclaw" });
    await runDebugCommandWithOptions(
      { sandboxName: "alpha" },
      {
        env: { NEMOCLAW_SANDBOX: "beta" } as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => ({ name: "default", gatewayName: "nemoclaw" }),
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).toHaveBeenCalledWith("alpha");
    expect(getSandboxAvailability).not.toHaveBeenCalledWith("beta");
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha", gatewayName: "nemoclaw" });
  });

  it("stops before diagnostics when the configured default sandbox is rejected", async () => {
    const runDebug = vi.fn();

    const exit = vi.fn(() => {
      throw new Error("exit");
    }) as unknown as (code: number) => never;

    await expect(
      runDebugCommandWithOptions(
        {},
        {
          env: {} as NodeJS.ProcessEnv,
          getDefaultSandbox: async () => null,
          getSandboxAvailability: async () => ({ state: "available", gatewayName: "nemoclaw" }),
          runDebug,
          exit,
        },
      ),
    ).rejects.toThrow("exit");

    expect(exit).toHaveBeenCalledWith(1);
    expect(runDebug).not.toHaveBeenCalled();
  });

  it("falls back to getDefaultSandbox when neither flag nor env is set", async () => {
    const runDebug = vi.fn();
    const getSandboxAvailability = vi.fn();
    await runDebugCommandWithOptions(
      {},
      {
        env: {} as NodeJS.ProcessEnv,
        getDefaultSandbox: async () => ({ name: "alpha", gatewayName: "nemoclaw" }),
        getSandboxAvailability,
        runDebug,
      },
    );
    expect(getSandboxAvailability).not.toHaveBeenCalled();
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "alpha", gatewayName: "nemoclaw" });
  });
});
