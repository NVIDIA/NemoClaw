// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { buildChannelRuntimeProbe } from "../../../dist/lib/onboard/verify-channel-runtime.js";

// The helper only inspects `agent.configPaths`, so a minimal stub is enough.
function fakeAgent(format: string | null) {
  if (format === null) return null;
  return {
    configPaths: {
      dir: "/sandbox/.openclaw",
      configFile: "openclaw.json",
      envFile: null,
      format,
    },
  } as unknown as Parameters<typeof buildChannelRuntimeProbe>[0];
}

describe("buildChannelRuntimeProbe", () => {
  it("returns null when no agent is selected", () => {
    expect(buildChannelRuntimeProbe(null, { executeSandboxCommand: () => null })).toBeNull();
  });

  it("returns null for non-JSON agents (e.g. Hermes uses yaml)", () => {
    expect(
      buildChannelRuntimeProbe(fakeAgent("yaml"), { executeSandboxCommand: () => null }),
    ).toBeNull();
  });

  it("returns a probe function for JSON agents (OpenClaw) that targets <dir>/<configFile>", () => {
    const captured: string[] = [];
    const probe = buildChannelRuntimeProbe(fakeAgent("json"), {
      executeSandboxCommand: (script: string) => {
        captured.push(script);
        // First call reads the config; second call scans the gateway log.
        return { status: 0, stdout: script.startsWith("cat ") ? "{}" : "", stderr: "" };
      },
    });
    expect(probe).toBeTypeOf("function");
    const result = probe!();
    expect(result).not.toBeNull();
    // The first exec call must be against the agent's config path (the
    // `cat <path>` snippet from probeChannelRuntimeStatus).
    expect(captured[0]).toContain("/sandbox/.openclaw/openclaw.json");
    expect(captured[0].startsWith("cat ")).toBe(true);
  });
});
