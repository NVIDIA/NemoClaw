// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
import { createCliOpenShellSandboxSettings } from "./sandbox-settings-cli";

describe("sandbox audit settings", () => {
  it("enables audit logs on the requested gateway with bounded capture", async () => {
    const capture = vi.fn(async () => ({ status: 0, output: "" }));
    const result = await createCliOpenShellSandboxSettings(capture).enableAuditLogs({
      target: namedOpenShellGateway("nemoclaw"),
      sandboxName: "alpha",
      timeoutMs: 500,
    });
    expect(result).toEqual({ ok: true, value: undefined });
    expect(capture).toHaveBeenCalledWith(
      [
        "settings",
        "set",
        "-g",
        "nemoclaw",
        "alpha",
        "--key",
        "ocsf_json_enabled",
        "--value",
        "true",
      ],
      expect.objectContaining({ timeout: 500, outputLimitBytes: 1024 * 1024 }),
    );
  });

  it.each([
    [1, "unauthorized credential-canary", undefined, "authentication"],
    [
      null,
      "credential-canary",
      Object.assign(new Error("credential-canary"), { code: "ETIMEDOUT" }),
      "timeout",
    ],
    [null, "credential-canary", undefined, "command"],
    [0, "credential-canary", new Error("credential-canary"), "command"],
  ] as const)(
    "classifies failed audit updates without exposing diagnostics (%s, %s)",
    async (status, output, error, kind) => {
      const capture = vi.fn(async () => ({ status, output, ...(error ? { error } : {}) }));
      const result = await createCliOpenShellSandboxSettings(capture).enableAuditLogs({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        timeoutMs: 500,
      });
      expect(result).toMatchObject({ ok: false, error: { kind } });
      expect(JSON.stringify(result)).not.toContain("credential-canary");
      expect(capture).toHaveBeenCalledOnce();
    },
  );

  it("rejects invalid targets without starting a process", async () => {
    const capture = vi.fn(async () => ({ status: 0, output: "" }));
    expect(
      await createCliOpenShellSandboxSettings(capture).enableAuditLogs({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha; whoami",
        timeoutMs: 500,
      }),
    ).toMatchObject({ ok: false, error: { reason: "invalid_request" } });
    expect(capture).not.toHaveBeenCalled();
  });
});
