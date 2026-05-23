// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

const captureOpenshell = vi.hoisted(() => vi.fn());
const runOpenshell = vi.hoisted(() => vi.fn());
const getOpenshellBinary = vi.hoisted(() => vi.fn(() => "/usr/bin/openshell"));

vi.mock("../src/lib/adapters/openshell/runtime", () => ({
  captureOpenshell,
  runOpenshell,
  getOpenshellBinary,
}));

vi.mock("../src/lib/runner", () => ({ ROOT: "/tmp/test-root" }));

import { showSandboxLogs } from "../src/lib/actions/sandbox/logs";

describe("showSandboxLogs tail merge", () => {
  let stdoutLines: string[];
  let stderrLines: string[];
  const originalExit = process.exit;

  beforeEach(() => {
    vi.clearAllMocks();
    stdoutLines = [];
    stderrLines = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      stdoutLines.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      stderrLines.push(args.join(" "));
    });
    // Mock process.exit to throw so we can catch it
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
  });

  class ExitError extends Error {
    code: number;
    constructor(code: number) {
      super(`process.exit(${code})`);
      this.code = code;
    }
  }

  it("merges two sources and applies --tail once", () => {
    // Gateway returns 5 lines
    const gwLines = Array.from({ length: 5 }, (_, i) => `[gw] gateway line ${i + 1}`);
    // OpenShell returns 5 lines
    const osLines = Array.from({ length: 5 }, (_, i) => `[os] openshell line ${i + 1}`);

    // First captureOpenshell call = gateway, second = openshell
    captureOpenshell
      .mockReturnValueOnce({ status: 0, output: gwLines.join("\n") + "\n" })
      .mockReturnValueOnce({ status: 0, output: osLines.join("\n") + "\n" });

    // enableSandboxAuditLogs calls runOpenshell
    runOpenshell.mockReturnValue({ status: 0 });

    try {
      showSandboxLogs("test-sbox", { follow: false, lines: "5", since: null });
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
      expect(e.code).toBe(0);
    }

    // Should output exactly 5 lines (last 5 of merged 10)
    const output = stdoutLines.join("");
    const outputLines = output.trim().split("\n");
    expect(outputLines).toHaveLength(5);
    // Last 5 of [gw1..gw5, os1..os5] = [os1..os5]
    expect(outputLines).toEqual(osLines);
  });

  it("returns all lines when total is less than tail limit", () => {
    const gwLines = ["[gw] line 1", "[gw] line 2"];
    const osLines = ["[os] line 1"];

    captureOpenshell
      .mockReturnValueOnce({ status: 0, output: gwLines.join("\n") + "\n" })
      .mockReturnValueOnce({ status: 0, output: osLines.join("\n") + "\n" });

    runOpenshell.mockReturnValue({ status: 0 });

    try {
      showSandboxLogs("test-sbox", { follow: false, lines: "10", since: null });
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
      expect(e.code).toBe(0);
    }

    const output = stdoutLines.join("");
    const outputLines = output.trim().split("\n");
    // Total 3 lines, tail 10 → all 3
    expect(outputLines).toHaveLength(3);
  });

  it("handles one source failing gracefully", () => {
    // Gateway fails
    captureOpenshell
      .mockReturnValueOnce({ status: 1, output: "" })
      .mockReturnValueOnce({
        status: 0,
        output: ["[os] line 1", "[os] line 2", "[os] line 3"].join("\n") + "\n",
      });

    runOpenshell.mockReturnValue({ status: 0 });

    try {
      showSandboxLogs("test-sbox", { follow: false, lines: "5", since: null });
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
      expect(e.code).toBe(0);
    }

    const output = stdoutLines.join("");
    const outputLines = output.trim().split("\n");
    expect(outputLines).toHaveLength(3);
  });

  it("uses inherit stdio for --since mode (no merge needed)", () => {
    runOpenshell.mockReturnValue({ status: 0 });

    try {
      showSandboxLogs("test-sbox", { follow: false, lines: "5", since: "5m" });
    } catch (e) {
      if (!(e instanceof ExitError)) throw e;
    }

    // --since mode should use runOpenshell (inherit), not captureOpenshell
    // runOpenshell called twice: once for enableSandboxAuditLogs, once for logs
    expect(runOpenshell).toHaveBeenCalledTimes(2);
    expect(captureOpenshell).not.toHaveBeenCalled();
  });
});
