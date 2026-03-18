// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginLogger } from "../index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Import after mocks are set up
const { spawn } = await import("node:child_process");
const { cliConnect } = await import("./connect.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureLogger(): { lines: string[]; logger: PluginLogger } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (msg: string) => lines.push(msg),
      warn: (msg: string) => lines.push(`WARN: ${msg}`),
      error: (msg: string) => lines.push(`ERROR: ${msg}`),
      debug: (_msg: string) => {},
    },
  };
}

/** Create a mock spawn that emits events. */
function mockSpawnProc(exitCode: number | null = 0, error?: Error) {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  const proc = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
      return proc;
    }),
    emit: (event: string, ...args: unknown[]) => {
      for (const h of handlers[event] ?? []) h(...args);
    },
  };

  vi.mocked(spawn).mockReturnValue(proc as never);

  // Schedule events asynchronously so the promise in cliConnect can attach listeners
  setTimeout(() => {
    if (error) {
      proc.emit("error", error);
    } else {
      proc.emit("close", exitCode);
    }
  }, 0);

  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

describe("cliConnect", () => {
  it("spawns openshell sandbox connect with correct sandbox name", async () => {
    mockSpawnProc(0);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    expect(spawn).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "openclaw"],
      { stdio: "inherit" },
    );
    const output = lines.join("\n");
    expect(output).toContain("Connecting to OpenClaw sandbox: openclaw");
    expect(output).toContain("Type 'exit' to return to your host shell");
  });

  it("uses the provided sandbox name", async () => {
    mockSpawnProc(0);

    const { logger } = captureLogger();
    await cliConnect({ sandbox: "my-custom-sandbox", logger });

    expect(spawn).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "my-custom-sandbox"],
      { stdio: "inherit" },
    );
  });

  it("logs ENOENT error when openshell is not installed", async () => {
    mockSpawnProc(null, new Error("ENOENT: spawn openshell not found"));

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).toContain("openshell CLI not found");
  });

  it("logs generic error on non-ENOENT spawn failure", async () => {
    mockSpawnProc(null, new Error("permission denied"));

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).toContain("Connection failed: permission denied");
  });

  it("logs exit code error on non-zero exit", async () => {
    mockSpawnProc(127);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).toContain("exited with code 127");
    expect(output).toContain("openclaw nemoclaw status");
  });

  it("does not log error on successful exit (code 0)", async () => {
    mockSpawnProc(0);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).not.toContain("exited with code");
    expect(output).not.toContain("ERROR:");
  });

  it("does not log error on null exit code", async () => {
    mockSpawnProc(null);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).not.toContain("exited with code");
  });
});
