// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";

// Import from compiled dist for parity with the other CLI tests in this project.
import {
  collectGatewayWedgeDiagnostics,
  sanitizeWedgeLogLine,
} from "../../../../dist/lib/actions/sandbox/gateway-wedge-diagnostics";

describe("collectGatewayWedgeDiagnostics — #4710 wedge signature", () => {
  it("returns the matching gateway.log lines, trimmed", () => {
    const lines = collectGatewayWedgeDiagnostics("my-sandbox", () => ({
      status: 0,
      stdout:
        "  [reload] config change requires gateway restart (plugins.installs)\n" +
        "  gateway startup failed: listen EADDRINUSE. Process will stay alive; fix the issue and restart.\n",
      stderr: "",
    }));
    expect(lines).toEqual([
      "[reload] config change requires gateway restart (plugins.installs)",
      "gateway startup failed: listen EADDRINUSE. Process will stay alive; fix the issue and restart.",
    ]);
  });

  it("returns [] when nothing matches (grep exits non-zero)", () => {
    const lines = collectGatewayWedgeDiagnostics("my-sandbox", () => ({
      status: 1,
      stdout: "",
      stderr: "",
    }));
    expect(lines).toEqual([]);
  });

  it("returns [] when the sandbox exec is unavailable", () => {
    const lines = collectGatewayWedgeDiagnostics("my-sandbox", () => null);
    expect(lines).toEqual([]);
  });

  it("sanitizes sandbox-controlled log lines before returning them", () => {
    const lines = collectGatewayWedgeDiagnostics("my-sandbox", () => ({
      status: 0,
      stdout:
        "gateway startup failed: Authorization: Bearer abc.def.ghi rejected\n" +
        'gateway startup failed: api_key="nv-secret-123" invalid\n' +
        "gateway startup failed: \u001b[31mboom\u001b[0m Process will stay alive\n",
      stderr: "",
    }));
    expect(lines[0]).toBe("gateway startup failed: Authorization: Bearer [REDACTED] rejected");
    expect(lines[1]).toBe('gateway startup failed: api_key="[REDACTED] invalid');
    // Terminal escape sequences are stripped so sandbox output cannot forge
    // operator-terminal content.
    expect(lines[2]).toBe("gateway startup failed: [31mboom[0m Process will stay alive");
    expect(lines[2]).not.toContain("\u001b");
  });
});

describe("sanitizeWedgeLogLine", () => {
  it("redacts nvapi keys and token assignments", () => {
    expect(sanitizeWedgeLogLine("auth with nvapi-AbC123xyz failed")).toBe(
      "auth with [REDACTED] failed",
    );
    expect(sanitizeWedgeLogLine("retry token=sk-live-456 now")).toBe("retry token=[REDACTED] now");
    expect(sanitizeWedgeLogLine("PASSWORD: hunter2 rejected")).toBe(
      "PASSWORD: [REDACTED] rejected",
    );
  });

  it("leaves ordinary wedge lines untouched", () => {
    const line =
      "gateway startup failed: listen EADDRINUSE. Process will stay alive; fix the issue and restart.";
    expect(sanitizeWedgeLogLine(line)).toBe(line);
  });
});
