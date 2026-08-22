// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

// Import from compiled dist for parity with the other CLI tests in this project.
import { collectGatewayWedgeDiagnostics, sanitizeWedgeLogLine } from "./gateway-wedge-diagnostics";

describe("collectGatewayWedgeDiagnostics wedge signature (#4710)", () => {
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
        "gateway startup failed: \u001b[31mboom\u001b[0m Process will stay alive\n" +
        "gateway startup failed: env OPENAI_API_KEY=example-not-a-real-value-0001\n" +
        "gateway startup failed: SLACK_BOT_TOKEN=example-not-a-real-value-0002\n" +
        "Process will stay alive; TELEGRAM_BOT_TOKEN=example-not-a-real-value-0003\n",
      stderr: "",
    }));
    expect(lines[0]).toBe("gateway startup failed: Authorization: Bearer [REDACTED] rejected");
    expect(lines[1]).toBe('gateway startup failed: api_key="<REDACTED>" invalid');
    // Terminal escape sequences are stripped so sandbox output cannot forge
    // operator-terminal content.
    expect(lines[2]).toBe("gateway startup failed: [31mboom[0m Process will stay alive");
    expect(lines[2]).not.toContain("\u001b");
    // Underscore-separated credential env names need the shared redactor: `\b`
    // does not match between `_` and a word character, so the local patterns
    // above never reach the assignment.
    expect(lines[3]).toBe("gateway startup failed: env OPENAI_API_KEY=<REDACTED>");
    expect(lines[4]).toBe("gateway startup failed: SLACK_BOT_TOKEN=<REDACTED>");
    expect(lines[5]).toBe("Process will stay alive; TELEGRAM_BOT_TOKEN=<REDACTED>");
  });
});

describe("sanitizeWedgeLogLine", () => {
  it("keeps the wedge-specific short nvapi fallback", () => {
    expect(sanitizeWedgeLogLine("auth with nvapi-x failed")).toBe("auth with [REDACTED] failed");
  });

  it("uses the shared redactor for generic credential assignments", () => {
    expect(sanitizeWedgeLogLine("retry token=sk-live-456 now")).toBe("retry token=<REDACTED> now");
    expect(sanitizeWedgeLogLine("PASSWORD: hunter2 rejected")).toBe(
      "PASSWORD: <REDACTED> rejected",
    );
  });

  it.each([
    ['OPENAI_API_KEY="opaque api key value"', "opaque api key value"],
    ["SERVICE_TOKEN='opaque token value'", "opaque token value"],
    ['DATABASE_PASSWORD="opaque password value"', "opaque password value"],
    ["WEBHOOK_SECRET='opaque secret value'", "opaque secret value"],
  ])("redacts the complete quoted value in %s", (assignment, secret) => {
    const sanitized = sanitizeWedgeLogLine(
      `gateway startup failed: ${assignment}; safe diagnostic remains`,
    );

    expect(sanitized).not.toContain(secret);
    expect(sanitized).toContain("REDACTED");
    expect(sanitized).toContain("; safe diagnostic remains");
  });

  it.each([
    ["double-quoted", 'api_key="opaque first second', 'api_key="<REDACTED>"'],
    ["single-quoted", "token='opaque first second", "token='<REDACTED>'"],
    [
      "double-quoted with a dangling backslash",
      'api_key="opaque first second\\',
      'api_key="<REDACTED>"',
    ],
    [
      "single-quoted with a dangling backslash",
      "token='opaque first second\\",
      "token='<REDACTED>'",
    ],
  ])(
    "fails closed for an unterminated %s wedge-log secret assignment (#9863)",
    (_case, assignment, expected) => {
      const sanitized = sanitizeWedgeLogLine(`gateway startup failed: ${assignment}`);

      expect(sanitized).toBe(`gateway startup failed: ${expected}`);
    },
  );

  it("preserves a carriage-return boundary until redaction completes", () => {
    expect(
      sanitizeWedgeLogLine(
        'gateway startup failed: CUSTOM_TOKEN="opaque secret\rsafe diagnostic"',
      ),
    ).toBe('gateway startup failed: CUSTOM_TOKEN="<REDACTED>"safe diagnostic"');
  });

  it("leaves ordinary wedge lines untouched", () => {
    const line =
      "gateway startup failed: listen EADDRINUSE. Process will stay alive; fix the issue and restart.";
    expect(sanitizeWedgeLogLine(line)).toBe(line);
  });
});
