// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Focused unit tests for the E2E trusted-command boundary. Process lifecycle
 * coverage belongs to test/helpers/process-supervisor.test.ts.
 */

import { describe, expect, it } from "vitest";

import { trustedShellCommand, validateShellToken } from "../fixtures/shell/trusted-command.ts";

const NUL = String.fromCharCode(0);

describe("fixtures/shell/trusted-command", () => {
  it("validateShellToken rejects NUL bytes with a labelled error", () => {
    expect(() => validateShellToken(`a${NUL}b`, "argv[0]")).toThrowError(
      /argv\[0\] cannot contain NUL bytes/,
    );
  });

  it("validateShellToken passes a clean token through unchanged", () => {
    expect(validateShellToken("bash", "command")).toBe("bash");
  });

  it("trustedShellCommand rejects NUL bytes in the command", () => {
    expect(() => trustedShellCommand({ command: `ba${NUL}sh`, reason: "test" })).toThrowError(
      /command cannot contain NUL bytes/,
    );
  });

  it("trustedShellCommand rejects NUL bytes in arguments", () => {
    expect(() =>
      trustedShellCommand({ command: "bash", args: [`x${NUL}y`], reason: "test" }),
    ).toThrowError(/argument cannot contain NUL bytes/);
  });

  it("trustedShellCommand requires a non-empty reason", () => {
    expect(() => trustedShellCommand({ command: "bash", reason: "   " })).toThrowError(
      /reason is required/,
    );
  });

  it("trustedShellCommand runs the caller's validate hook", () => {
    expect(() =>
      trustedShellCommand({
        command: "bash",
        args: ["-c", "echo hi"],
        reason: "test",
        validate: () => {
          throw new Error("validate hook ran");
        },
      }),
    ).toThrowError(/validate hook ran/);
  });
});
