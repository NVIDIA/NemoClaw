// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Issue #4365: focused unit tests for the Ollama probe-failure dispatcher.
// Mirrors the four branches handleOllamaProbeFailure picks between: pinned-
// provider exit, non-interactive abort, interactive daemon escape, and the
// non-daemon "choose another model" continue path.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  completeOllamaRuntimeContextSelection,
  handleOllamaProbeFailure,
} from "./ollama-probe-failure";

describe("handleOllamaProbeFailure (#4365)", () => {
  let originalProvider: string | undefined;
  let originalNonInteractive: string | undefined;

  beforeEach(() => {
    originalProvider = process.env.NEMOCLAW_PROVIDER;
    originalNonInteractive = process.env.NEMOCLAW_NON_INTERACTIVE;
  });

  function restore() {
    if (originalProvider === undefined) delete process.env.NEMOCLAW_PROVIDER;
    else process.env.NEMOCLAW_PROVIDER = originalProvider;
    if (originalNonInteractive === undefined) delete process.env.NEMOCLAW_NON_INTERACTIVE;
    else process.env.NEMOCLAW_NON_INTERACTIVE = originalNonInteractive;
  }

  it("exits when a pinned Ollama provider hits a daemon failure", () => {
    process.env.NEMOCLAW_PROVIDER = "ollama";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        handleOllamaProbeFailure(
          { ok: false, message: "runner crashed", daemonFailure: true },
          "nemotron-3-nano:30b",
          () => false,
        ),
      ).toThrow(/process\.exit:1/);
      const errLines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(
        errLines.some((l) =>
          l.includes(
            "NEMOCLAW_PROVIDER pins onboarding to Ollama but the Ollama model runner is unhealthy",
          ),
        ),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      restore();
    }
  });

  it("aborts non-interactive runs on a daemon failure", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        handleOllamaProbeFailure(
          { ok: false, message: "runner died", daemonFailure: true },
          "nemotron-3-nano:30b",
          () => true,
        ),
      ).toThrow(/process\.exit:1/);
      const errLines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(errLines.some((l) => l.includes("Aborting: Ollama daemon is unhealthy"))).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      restore();
    }
  });

  it("returns 'back-to-selection' with an escape hint for interactive non-pinned daemon failures", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const action = handleOllamaProbeFailure(
        { ok: false, message: "model runner has unexpectedly stopped", daemonFailure: true },
        "qwen3.5:9b",
        () => false,
      );
      expect(action).toBe("back-to-selection");
      const logLines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logLines.some((l) => l.includes("Ollama itself appears unavailable"))).toBe(true);
      expect(
        logLines.some((l) =>
          l.includes("Returning to provider selection; choose a non-Ollama provider"),
        ),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      restore();
    }
  });

  it("returns 'continue' on a model-level failure (no daemonFailure flag)", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const action = handleOllamaProbeFailure(
        { ok: false, message: "model requires more system memory" },
        "qwen3.5:9b",
        () => false,
      );
      expect(action).toBe("continue");
      const logLines = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logLines.some((l) => l.includes("Choose a different Ollama model"))).toBe(true);
      // Daemon-escape hint MUST NOT appear in the non-daemon path.
      expect(logLines.some((l) => l.includes("Ollama itself appears unavailable"))).toBe(false);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      restore();
    }
  });

  it("aborts non-interactive model-level failures via the legacy message", () => {
    delete process.env.NEMOCLAW_PROVIDER;
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        handleOllamaProbeFailure(
          { ok: false, message: "model requires more system memory" },
          "qwen3.5:9b",
          () => true,
        ),
      ).toThrow(/process\.exit:1/);
      const errLines = errSpy.mock.calls.map((c) => String(c[0]));
      expect(
        errLines.some((l) => l.includes("Aborting: Ollama model 'qwen3.5:9b' unavailable")),
      ).toBe(true);
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      restore();
    }
  });
});

describe("completeOllamaRuntimeContextSelection (#6760)", () => {
  const selected = {
    outcome: "selected" as const,
    model: "qwen3.5:9b",
    allowToolsIncompatible: false,
  };

  it("preserves a selected model when the runtime context is valid", () => {
    expect(completeOllamaRuntimeContextSelection({ ok: true }, selected, () => false)).toEqual(
      selected,
    );
  });

  it("returns to provider selection after an interactive runtime context failure", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(
        completeOllamaRuntimeContextSelection(
          { ok: false, message: "restart Ollama with OLLAMA_CONTEXT_LENGTH=64000" },
          selected,
          () => false,
        ),
      ).toEqual({ outcome: "back-to-selection" });
      expect(errSpy).toHaveBeenCalledWith("  restart Ollama with OLLAMA_CONTEXT_LENGTH=64000");
      expect(logSpy).toHaveBeenCalledWith("  Returning to provider selection.");
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("aborts non-interactive runs after a runtime context failure", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        completeOllamaRuntimeContextSelection(
          { ok: false, message: "restart Ollama with OLLAMA_CONTEXT_LENGTH=64000" },
          selected,
          () => true,
        ),
      ).toThrow(/process\.exit:1/);
      expect(errSpy).toHaveBeenCalledWith(
        "  [non-interactive] Aborting: restart Ollama with OLLAMA_CONTEXT_LENGTH=64000",
      );
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it("exits pinned interactive runs after a runtime context failure", () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "ollama");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code ?? 0}`);
    }) as never);

    try {
      expect(() =>
        completeOllamaRuntimeContextSelection(
          { ok: false, message: "restart Ollama with OLLAMA_CONTEXT_LENGTH=64000" },
          selected,
          () => false,
        ),
      ).toThrow(/process\.exit:1/);
      expect(errSpy).toHaveBeenCalledWith("  restart Ollama with OLLAMA_CONTEXT_LENGTH=64000");
      expect(logSpy).not.toHaveBeenCalledWith("  Returning to provider selection.");
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
      exitSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
