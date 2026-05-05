// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  parseDebugArgs,
  printDebugHelp,
  runDebugCommand,
  runDebugCommandWithOptions,
} from "../../dist/lib/debug-command";

function exitWithCode(code: number): never {
  throw new Error(`exit:${code}`);
}

describe("debug command", () => {
  it("prints help text", () => {
    const lines: string[] = [];
    printDebugHelp((message = "") => lines.push(message));
    expect(lines.join("\n")).toContain("Collect NemoClaw diagnostic information");
    expect(lines.join("\n")).toContain("--quick");
    expect(lines.join("\n")).toContain("--sandbox");
  });

  it("parses debug options and falls back to the default sandbox", () => {
    const opts = parseDebugArgs(["--quick", "--output", "/tmp/out.tgz"], {
      getDefaultSandbox: () => "alpha",
      log: () => {},
      error: () => {},
      exit: exitWithCode,
    });
    expect(opts).toEqual({ quick: true, output: "/tmp/out.tgz", sandboxName: "alpha" });
  });

  it("runs the debug command with parsed options", () => {
    const runDebug = vi.fn();
    runDebugCommand(["--sandbox", "beta"], {
      getDefaultSandbox: () => "alpha",
      runDebug,
      log: () => {},
      error: () => {},
      exit: exitWithCode,
    });
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "beta" });
  });

  it("runs parsed debug options and falls back to the default sandbox", () => {
    const runDebug = vi.fn();
    runDebugCommandWithOptions({ quick: true, output: "/tmp/out.tgz" }, {
      getDefaultSandbox: () => "alpha",
      runDebug,
      log: () => {},
      error: () => {},
      exit: exitWithCode,
    });
    expect(runDebug).toHaveBeenCalledWith({
      quick: true,
      output: "/tmp/out.tgz",
      sandboxName: "alpha",
    });
  });

  it("--sandbox overrides the default sandbox", () => {
    const runDebug = vi.fn();
    runDebugCommand(["--sandbox", "mybox"], {
      getDefaultSandbox: () => "stale-default",
      runDebug,
      log: () => {},
      error: () => {},
      exit: exitWithCode,
    });
    expect(runDebug).toHaveBeenCalledWith({ sandboxName: "mybox" });
  });

  it("falls back to undefined when getDefaultSandbox returns undefined", () => {
    const runDebug = vi.fn();
    runDebugCommand(["--quick"], {
      getDefaultSandbox: () => undefined,
      runDebug,
      log: () => {},
      error: () => {},
      exit: exitWithCode,
    });
    expect(runDebug).toHaveBeenCalledWith({ quick: true, sandboxName: undefined });
  });

  it("exits on invalid arguments", () => {
    expect(() =>
      parseDebugArgs(["--output"], {
        getDefaultSandbox: () => undefined,
        log: () => {},
        error: () => {},
        exit: exitWithCode,
      }),
    ).toThrow("exit:1");
  });
});
