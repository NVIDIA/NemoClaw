// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createSyncCliOpenShellSandboxIdentityInspector } from "./sandbox-identity-cli";

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it("uses the complete recorded target and discards ambient endpoint credentials", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "hostile-gateway");
    vi.stubEnv("OPENSHELL_WORKSPACE", "hostile-workspace");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/hostile/tls");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://hostile.invalid");
    vi.stubEnv("OPENSHELL_TOKEN", "hostile-token");
    const capture = vi.fn((_args: string[], _options: Record<string, unknown>) =>
      captured(0, "ID: sandbox-alpha\n"),
    );
    const inspect = createSyncCliOpenShellSandboxIdentityInspector({ capture });

    const result = inspect({
      sandboxName: "alpha",
      gatewayName: "nemoclaw-18080",
      runtimeSelection: {
        gatewayName: "nemoclaw-18080",
        workspace: "default",
        localTlsDir: "/authority/tls",
      },
    });

    expect(result.ok).toBe(true);
    const options = capture.mock.calls[0]?.[1] as
      | { env?: Record<string, string>; replaceEnv?: boolean }
      | undefined;
    expect(options).toMatchObject({
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-18080",
        OPENSHELL_WORKSPACE: "default",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      },
    });
    expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(options?.env).not.toHaveProperty("OPENSHELL_TOKEN");
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
