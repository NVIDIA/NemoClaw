// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import { captureLogger, mockSpawnProc } from "../test-helpers.js";

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
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
});

describe("cliConnect", () => {
  it("spawns openshell sandbox connect with correct sandbox name", async () => {
    mockSpawnProc(vi.mocked(spawn), 0);

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
    mockSpawnProc(vi.mocked(spawn), 0);

    const { logger } = captureLogger();
    await cliConnect({ sandbox: "my-custom-sandbox", logger });

    expect(spawn).toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "my-custom-sandbox"],
      { stdio: "inherit" },
    );
  });

  it("logs ENOENT error and exit guidance when openshell is not installed", async () => {
    mockSpawnProc(vi.mocked(spawn), null, new Error("ENOENT: spawn openshell not found"));

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).toContain("openshell CLI not found");
    // After spawn error, resolve(1) triggers the exit code guidance
    expect(output).toContain("exited with code 1");
    expect(output).toContain("openclaw nemoclaw status");
  });

  it("logs generic error and exit guidance on non-ENOENT spawn failure", async () => {
    mockSpawnProc(vi.mocked(spawn), null, new Error("permission denied"));

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).toContain("Connection failed: permission denied");
    // After spawn error, resolve(1) triggers the exit code guidance
    expect(output).toContain("exited with code 1");
    expect(output).toContain("openclaw nemoclaw status");
  });

  it("logs exit code error on non-zero exit", async () => {
    mockSpawnProc(vi.mocked(spawn), 127);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).toContain("exited with code 127");
    expect(output).toContain("openclaw nemoclaw status");
  });

  it("does not log error on successful exit (code 0)", async () => {
    mockSpawnProc(vi.mocked(spawn), 0);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).not.toContain("exited with code");
    expect(output).not.toContain("ERROR:");
  });

  it("does not log error on null exit code", async () => {
    mockSpawnProc(vi.mocked(spawn), null);

    const { lines, logger } = captureLogger();
    await cliConnect({ sandbox: "openclaw", logger });

    const output = lines.join("\n");
    expect(output).not.toContain("exited with code");
  });
});
