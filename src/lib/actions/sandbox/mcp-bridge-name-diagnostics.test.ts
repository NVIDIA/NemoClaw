// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  validateMcpServerName,
  validatePersistedMcpCredentialEnvName,
  validateSandboxName,
} from "./mcp-bridge-validation";

const ESC = String.fromCharCode(27);

function messageFrom(reject: () => void): string {
  try {
    reject();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the validator to reject the name");
}

describe("MCP bridge name diagnostics", () => {
  it("escapes control characters in a rejected sandbox name (#7796)", () => {
    const message = messageFrom(() => validateSandboxName(`bad${ESC}[31mX`));

    expect(message).toContain(String.raw`Invalid sandbox name "bad\u001b[31mX"`);
    expect(message).not.toContain(ESC);
  });

  it("escapes control characters in a rejected MCP server name (#7796)", () => {
    const message = messageFrom(() => validateMcpServerName(`srv${ESC}]0;title`));

    expect(message).toContain(String.raw`Invalid MCP server name "srv\u001b]0;title"`);
    expect(message).not.toContain(ESC);
  });

  it("escapes control characters in a rejected credential environment name (#7796)", () => {
    const message = messageFrom(() => validatePersistedMcpCredentialEnvName(`TOKEN${ESC}[2J`));

    expect(message).toContain(String.raw`Invalid environment variable name "TOKEN\u001b[2J"`);
    expect(message).not.toContain(ESC);
  });

  it("bounds an over-length rejected name to a truncated preview (#7796)", () => {
    const message = messageFrom(() => validateSandboxName(`Bad${"x".repeat(200)}`));

    expect(message).toContain(`"Bad${"x".repeat(77)}..."`);
    expect(message.length).toBeLessThan(200);
  });
});
