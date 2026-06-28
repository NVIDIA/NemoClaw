// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "./defs";
// Import source directly so tests cannot pass against a stale build.
import { printDashboardUi } from "./onboard";

const buildUrlsLoopback = (_token: string | null, port: number): string[] => [
  `http://127.0.0.1:${port}/`,
];

function makeBearerAgent(): AgentDefinition {
  return {
    name: "hermes",
    displayName: "Hermes Agent",
    forwardPort: 18789,
    healthProbe: { url: "http://localhost:8642/health", port: 8642, timeout_seconds: 90 },
    dashboard: {
      kind: "ui",
      label: "Dashboard",
      path: "/",
      healthPath: "/api/status",
      auth: "session",
    },
    webAuth: { method: "bearer_token", env: "API_SERVER_KEY" },
  } as AgentDefinition;
}

describe("printDashboardUi bearer-token agents", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const noteSpy = vi.fn();

  beforeEach(() => {
    logSpy.mockClear();
    noteSpy.mockReset();
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  it("surfaces the OpenAI-compatible API endpoint and key command", () => {
    printDashboardUi("hermes", null, makeBearerAgent(), {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent Dashboard");
    expect(output).toContain("OpenAI-compatible API (bearer auth)");
    expect(output).toContain("Port 8642 must be forwarded");
    expect(output).toContain("Get the key: nemoclaw hermes gateway-token --quiet");
    expect(output).not.toMatch(/Bearer [0-9a-f]{16,}/);
  });
});
