// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Issue #4365: when Ollama autostart times out in interactive default mode,
// the wizard should surface a steer-away hint before returning to provider
// selection so the user does not keep re-picking Local Ollama.

import { spawn } from "node:child_process";

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
  MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
} from "../inference/ollama-runtime-context";
import {
  isOllamaProviderPinned,
  runOllamaStartupOrGate,
  setOllamaAutostartDisabled,
  startDetachedOllamaServe,
} from "./ollama-startup";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

const wait = require("../core/wait");
const spawnMock = vi.mocked(spawn);

function serveLaunches() {
  return spawnMock.mock.calls.filter(([, args]) => args?.[0] === "serve");
}

describe("startDetachedOllamaServe (#11984)", () => {
  beforeEach(() => spawnMock.mockClear());

  it("starts ollama serve in its own session so onboarding exit cannot stop it", () => {
    startDetachedOllamaServe({ port: 11434 });

    expect(serveLaunches()).toHaveLength(1);
    const [file, args, options] = spawnMock.mock.calls[0];
    expect(file).toBe("ollama");
    expect(args).toEqual(["serve"]);
    expect(options).toMatchObject({ detached: true, stdio: "ignore" });
    expect(options?.env?.OLLAMA_HOST).toBe("127.0.0.1:11434");
    expect(options?.env).not.toHaveProperty("OLLAMA_CONTEXT_LENGTH");
    expect(spawnMock.mock.results[0].value.unref).toHaveBeenCalledTimes(1);
  });

  it("absorbs spawn errors so the readiness probe reports the failure", () => {
    startDetachedOllamaServe({ port: 11434 });

    const child = spawnMock.mock.results[0].value;
    const onError = child.on.mock.calls.find(([event]: [string]) => event === "error")?.[1];
    expect(onError).toBeTypeOf("function");
    expect(() => onError(new Error("spawn ollama ENOENT"))).not.toThrow();
  });

  it("requests the agent context floor only when it exceeds the autodetected minimum", () => {
    startDetachedOllamaServe({
      port: 11434,
      contextWindowFloor: MIN_AUTODETECTED_OLLAMA_CONTEXT_WINDOW,
    });
    startDetachedOllamaServe({ port: 11434, contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW });

    expect(spawnMock.mock.calls[0][2]?.env).not.toHaveProperty("OLLAMA_CONTEXT_LENGTH");
    expect(spawnMock.mock.calls[1][2]?.env?.OLLAMA_CONTEXT_LENGTH).toBe(
      String(MIN_HERMES_OLLAMA_CONTEXT_WINDOW),
    );
  });

  it("launches an explicit binary path without shell quoting", () => {
    startDetachedOllamaServe({ port: 11434, binPath: "/home/o'test/.local/bin/ollama" });

    expect(spawnMock.mock.calls[0][0]).toBe("/home/o'test/.local/bin/ollama");
    expect(spawnMock.mock.calls[0][1]).toEqual(["serve"]);
  });
});

describe("runOllamaStartupOrGate steer hint (#4365)", () => {
  let originalWaitForHttp: typeof wait.waitForHttp;
  let originalProviderEnv: string | undefined;
  let originalNoAutostartEnv: string | undefined;

  beforeEach(() => {
    originalWaitForHttp = wait.waitForHttp;
    originalProviderEnv = process.env.NEMOCLAW_PROVIDER;
    originalNoAutostartEnv = process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    // Clear NEMOCLAW_OLLAMA_NO_AUTOSTART so isOllamaAutostartDisabled() stays
    // false regardless of the caller's environment — otherwise the autostart-
    // timeout branch is bypassed and these assertions never run.
    delete process.env.NEMOCLAW_OLLAMA_NO_AUTOSTART;
    setOllamaAutostartDisabled(false);
    spawnMock.mockClear();
  });

  function restore() {
    setOllamaAutostartDisabled(false);
    wait.waitForHttp = originalWaitForHttp;
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
    cases.forEach(([value, expected]) => {
      if (value === undefined) delete process.env.NEMOCLAW_PROVIDER;
      else process.env.NEMOCLAW_PROVIDER = value;
      expect(isOllamaProviderPinned(), `pin=${JSON.stringify(value)}`).toBe(expected);
    });
    restore();
  });

  it("returns 'ready' immediately when Ollama already responds (no hint, no spawn)", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    let waitCalled = false;
    wait.waitForHttp = () => {
      waitCalled = true;
      return true;
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
      expect(serveLaunches()).toHaveLength(0);
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
      restore();
    }
  });

  it("starts a NemoClaw-owned Hermes daemon with its required context length", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    wait.waitForHttp = () => true;
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const outcome = runOllamaStartupOrGate({
        ollamaReady: false,
        ollamaPort: 11434,
        getLocalProviderBaseUrl: () => "http://host.openshell.internal:11435/v1",
        isNonInteractive: () => false,
        contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      });

      expect(outcome).toEqual({ kind: "ready" });
      expect(serveLaunches()).toHaveLength(1);
      expect(serveLaunches()[0][2]).toMatchObject({
        detached: true,
        env: expect.objectContaining({
          OLLAMA_HOST: "127.0.0.1:11434",
          OLLAMA_CONTEXT_LENGTH: String(MIN_HERMES_OLLAMA_CONTEXT_WINDOW),
        }),
      });
    } finally {
      logSpy.mockRestore();
      restore();
    }
  });

  const providerSetups = {
    pinned: () => {
      process.env.NEMOCLAW_PROVIDER = "ollama";
    },
    unpinned: () => {
      delete process.env.NEMOCLAW_PROVIDER;
    },
  };
  const outcomeAssertions = {
    continue: (invoke: () => ReturnType<typeof runOllamaStartupOrGate>) => {
      expect(invoke()).toEqual({ kind: "continue" });
    },
    exit: (invoke: () => ReturnType<typeof runOllamaStartupOrGate>) => {
      expect(invoke).toThrow(/process\.exit:1/);
    },
  };

  it.each([
    {
      name: "returns to provider selection for an interactive unpinned run",
      nonInteractive: false,
      outcome: "continue",
      providerSetup: "unpinned",
      expectedExitCalls: 0,
    },
    {
      name: "exits an interactive provider-pinned run instead of looping",
      nonInteractive: false,
      outcome: "exit",
      providerSetup: "pinned",
      expectedExitCalls: 1,
    },
    {
      name: "exits a non-interactive run",
      nonInteractive: true,
      outcome: "exit",
      providerSetup: "unpinned",
      expectedExitCalls: 1,
    },
  ] as const)("refuses an unavailable Hermes fallback and $name (#6760)", (testCase) => {
    providerSetups[testCase.providerSetup]();
    setOllamaAutostartDisabled(true);
    const getLocalProviderBaseUrl = vi.fn(() => "http://host.openshell.internal:11435/v1");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);
    const invoke = () =>
      runOllamaStartupOrGate({
        ollamaReady: false,
        ollamaPort: 11434,
        getLocalProviderBaseUrl,
        isNonInteractive: () => testCase.nonInteractive,
        contextWindowFloor: MIN_HERMES_OLLAMA_CONTEXT_WINDOW,
      });

    try {
      outcomeAssertions[testCase.outcome](invoke);
      expect(exitSpy).toHaveBeenCalledTimes(testCase.expectedExitCalls);
      expect(serveLaunches()).toHaveLength(0);
      expect(getLocalProviderBaseUrl).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(
        "  Ollama is not running on localhost:11434 and --no-ollama-autostart is set; cannot verify the required 64000-token context window.",
      );
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
      restore();
    }
  });
});
