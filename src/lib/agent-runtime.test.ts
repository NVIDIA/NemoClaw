// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
// Import from compiled dist/ so coverage is attributed correctly.
import { buildRecoveryScript } from "../../dist/lib/agent-runtime";
import type { AgentDefinition } from "./agent-defs";

// Test fixture — only fields read by buildRecoveryScript are needed.
// Cast via unknown to avoid requiring the full AgentDefinition shape.
const minimalAgent = {
  name: "test-agent",
  displayName: "Test Agent",
  binary_path: "/usr/local/bin/test-agent",
  gateway_command: "test-agent gateway run",
  healthProbe: { url: "http://127.0.0.1:19000/" },
} as unknown as AgentDefinition;

describe("buildRecoveryScript", () => {
  it("returns null for null agent (OpenClaw inline script handles it)", () => {
    expect(buildRecoveryScript(null, 18789)).toBeNull();
  });

  it("embeds the port in the gateway launch command (#1925)", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("--port 19000");
  });

  it("embeds the default port when called with default value", () => {
    const script = buildRecoveryScript(minimalAgent, 18789);
    expect(script).toContain("--port 18789");
  });

  it("uses the agent gateway_command, not a hardcoded openclaw", () => {
    const script = buildRecoveryScript(minimalAgent, 19000);
    expect(script).toContain("test-agent gateway run --port 19000");
  });

  it("falls back to openclaw gateway run when gateway_command is absent", () => {
    const agent = { ...minimalAgent, gateway_command: undefined } as unknown as AgentDefinition;
    const script = buildRecoveryScript(agent, 19000);
    expect(script).toContain("openclaw gateway run --port 19000");
  });
});
