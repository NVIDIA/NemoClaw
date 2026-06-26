// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { hasAgentPassthroughHelpToken, printAgentPassthroughHelp } from "./passthrough-help";

describe("hasAgentPassthroughHelpToken", () => {
  it("returns true for --help before the OpenClaw argv separator", () => {
    expect(hasAgentPassthroughHelpToken(["--help"])).toBe(true);
    expect(hasAgentPassthroughHelpToken(["-h", "-m", "hi"])).toBe(true);
  });

  it("ignores --help that appears after the OpenClaw argv separator", () => {
    expect(hasAgentPassthroughHelpToken(["--", "--help"])).toBe(false);
  });

  it("returns false for unrelated flags", () => {
    expect(hasAgentPassthroughHelpToken(["-m", "hi"])).toBe(false);
    expect(hasAgentPassthroughHelpToken([])).toBe(false);
  });
});

describe("printAgentPassthroughHelp", () => {
  it("describes both OpenClaw and terminal-runtime passthroughs (#5790)", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    let output = "";
    try {
      printAgentPassthroughHelp();
      output = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    } finally {
      logSpy.mockRestore();
    }

    expect(output).toContain("[agent-flags...]");
    expect(output).toContain("registered agent command");
    expect(output).toContain("OpenClaw sandboxes run `openclaw agent ...`");
    expect(output).toContain("terminal-runtime sandboxes run");
    expect(output).toContain("`dcode ...`");
    expect(output).not.toContain("OpenClaw sandboxes only");
  });
});
