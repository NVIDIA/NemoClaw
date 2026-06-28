// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
// Import source directly so tests cannot pass against a stale build.
import { loadAgent } from "../agent/defs";
import { createOnboardDashboardHelpers } from "./dashboard";

// Minimal no-op deps; only runCaptureOpenshell matters for these tests.
function makeHelpers(runCaptureOpenshell: (args: string[], opts?: unknown) => string | null) {
  return createOnboardDashboardHelpers({
    runOpenshell: () => ({ status: 0 }),
    runCaptureOpenshell,
    openshellArgv: (args: string[]) => ["openshell", ...args],
    cliName: () => "nemoclaw",
    agentProductName: () => "NemoHermes",
    getProviderLabel: (p: string) => p,
    note: () => {},
    isWsl: () => false,
    redact: (v: unknown) => String(v),
    sleep: () => {},
    printAgentDashboardUi: () => {},
  });
}

describe("fetchAgentWebAuthTokenFromSandbox", () => {
  const hermes = loadAgent("hermes");
  const openclaw = loadAgent("openclaw");

  it("greps the agent's .env via sandbox exec and returns the value", () => {
    const calls: string[][] = [];
    const helpers = makeHelpers((args) => {
      calls.push(args);
      return "deadbeefcafe\n";
    });

    const token = helpers.fetchAgentWebAuthTokenFromSandbox("hermes", hermes);
    expect(token).toBe("deadbeefcafe");

    // Runs as the sandbox user against the agent's env file, matching the key.
    const args = calls[0];
    expect(args.slice(0, 5)).toEqual(["sandbox", "exec", "-n", "hermes", "--"]);
    const script = args[args.length - 1];
    expect(script).toContain("/sandbox/.hermes/.env");
    expect(script).toContain("export[[:space:]]+");
    expect(script).toContain("API_SERVER_KEY=");
  });

  it("accepts export-prefixed dotenv assignments", () => {
    const calls: string[][] = [];
    const helpers = makeHelpers((args) => {
      calls.push(args);
      return `"exported-value"\n`;
    });

    expect(helpers.fetchAgentWebAuthTokenFromSandbox("hermes", hermes)).toBe("exported-value");
    const script = calls[0][calls[0].length - 1];
    expect(script).toContain("grep -m1 -E");
    expect(script).toContain("sed -E");
    expect(script).toContain("(export[[:space:]]+)?API_SERVER_KEY=");
  });

  it("strips a single layer of surrounding quotes", () => {
    const helpers = makeHelpers(() => `'quoted-value'\n`);
    expect(helpers.fetchAgentWebAuthTokenFromSandbox("hermes", hermes)).toBe("quoted-value");
  });

  it("returns null when the value is absent or the read fails", () => {
    expect(makeHelpers(() => null).fetchAgentWebAuthTokenFromSandbox("hermes", hermes)).toBeNull();
    expect(
      makeHelpers(() => "  \n").fetchAgentWebAuthTokenFromSandbox("hermes", hermes),
    ).toBeNull();
  });

  it("returns null for non-bearer_token agents without touching the sandbox", () => {
    const runCaptureOpenshell = vi.fn(() => "should-not-run");
    const helpers = makeHelpers(runCaptureOpenshell);
    expect(helpers.fetchAgentWebAuthTokenFromSandbox("alpha", openclaw)).toBeNull();
    expect(runCaptureOpenshell).not.toHaveBeenCalled();
  });
});
