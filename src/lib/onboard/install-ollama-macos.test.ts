// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  installOllamaOnMacOS,
  type InstallOllamaMacOSOptions,
} from "../../../dist/lib/onboard/install-ollama-macos";

function makeOpts(overrides: Partial<InstallOllamaMacOSOptions>): InstallOllamaMacOSOptions {
  return {
    isNonInteractive: () => false,
    runImpl: vi.fn(),
    runShellImpl: vi.fn(),
    waitForHttpImpl: vi.fn().mockReturnValue(true),
    sleepSecondsImpl: vi.fn(),
    log: vi.fn(),
    errorLog: vi.fn(),
    ...overrides,
  };
}

describe("installOllamaOnMacOS", () => {
  it("runs brew install for a fresh install and tolerates brew failure", () => {
    const runImpl = vi.fn();
    const result = installOllamaOnMacOS(makeOpts({ runImpl, isUpgrade: false }));
    expect(result.ok).toBe(true);
    const brewCall = runImpl.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0] === "brew" && call[0][1] === "install",
    );
    expect(brewCall).toBeDefined();
    expect(brewCall?.[1]).toEqual({ ignoreError: true });
  });

  it("runs brew upgrade and stops the stale daemon before relaunching", () => {
    const runImpl = vi.fn();
    const runShellImpl = vi.fn();
    const sleepSecondsImpl = vi.fn();
    const result = installOllamaOnMacOS(
      makeOpts({ runImpl, runShellImpl, sleepSecondsImpl, isUpgrade: true }),
    );
    expect(result.ok).toBe(true);
    const callOrder = runImpl.mock.calls.map((call) =>
      Array.isArray(call[0]) ? call[0].join(" ") : String(call[0] ?? ""),
    );
    const brewUpgradeIndex = callOrder.findIndex((cmd) => cmd === "brew upgrade ollama");
    const pkillIndex = callOrder.findIndex((cmd) => cmd === "pkill -x ollama");
    expect(brewUpgradeIndex).toBeGreaterThanOrEqual(0);
    expect(pkillIndex).toBeGreaterThan(brewUpgradeIndex);
    const brewUpgradeOpts = runImpl.mock.calls[brewUpgradeIndex]?.[1];
    expect(brewUpgradeOpts).toEqual({ ignoreError: false });
    const serveCall = runShellImpl.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("ollama serve"),
    );
    expect(serveCall).toBeDefined();
    expect(sleepSecondsImpl).toHaveBeenCalled();
  });

  it("does not stop a daemon on a fresh install", () => {
    const runImpl = vi.fn();
    installOllamaOnMacOS(makeOpts({ runImpl, isUpgrade: false }));
    const pkill = runImpl.mock.calls.find(
      (call) => Array.isArray(call[0]) && call[0][0] === "pkill",
    );
    expect(pkill).toBeUndefined();
  });

  it("returns ok:false when the daemon never becomes ready", () => {
    const errorLog = vi.fn();
    const waitForHttpImpl = vi.fn().mockReturnValue(false);
    const result = installOllamaOnMacOS(
      makeOpts({ waitForHttpImpl, errorLog, isUpgrade: true, sleepSecondsImpl: vi.fn() }),
    );
    expect(result.ok).toBe(false);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("did not become ready"));
  });
});
