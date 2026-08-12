// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  hasAgentPassthroughHelpToken,
  printAgentPassthroughHelp,
  writeSilentAgentDispatchFailure,
} from "./passthrough-help";

function collectStderr() {
  const lines: string[] = [];
  return { lines, proc: { stderr: { write: (value: string) => lines.push(value) } } };
}

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

describe("writeSilentAgentDispatchFailure", () => {
  it("names the sandbox and states that the turn was not delivered", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant");

    expect(lines.join("")).toContain(
      "The agent dispatch for sandbox 'my-assistant' exited 0 without producing any output, so the turn was not delivered.",
    );
  });

  it("offers the documented recovery paths", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant");

    const written = lines.join("");
    expect(written).toContain("exec -- openclaw agent");
    expect(written).toContain("my-assistant status");
    expect(written).toContain("my-assistant recover");
  });

  it("terminates every emitted line", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant");

    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
  });
});
