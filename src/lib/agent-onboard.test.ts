// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { printDashboardUi } from "../../dist/lib/agent-onboard";
import type { AgentDefinition } from "./agent-defs";

// Test fixtures — only the fields printDashboardUi reads are populated.
// Cast via unknown to avoid requiring the full AgentDefinition shape.
const apiAgent = {
  name: "hermes",
  displayName: "Hermes Agent",
  forwardPort: 8642,
  dashboard: { kind: "api", label: "OpenAI-compatible API", path: "/v1" },
} as unknown as AgentDefinition;

const uiAgent = {
  name: "ficticious-ui",
  displayName: "Ficticious",
  forwardPort: 19000,
  dashboard: { kind: "ui", label: "UI", path: "/" },
} as unknown as AgentDefinition;

// Regression fixture for issue #2078 — matches the text a user sees when
// no token is available and prevents the wording from regressing to
// something that implies port 8642 is a browser UI.
const buildUrlsLoopback = (token: string | null, port: number): string[] => {
  const hash = token ? `#token=${token}` : "";
  return [`http://127.0.0.1:${port}/${hash}`];
};

describe("printDashboardUi — regression for #2078 (port 8642 is not a chat UI)", () => {
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const noteSpy = vi.fn();

  beforeEach(() => {
    logSpy.mockClear();
    noteSpy.mockReset();
  });

  afterEach(() => {
    logSpy.mockClear();
  });

  afterAll(() => {
    logSpy.mockRestore();
  });

  it("labels an API-kind agent as the API — not a UI — and does not embed a token in the URL", () => {
    printDashboardUi("sandbox-x", "secret-token", apiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).not.toContain("UI (tokenized URL");
    expect(output).toContain("Port 8642 must be forwarded before connecting.");
    expect(output).toContain("http://127.0.0.1:8642/v1");
    // Token-in-URL-fragment auth does not apply to the OpenAI API endpoint.
    expect(output).not.toContain("#token=secret-token");
  });

  it("prints the API URL consistently whether or not a gateway token was read", () => {
    printDashboardUi("sandbox-x", null, apiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Hermes Agent OpenAI-compatible API");
    expect(output).toContain("http://127.0.0.1:8642/v1");
    // The API endpoint does not require the gateway token — don't confuse
    // the user with the OpenClaw-style "token missing" warning.
    expect(noteSpy).not.toHaveBeenCalled();
  });

  it("keeps the existing tokenized URL wording for UI-kind agents", () => {
    printDashboardUi("sandbox-y", "tok", uiAgent, {
      note: noteSpy,
      buildControlUiUrls: buildUrlsLoopback,
    });

    const output = logSpy.mock.calls.map((args) => String(args[0])).join("\n");
    expect(output).toContain("Ficticious UI (tokenized URL; treat it like a password)");
    expect(output).toContain("Port 19000 must be forwarded before opening this URL.");
    expect(output).toContain("http://127.0.0.1:19000/#token=tok");
  });
});
