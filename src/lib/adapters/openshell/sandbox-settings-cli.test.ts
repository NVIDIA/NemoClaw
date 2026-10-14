// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { namedOpenShellGateway, selectedOpenShellGateway } from "./sandbox-observer";
import { createCliOpenShellSandboxSettings } from "./sandbox-settings-cli";

describe("sandbox audit settings", () => {
  it("enables audit logs on the requested gateway with bounded capture", async () => {
    const capture = vi.fn(async () => ({ status: 0, output: "" }));
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    let result;
    try {
      result = await createCliOpenShellSandboxSettings(capture).enableAuditLogs({
        target: namedOpenShellGateway("nemoclaw"),
        sandboxName: "alpha",
        timeoutMs: 500,
      });
      expect(notice).toHaveBeenCalledWith(expect.stringContaining("attempting to enable"));
    } finally {
      notice.mockRestore();
    }
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

  it("does not change audit settings when automatic enablement is disabled", async () => {
    const capture = vi.fn(async () => ({ status: 0, output: "" }));
    vi.stubEnv("NEMOCLAW_NO_AUTO_AUDIT_LOGS", "1");
    try {
      const result = await createCliOpenShellSandboxSettings(capture).enableAuditLogs({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        timeoutMs: 500,
      });
      expect(result).toEqual({ ok: true, value: undefined });
      expect(capture).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not claim audit logging was enabled when the settings command fails", async () => {
    const capture = vi.fn(async () => ({ status: 1, output: "" }));
    const notice = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await createCliOpenShellSandboxSettings(capture).enableAuditLogs({
        target: selectedOpenShellGateway(),
        sandboxName: "alpha",
        timeoutMs: 500,
      });
      expect(result).toMatchObject({ ok: false });
      expect(notice).toHaveBeenCalledWith(expect.stringContaining("attempting to enable"));
      expect(notice).not.toHaveBeenCalledWith(expect.stringContaining("audit logs enabled"));
    } finally {
      notice.mockRestore();
    }
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
