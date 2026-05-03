// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseDuration } from "./duration";
import { parseGatewayTokenArgs, runGatewayTokenCommand } from "./gateway-token-command";
import { resolveDefaultSandboxName, runStartCommand, runStopCommand } from "./services-command";
import { getVersion } from "./version";

// Narrow coverage guard for small helper modules that are otherwise only
// exercised through subprocess CLI flows in this migration stack.
describe("small CLI helper coverage", () => {
  it("parses durations and rejects invalid values", () => {
    expect(parseDuration("5m")).toBe(300);
    expect(() => parseDuration("31m")).toThrow(/exceeds maximum/);
  });

  it("parses and runs gateway-token helpers", () => {
    expect(parseGatewayTokenArgs(["--quiet", "extra"])).toEqual({
      options: { quiet: true },
      unknown: ["extra"],
    });

    const output: string[] = [];
    const warnings: string[] = [];
    expect(
      runGatewayTokenCommand(
        "alpha",
        { quiet: false },
        {
          fetchToken: () => "token-123",
          log: (message) => output.push(message),
          error: (message) => warnings.push(message),
        },
      ),
    ).toBe(0);
    expect(output).toEqual(["token-123"]);
    expect(warnings.join("\n")).toContain("Treat this token like a password");

    expect(
      runGatewayTokenCommand(
        "alpha",
        {},
        { fetchToken: () => null, log: () => undefined, error: (message) => warnings.push(message) },
      ),
    ).toBe(1);
  });

  it("resolves service command sandbox names", async () => {
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "alpha" }))).toBe("alpha");
    expect(resolveDefaultSandboxName(() => ({ defaultSandbox: "bad name" }))).toBeUndefined();

    const startCalls: Array<{ sandboxName?: string }> = [];
    await runStartCommand({
      listSandboxes: () => ({ defaultSandbox: "alpha" }),
      startAll: async (options) => {
        startCalls.push(options);
      },
    });
    expect(startCalls).toEqual([{ sandboxName: "alpha" }]);

    const stopCalls: Array<{ sandboxName?: string }> = [];
    runStopCommand({
      listSandboxes: () => ({ defaultSandbox: null }),
      stopAll: (options) => {
        stopCalls.push(options);
      },
    });
    expect(stopCalls).toEqual([{}]);
  });

  it("reads version fallback files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-version-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "9.8.7" }));
    expect(getVersion({ rootDir: root })).toBe("9.8.7");
  });
});
