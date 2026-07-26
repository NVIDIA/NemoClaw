// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { formatPortConflictReport } from "./port-conflict-report";

const ORIGINAL_STDERR = {
  isTTY: process.stderr.isTTY,
  getColorDepth: process.stderr.getColorDepth,
};

function stubStderr(isTTY: boolean, colorDepth: number): void {
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
  Object.defineProperty(process.stderr, "getColorDepth", {
    value: () => colorDepth,
    configurable: true,
  });
}

function restoreStderr(): void {
  Object.defineProperty(process.stderr, "isTTY", {
    value: ORIGINAL_STDERR.isTTY,
    configurable: true,
  });
  Object.defineProperty(process.stderr, "getColorDepth", {
    value: ORIGINAL_STDERR.getColorDepth,
    configurable: true,
  });
}

const RED = (text: string) => `\x1b[31m${text}\x1b[39m`;

describe("port conflict report", () => {
  afterEach(() => {
    restoreStderr();
    vi.unstubAllEnvs();
  });

  it("uses the shared error presentation for the conflict heading (#6752)", () => {
    vi.stubEnv("NO_COLOR", "");
    stubStderr(true, 24);

    const report = formatPortConflictReport({
      port: 8080,
      label: "OpenShell gateway",
      envVar: "NEMOCLAW_GATEWAY_PORT",
      portCheck: {
        ok: false,
        process: "python3",
        pid: 1234,
        reason: "lsof reports python3 (PID 1234) listening on port 8080",
      },
      serviceHints: ["       systemctl --user stop openclaw-gateway.service"],
    }).join("\n");

    expect(report).toContain(`  ${RED("✗ Port 8080 is not available.")}`);
    expect(report).toContain("Blocked by: python3 (PID 1234)");
    expect(report).toContain("sudo kill 1234");
    expect(report).toContain("NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard");
  });

  it("does not emit raw ANSI escapes when stderr is not color-capable (#6752)", () => {
    vi.stubEnv("NO_COLOR", "");
    stubStderr(false, 1);

    const report = formatPortConflictReport({
      port: 8080,
      label: "OpenShell gateway",
      envVar: "NEMOCLAW_GATEWAY_PORT",
      portCheck: {
        ok: false,
        process: "unknown",
        pid: null,
        reason: "port 8080 is in use (EADDRINUSE)",
      },
    }).join("\n");

    expect(report).toContain("  ✗ Port 8080 is not available.");
    expect(report).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(report).toContain("Could not identify the process using port 8080.");
  });
});
