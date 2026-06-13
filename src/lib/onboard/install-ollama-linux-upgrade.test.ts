// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decideInstallOllamaLinuxMode,
  type InstallOllamaLinuxOptions,
  installOllamaOnLinux,
} from "../../../dist/lib/onboard/install-ollama-linux";

function makeOpts(overrides: Partial<InstallOllamaLinuxOptions>): InstallOllamaLinuxOptions {
  return {
    isNonInteractive: () => false,
    getEuid: () => 1000,
    isTty: () => true,
    homedir: () => "/home/test",
    arch: () => "arm64",
    canSudoNonInteractive: () => false,
    runCaptureImpl: vi.fn().mockReturnValue(""),
    runCaptureExImpl: vi.fn().mockReturnValue({ stdout: "", exitCode: 0, timedOut: false }),
    runShellImpl: vi.fn().mockReturnValue({ status: 0, stdout: "", stderr: "", error: null }),
    waitForHttpImpl: vi.fn().mockReturnValue(true),
    sleepSecondsImpl: vi.fn(),
    ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("ready"),
    fileExistsImpl: vi.fn().mockReturnValue(false),
    readFileImpl: vi.fn().mockReturnValue(""),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}

function findRunShellCall(
  runShellImpl: ReturnType<typeof vi.fn>,
  fragment: string,
): string | undefined {
  for (const call of runShellImpl.mock.calls) {
    const [cmd] = call as [string, unknown];
    if (typeof cmd === "string" && cmd.includes(fragment)) return cmd;
  }
  return undefined;
}

describe("decideInstallOllamaLinuxMode (upgrade)", () => {
  const originalEnv = process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;

  beforeEach(() => {
    delete process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;
    else process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = originalEnv;
  });

  it("forces system when upgrading even though an interactive shell would otherwise prompt", () => {
    const opts = makeOpts({
      canSudoNonInteractive: () => false,
      isNonInteractive: () => false,
      isTty: () => true,
      isUpgrade: true,
    });
    expect(decideInstallOllamaLinuxMode(opts)).toBe("system");
  });

  it("refuses NEMOCLAW_OLLAMA_INSTALL_MODE=user during an upgrade so the system daemon is not left stale", () => {
    process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = "user";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit(1)");
    }) as never);
    const errorLog = vi.fn();
    try {
      const opts = makeOpts({ isUpgrade: true, errorLog });
      expect(() => decideInstallOllamaLinuxMode(opts)).toThrow(/process\.exit\(1\)/);
      expect(errorLog.mock.calls.flat().join("\n")).toContain(
        "NEMOCLAW_OLLAMA_INSTALL_MODE=user is incompatible",
      );
    } finally {
      exitSpy.mockRestore();
      delete process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;
    }
  });

  it("refuses NEMOCLAW_OLLAMA_INSTALL_MODE=system for a non-interactive upgrade when sudo is unavailable", () => {
    process.env.NEMOCLAW_OLLAMA_INSTALL_MODE = "system";
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit(1)");
    }) as never);
    const errorLog = vi.fn();
    try {
      const opts = makeOpts({
        canSudoNonInteractive: () => false,
        isNonInteractive: () => true,
        isTty: () => false,
        isUpgrade: true,
        errorLog,
      });
      expect(() => decideInstallOllamaLinuxMode(opts)).toThrow(/process\.exit\(1\)/);
      expect(errorLog.mock.calls.flat().join("\n")).toContain(
        "Upgrading the system Ollama requires sudo",
      );
    } finally {
      exitSpy.mockRestore();
      delete process.env.NEMOCLAW_OLLAMA_INSTALL_MODE;
    }
  });

  it("refuses to fall back to user-local for non-interactive upgrades without sudo", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("process.exit(1)");
    }) as never);
    const errorLog = vi.fn();
    try {
      const opts = makeOpts({
        canSudoNonInteractive: () => false,
        isNonInteractive: () => true,
        isTty: () => false,
        isUpgrade: true,
        errorLog,
      });
      expect(() => decideInstallOllamaLinuxMode(opts)).toThrow(/process\.exit\(1\)/);
      expect(errorLog.mock.calls.flat().join("\n")).toContain(
        "Upgrading the system Ollama requires sudo",
      );
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("installOllamaOnLinux (upgrade recovery)", () => {
  it("pins the resolved Ollama host to local loopback after a successful install", () => {
    // Resolve through the same CJS require cache the helper uses internally
    // so the `_resolvedOllamaHost` mutation is observable from the test.
    const localInference = require("../../../dist/lib/inference/local");
    localInference.setResolvedOllamaHost("host.docker.internal");
    try {
      const opts = makeOpts({
        modeOverride: "system",
        runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
        ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("ready"),
      });
      const result = installOllamaOnLinux(opts);
      expect(result.ok).toBe(true);
      expect(localInference.getResolvedOllamaHost()).toBe("127.0.0.1");
    } finally {
      localInference.resetOllamaHostCache();
    }
  });

  it("falls back to a manual loopback launch when systemd is not applicable and no daemon is reachable", () => {
    const runShellImpl = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const waitForHttpImpl = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("not-applicable"),
      waitForHttpImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const manualStart = findRunShellCall(runShellImpl, "ollama serve");
    expect(manualStart).toBeDefined();
    expect(manualStart).toContain("OLLAMA_HOST=127.0.0.1:");
  });

  it("skips the manual launch when systemd is not applicable but the local loopback daemon already responds", () => {
    const runShellImpl = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const waitForHttpImpl = vi.fn().mockReturnValue(true);
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("not-applicable"),
      waitForHttpImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    expect(waitForHttpImpl).toHaveBeenCalledTimes(1);
    expect(findRunShellCall(runShellImpl, "ollama serve")).toBeUndefined();
  });

  it("stops the stale Ollama daemon before relaunching on the upgrade path", () => {
    const runShellImpl = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const waitForHttpImpl = vi.fn().mockReturnValue(true);
    const sleepSecondsImpl = vi.fn();
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("not-applicable"),
      waitForHttpImpl,
      sleepSecondsImpl,
      isUpgrade: true,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    const shellCommands = runShellImpl.mock.calls.map((call) => String(call[0] ?? ""));
    const killIndex = shellCommands.findIndex((cmd) => cmd.includes("pkill -x ollama"));
    const launchIndex = shellCommands.findIndex((cmd) => cmd.includes("ollama serve"));
    expect(killIndex).toBeGreaterThanOrEqual(0);
    expect(launchIndex).toBeGreaterThan(killIndex);
    expect(sleepSecondsImpl).toHaveBeenCalled();
  });

  it("re-probes loopback fresh instead of trusting the cached findReachableOllamaHost result", () => {
    const runShellImpl = vi
      .fn()
      .mockReturnValue({ status: 0, stdout: "", stderr: "", error: null });
    const waitForHttpImpl = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const opts = makeOpts({
      modeOverride: "system",
      runCaptureImpl: vi.fn().mockReturnValue("/usr/bin/zstd"),
      runShellImpl,
      ensureManagedOllamaLoopbackSystemdOverrideImpl: vi.fn().mockReturnValue("not-applicable"),
      waitForHttpImpl,
    });
    const result = installOllamaOnLinux(opts);
    expect(result.ok).toBe(true);
    expect(findRunShellCall(runShellImpl, "ollama serve")).toBeDefined();
  });
});
