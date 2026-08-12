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
  const turn = ["openclaw", "agent", "--agent", "main", "-m", "Say PONG"];

  it("names the sandbox and states that the turn was not delivered", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", turn);

    expect(lines.join("")).toContain(
      "The agent dispatch for sandbox 'my-assistant' exited 0 without producing any output, so the turn was not delivered.",
    );
  });

  it("prints a directly runnable recovery command carrying the whole turn", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", turn);

    expect(lines.join("")).toContain(
      "nemoclaw 'my-assistant' exec -- 'openclaw' 'agent' '--agent' 'main' '-m' 'Say PONG'",
    );
  });

  it("keeps the target selector in the recovery command so it does not exit on the selector guard", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", [
      "openclaw",
      "agent",
      "--session-key",
      "agent:main:main",
      "-m",
      "ping",
    ]);

    expect(lines.join("")).toContain("'--session-key' 'agent:main:main'");
  });

  it("shell-quotes a sandbox name and turn arguments that carry shell metacharacters", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "sb; rm -rf /", ["openclaw", "agent", "-m", "a'b $(x)"]);

    expect(lines.join("")).toContain("'sb; rm -rf /'");
    expect(lines.join("")).toContain(String.raw`'a'\''b $(x)'`);
  });

  it("redacts a credential pasted into the turn arguments", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", [
      "openclaw",
      "agent",
      "--agent",
      "main",
      "-m",
      "use sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
    ]);

    const output = lines.join("");
    expect(output).not.toContain("sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH");
    // Pin the surviving command, not just the absent token: a bare negative
    // assertion also passes if the recovery command is dropped entirely.
    expect(output).toContain(
      "nemoclaw 'my-assistant' exec -- 'openclaw' 'agent' '--agent' 'main' '-m' 'use <REDACTED>'",
    );
    expect(output).toContain("sensitive values were redacted; do not replay this command");
    expect(output).not.toContain("run this turn directly inside the sandbox");
  });

  it("leaves ordinary turn text runnable rather than redacting it", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", [
      "openclaw",
      "agent",
      "--agent",
      "main",
      "-m",
      "Summarise README.md",
    ]);

    const output = lines.join("");
    expect(output).toContain("'-m' 'Summarise README.md'");
    expect(output).toContain("run this turn directly inside the sandbox");
    expect(output).not.toContain("do not replay this command");
  });

  it("offers the documented recovery paths", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", turn);

    const written = lines.join("");
    expect(written).toContain("exec -- 'openclaw' 'agent'");
    expect(written).toContain("'my-assistant' status");
    expect(written).toContain("'my-assistant' recover");
  });

  it("terminates every emitted line", () => {
    const { lines, proc } = collectStderr();

    writeSilentAgentDispatchFailure(proc, "my-assistant", turn);

    expect(lines.every((line) => line.endsWith("\n"))).toBe(true);
  });
});
