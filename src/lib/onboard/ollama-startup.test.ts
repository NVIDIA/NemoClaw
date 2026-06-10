// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Issue #4365: when Ollama autostart times out in interactive default mode,
// the wizard should surface a steer-away hint before returning to provider
// selection so the user does not keep re-picking Local Ollama.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  isOllamaProviderPinned,
  runOllamaStartupOrGate,
  setOllamaAutostartDisabled,
} from "../../../dist/lib/onboard/ollama-startup";

const wait = require("../../../dist/lib/core/wait");
const runner = require("../../../dist/lib/runner");

describe("runOllamaStartupOrGate (#4365 steer hint)", () => {
  let originalWaitForHttp: typeof wait.waitForHttp;
  let originalRunShell: typeof runner.runShell;
  let originalProviderEnv: string | undefined;
  let originalNoAutostartEnv: string | undefined;

  beforeEach(() => {
    originalWaitForHttp = wait.waitForHttp;
    originalRunShell = runner.runShell;
    originalProviderEnv = process.env.NEMOCLAW_PROVIDER;
    originalNoAutostartEnv = process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    // Clear NEMOCLAW_OLLAMA_NO_AUTOSTART so isOllamaAutostartDisabled() stays
    // false regardless of the caller's environment — otherwise the autostart-
    // timeout branch is bypassed and these assertions never run.
    delete process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    setOllamaAutostartDisabled(false);
    runner.runShell = () => ({ status: 0 });
  });

  function restore() {
    wait.waitForHttp = originalWaitForHttp;
    runner.runShell = originalRunShell;
    if (originalProviderEnv === undefined) delete process.env.NEMOCLAW_PROVIDER;
    else process.env.NEMOCLAW_PROVIDER = originalProviderEnv;
    if (originalNoAutostartEnv === undefined) {
      delete process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    } else {
      process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART = originalNoAutostartEnv;
    }
  }

  it("prints the steer hint and returns 'continue' on autostart timeout in interactive default mode", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    wait.waitForHttp = () => false;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const outcome = runOllamaStartupOrGate({
        ollamaReady: false,
        ollamaPort: 11434,
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        isNonInteractive: () => false,
      });

      expect(outcome).toEqual({ kind: "continue" });
      const errLines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(errLines.some((l) => l.includes("Ollama did not become ready"))).toBe(true);
      expect(
        errLines.some((l) =>
          l.includes(
            "Pick a non-Ollama provider in the next menu — re-selecting Local Ollama would hit the same timeout.",
          ),
        ),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      restore();
    }
  });

  it("does not print the steer hint when the provider is pinned (the wizard exits instead)", () => {
    process.env.NEMOCLAW_PROVIDER = "ollama";
    wait.waitForHttp = () => false;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        runOllamaStartupOrGate({
          ollamaReady: false,
          ollamaPort: 11434,
          getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
          isNonInteractive: () => false,
        }),
      ).toThrow(/process\.exit:1/);
      const errLines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(
        errLines.some((l) =>
          l.includes("NEMOCLAW_PROVIDER pins onboarding to Ollama but Ollama is unreachable"),
        ),
      ).toBe(true);
      // The steer hint targets a re-prompt menu that never appears here.
      expect(errLines.some((l) => l.includes("Pick a non-Ollama provider in the next menu"))).toBe(
        false,
      );
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      restore();
    }
  });

  it("isOllamaProviderPinned recognises every Ollama-using provider key (#4365)", () => {
    // Mirror the matching logic in providers.getNonInteractiveProvider so a
    // user setting NEMOCLAW_PROVIDER to any of the Ollama-using keys still
    // triggers the pinned-provider escape paths. Without this, a casing
    // variant or an install-* pin would let the wizard return to the
    // selection menu and immediately re-pin to the same Ollama action,
    // reintroducing the #4365 loop.
    const cases: Array<[string | undefined, boolean]> = [
      ["ollama", true],
      ["OLLAMA", true],
      ["  Ollama  ", true],
      [" ollama\n", true],
      ["install-ollama", true],
      ["INSTALL-OLLAMA", true],
      ["install-windows-ollama", true],
      ["start-windows-ollama", true],
      ["build", false],
      ["openai", false],
      ["", false],
      [undefined, false],
    ];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.NEMOCLAW_PROVIDER;
      else process.env.NEMOCLAW_PROVIDER = value;
      expect(isOllamaProviderPinned(), `pin=${JSON.stringify(value)}`).toBe(expected);
    }
    restore();
  });

  it("returns 'ready' immediately when Ollama already responds (no hint, no spawn)", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    let waitCalled = false;
    wait.waitForHttp = () => {
      waitCalled = true;
      return true;
    };
    let shellCalled = false;
    runner.runShell = () => {
      shellCalled = true;
      return { status: 0 };
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const outcome = runOllamaStartupOrGate({
        ollamaReady: true,
        ollamaPort: 11434,
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        isNonInteractive: () => false,
      });

      expect(outcome).toEqual({ kind: "ready" });
      expect(waitCalled).toBe(false);
      expect(shellCalled).toBe(false);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      restore();
    }
  });
});
