// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression tests for #833: session lock failures must auto-reset the session
// so the next message starts with clean context instead of resuming corrupted
// conversation history.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const BRIDGE_SRC = fs.readFileSync(
  path.join(import.meta.dirname, "..", "scripts", "telegram-bridge.js"),
  "utf-8",
);

// Extract and evaluate the isSessionLockFailure function from the source
// so we test the real implementation without triggering the script's
// top-level side effects (process.exit, openshell resolution, etc.).

const fnMatch = BRIDGE_SRC.match(
  /function isSessionLockFailure\(result\)\s*\{[\s\S]*?^\}/m,
);
if (!fnMatch) throw new Error("Could not extract isSessionLockFailure from telegram-bridge.js");
const isSessionLockFailure = new Function(
  `${fnMatch[0]}; return isSessionLockFailure;`,
)();

describe("isSessionLockFailure", () => {
  it("detects exit code 255 as a lock failure when stderr mentions session lock", () => {
    const result = { response: "some output", exitCode: 255, stderr: "session lock timeout" };
    expect(isSessionLockFailure(result)).toBe(true);
  });

  it("does not flag exit code 255 with bare 'lock' unrelated to session", () => {
    const result = { response: "some output", exitCode: 255, stderr: "lock timeout on resource" };
    expect(isSessionLockFailure(result)).toBe(false);
  });

  it("does not flag exit code 255 alone without lock indicators", () => {
    const result = { response: "some output", exitCode: 255, stderr: "ssh: connect to host openshell-nemoclaw port 22: Connection refused" };
    expect(isSessionLockFailure(result)).toBe(false);
  });

  it("detects 'session file locked' in stderr regardless of exit code", () => {
    const result = {
      response: "",
      exitCode: 1,
      stderr: "Error: session file locked (timeout 10000ms)",
    };
    expect(isSessionLockFailure(result)).toBe(true);
  });

  it("detects 'session file locked' in response when stderr is empty", () => {
    const result = {
      response: "Agent exited with code 1. session file locked (timeout 10000ms)",
      exitCode: 1,
      stderr: "",
    };
    expect(isSessionLockFailure(result)).toBe(true);
  });

  it("detects exit code 255 with session corruption message", () => {
    const result = {
      response: "",
      exitCode: 255,
      stderr: "session file locked (timeout 10000ms)",
    };
    expect(isSessionLockFailure(result)).toBe(true);
  });

  it("does not flag a normal successful result", () => {
    const result = { response: "Hello!", exitCode: 0, stderr: "" };
    expect(isSessionLockFailure(result)).toBe(false);
  });

  it("does not flag a successful reply that quotes the error text", () => {
    const result = {
      response: 'The error "session file locked" means another process is using the file.',
      exitCode: 0,
      stderr: "",
    };
    expect(isSessionLockFailure(result)).toBe(false);
  });

  it("does not flag a generic non-lock failure (e.g. OOM, timeout)", () => {
    const result = {
      response: "Agent exited with code 137. Killed",
      exitCode: 137,
      stderr: "Killed",
    };
    expect(isSessionLockFailure(result)).toBe(false);
  });

  it("does not flag a normal non-zero exit without lock indicators", () => {
    const result = {
      response: "Error: connection refused",
      exitCode: 1,
      stderr: "ssh: connect to host openshell-nemoclaw port 22: Connection refused",
    };
    expect(isSessionLockFailure(result)).toBe(false);
  });

  it("handles missing stderr and response gracefully", () => {
    const result = { response: undefined, exitCode: 0, stderr: undefined };
    expect(isSessionLockFailure(result)).toBe(false);
  });
});

describe("telegram-bridge session reset wiring", () => {
  it("calls isSessionLockFailure in the poll handler", () => {
    expect(BRIDGE_SRC).toContain("isSessionLockFailure(result)");
  });

  it("rotates session on lock failure instead of just deleting", () => {
    const lockBlock = BRIDGE_SRC.slice(
      BRIDGE_SRC.indexOf("if (isSessionLockFailure(result))"),
    );
    expect(lockBlock).toContain("rotateSession(chatId)");
  });

  it("uses getSessionId when calling runAgentInSandbox", () => {
    expect(BRIDGE_SRC).toContain("runAgentInSandbox(msg.text, getSessionId(chatId))");
  });

  it("notifies the user when a session is auto-reset", () => {
    const lockBlock = BRIDGE_SRC.slice(
      BRIDGE_SRC.indexOf("if (isSessionLockFailure(result))"),
    );
    expect(lockBlock).toContain("sendMessage(chatId");
    expect(lockBlock).toMatch(/session.*reset/i);
  });
});
