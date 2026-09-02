// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createSyncCliOpenShellSandboxIdentityInspector } from "./sandbox-identity-cli";

function captured(status: number | null, stdout = "", stderr = "", error?: Error) {
  return {
    status,
    output: `${stdout}${stderr}`.trim(),
    stdout,
    stderr,
    ...(error ? { error } : {}),
  };
}

describe("CLI OpenShell sandbox identity inspector", () => {
  it("pins the identity read to one gateway with bounded capture", () => {
    const capture = vi.fn(() => captured(0, "Name: alpha\nID: sandbox-alpha\n"));
    const inspect = createSyncCliOpenShellSandboxIdentityInspector({ capture });

    expect(
      inspect({ sandboxName: "alpha", gatewayName: "nemoclaw-18080", timeoutMs: 4_321 }),
    ).toEqual({
      ok: true,
      value: createHash("sha256").update("sandbox-alpha").digest("hex"),
    });
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      ["sandbox", "get", "-g", "nemoclaw-18080", "alpha"],
      {
        ignoreError: true,
        includeStderr: true,
        includeStreams: true,
        maxBuffer: 1024 * 1024,
        timeout: 4_321,
      },
    );
  });

  it("rejects invalid names before invoking OpenShell", () => {
    const capture = vi.fn(() => captured(0));
    const inspect = createSyncCliOpenShellSandboxIdentityInspector({ capture });

    expect(() => inspect({ sandboxName: "alpha; whoami", gatewayName: "nemoclaw" })).toThrow(
      "Invalid sandbox name",
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it.each([
    [
      "unavailable binary",
      captured(
        null,
        "",
        "",
        Object.assign(new Error("spawnSync openshell ENOENT"), { code: "ENOENT" }),
      ),
      { kind: "command", reason: "failed" },
    ],
    [
      "timeout",
      captured(null, "", "", Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
      { kind: "timeout" },
    ],
    ["authentication", captured(1, "", "Error: unauthorized"), { kind: "authentication" }],
    [
      "transport",
      captured(1, "", "Error: connection refused"),
      { kind: "transport", reason: "unreachable" },
    ],
    ["schema", captured(0, "Name: alpha\nPhase: Ready\n"), { kind: "schema" }],
  ] as const)("returns a typed %s failure", (_label, result, expectedError) => {
    const inspect = createSyncCliOpenShellSandboxIdentityInspector({ capture: () => result });

    expect(inspect({ sandboxName: "alpha", gatewayName: "nemoclaw" })).toMatchObject({
      ok: false,
      error: expectedError,
    });
  });
});
