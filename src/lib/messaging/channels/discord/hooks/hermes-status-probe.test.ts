// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { HERMES_DISCORD_STATUS_PROBE } from "./hermes-status-probe";
import { createDiscordStatusHealthHook } from "./status-health";

function probe(record: unknown, live = true): string {
  const setup = String.raw`
import sys, types, json, io
from pathlib import Path
fixture = json.load(sys.stdin)
gateway = types.ModuleType("gateway")
status = types.ModuleType("gateway.status")
status.runtime_status_pid_is_live = lambda record: fixture["live"]
sys.modules["gateway"] = gateway
sys.modules["gateway.status"] = status
def open_status(path, mode):
    if str(path) != "/sandbox/.hermes/runtime/gateway_state.json" or mode != "rb":
        raise ValueError("unexpected read")
    return io.BytesIO(json.dumps(fixture["record"]).encode() + b" " * fixture["record"].get("fixturePaddingBytes", 0))
Path.open = open_status
`;
  const result = spawnSync("python3", ["-c", setup + HERMES_DISCORD_STATUS_PROBE], {
    encoding: "utf8",
    input: JSON.stringify({ record, live }),
    timeout: 5_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function record(platform: Record<string, unknown> = {}) {
  return {
    kind: "hermes-gateway",
    pid: 42,
    start_time: 1234,
    gateway_state: "running",
    platforms: {
      discord: {
        writer_pid: 42,
        writer_start_time: 1234,
        state: "fatal",
        error_code: "discord_auth_error",
        error_message:
          "discord.errors.LoginFailure: Improper token has been passed. 401 Unauthorized invalid-token-for-test",
        ...platform,
      },
    },
  };
}

describe("Hermes Discord runtime evidence", () => {
  it("executes the fixed status probe through the sandbox shell (#13809)", async () => {
    const output: string[] = [];
    const hook = createDiscordStatusHealthHook({
      executeSandboxCommand: async (_sandbox, command) => {
        const result = spawnSync(
          "sh",
          ["-c", command.replace(/^\/opt\/hermes\/\.venv\/bin\/python /, "python3 ")],
          { encoding: "utf8", timeout: 5_000 },
        );
        output.push(result.stdout);
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
      },
    });
    await hook({
      channelId: "discord",
      hookId: "discord-hermes-status-health",
      phase: "status",
      inputs: {
        agent: "hermes",
        currentSandbox: "demo",
        channelEnabledInRegistry: true,
        presetApplied: true,
        presetOnGateway: true,
      },
    });
    expect(output).toEqual(['NEMOCLAW_DISCORD_STATUS_V1\n{"state": "unknown"}\n']);
  });
  it("reports authentication rejection from the runtime directory without exposing errors (#13809)", () => {
    const output = probe(record());
    expect(output).toContain('"state": "auth_failed"');
    expect(output).not.toContain("invalid-token-for-test");
    expect(output).not.toContain("LoginFailure");
  });
  it("reports recovery even when an old failure message remains (#13809)", () => {
    expect(probe(record({ state: "connected", error_code: null }))).toContain(
      '"state": "connected"',
    );
  });
  it.each([
    ["a prior writer PID", record({ writer_pid: 41 }), true],
    ["a reused writer PID", record({ writer_start_time: 1233 }), true],
    ["a missing writer identity", record({ writer_start_time: undefined }), true],
    ["a dead gateway", record(), false],
    ["missing native evidence", {}, true],
    ["malformed native evidence", { platforms: null }, true],
    ["oversize native evidence", { fixturePaddingBytes: 65_537 }, true],
  ])("reports uncertainty for %s (#13809)", (_condition, value, live) => {
    expect(probe(value, Boolean(live))).toContain('"state": "unknown"');
  });
  it("reports a disconnected adapter without claiming rejection (#13809)", () => {
    expect(probe(record({ state: "retrying", error_code: null }))).toContain('"state": "inactive"');
  });
});
