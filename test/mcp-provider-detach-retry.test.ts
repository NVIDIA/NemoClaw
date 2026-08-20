// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type DetachScenario = "success" | "drift" | "exhausted" | "other-error";

function runDetachScenario(scenario: DetachScenario) {
  const script = String.raw`
const scenario = ${JSON.stringify(scenario)};
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const expectedId = "11111111-2222-4333-8444-555555555555";
const foreignId = "99999999-8888-4777-8666-555555555555";
let attached = true;
let liveId = expectedId;
let detachCalls = 0;
providerCommands.runOpenshellProviderCommand = (args) => {
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    return attached
      ? { status: 0, stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-fake nemoclaw-mcp-v1 1 0\n", stderr: "" }
      : { status: 0, stdout: "No providers attached to sandbox alpha.\n", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Id: " + liveId + "\nType: nemoclaw-mcp-v1\nResource version: 4\nCredential keys: EXPECTED_TOKEN\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "detach") {
    detachCalls += 1;
    if (scenario === "other-error") {
      return { status: 1, stdout: "", stderr: "Failed to detach provider: permission denied" };
    }
    if (detachCalls === 1 || scenario === "exhausted") {
      if (scenario === "drift") liveId = foreignId;
      return {
        status: 1,
        stdout: "",
        stderr: "Failed to detach provider: sandbox was modified by another operation. Please retry the command.",
      };
    }
    attached = false;
    return { status: 0, stdout: "Detached provider alpha-mcp-fake from sandbox alpha.", stderr: "" };
  }
  throw new Error("unexpected call: " + args.join(" "));
};
const providerActions = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const entry = {
  server: "fake",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://mcp.example.test/mcp",
  env: ["EXPECTED_TOKEN"],
  providerName: "alpha-mcp-fake",
  providerId: expectedId,
  policyName: "mcp-bridge-fake",
  addedAt: "2026-06-01T00:00:00.000Z",
};
let outcome = null;
let message = null;
try {
  outcome = providerActions.detachProvider("alpha", entry);
} catch (error) {
  message = error.message;
}
process.stdout.write(JSON.stringify({ outcome, message, detachCalls, attached, liveId }));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    outcome: string | null;
    message: string | null;
    detachCalls: number;
    attached: boolean;
    liveId: string;
  };
}

describe("MCP provider detach retry", () => {
  it("retries one exact OpenShell sandbox mutation conflict", () => {
    expect(runDetachScenario("success")).toMatchObject({
      outcome: "detached",
      message: null,
      detachCalls: 2,
      attached: false,
    });
  });

  it("refuses to retry when the attachment identity drifts", () => {
    const result = runDetachScenario("drift");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.detachCalls).toBe(1);
    expect(result.attached).toBe(true);
  });

  it("bounds repeated sandbox mutation conflicts", () => {
    const result = runDetachScenario("exhausted");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.detachCalls).toBe(2);
    expect(result.attached).toBe(true);
  });

  it("does not retry unrelated detach failures", () => {
    const result = runDetachScenario("other-error");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("permission denied");
    expect(result.detachCalls).toBe(1);
    expect(result.attached).toBe(true);
  });
});
