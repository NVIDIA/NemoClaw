// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type AttachScenario =
  | "success"
  | "drift"
  | "exhausted"
  | "other-error"
  | "revision"
  | "unknown"
  | "collision";

function runAttachScenario(scenario: AttachScenario) {
  const script = String.raw`
const scenario = ${JSON.stringify(scenario)};
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const expectedId = "11111111-2222-4333-8444-555555555555";
const foreignId = "99999999-8888-4777-8666-555555555555";
let attached = false;
let liveId = expectedId;
let revision = 4;
let attachCalls = 0;
const runtimeSelection = { gatewayName: "nemoclaw-8091", workspace: "default" };
providerCommands.runOpenshellProviderCommand = (args, options) => {
  if (
    options?.runtimeSelection?.gatewayName !== runtimeSelection.gatewayName ||
    options?.runtimeSelection?.workspace !== runtimeSelection.workspace
  ) {
    throw new Error("provider command did not retain the recorded runtime selection");
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "list") {
    if (attachCalls > 0 && scenario === "unknown") return { status: 1, stdout: "", stderr: "connection refused" };
    if (attachCalls > 0 && scenario === "collision") return { status: 0, stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nforeign nemoclaw-mcp-v1 1 0\n", stderr: "" };
    return attached
      ? { status: 0, stdout: "NAME TYPE CREDENTIAL_KEYS CONFIG_KEYS\nalpha-mcp-fake nemoclaw-mcp-v1 1 0\n", stderr: "" }
      : { status: 0, stdout: "No providers attached to sandbox alpha.\n", stderr: "" };
  }
  if (args[0] === "provider" && args[1] === "get") {
    return {
      status: 0,
      stdout: "Name: " + args[2] + "\nId: " + liveId + "\nType: nemoclaw-mcp-v1\nResource version: " + revision + "\nCredential keys: EXPECTED_TOKEN\nConfig keys: <none>\n",
      stderr: "",
    };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
    attachCalls += 1;
    if (scenario === "other-error") {
      return { status: 1, stdout: "", stderr: "Failed to attach provider: permission denied" };
    }
    if (attachCalls === 1 || scenario === "exhausted") {
      if (scenario === "drift") liveId = foreignId;
      if (scenario === "revision") revision = 5;
      return {
        status: 1,
        stdout: "",
        stderr: "Failed to attach provider: sandbox was modified by another operation. Please retry the command.",
      };
    }
    attached = true;
    return { status: 0, stdout: "Attached provider alpha-mcp-fake from sandbox alpha.", stderr: "" };
  }
  throw new Error("unexpected call: " + args.join(" "));
};
const providerActions = require("./src/lib/actions/sandbox/mcp-bridge-provider.js");
const entry = {
  server: "fake",
  agent: "openclaw",
  adapter: "openclaw-config",
  url: "https://mcp.example.test/mcp",
  env: ["EXPECTED_TOKEN"],
  providerName: "alpha-mcp-fake",
  providerId: expectedId,
  policyName: "mcp-bridge-fake",
};
let outcome = null;
let message = null;
(async () => {
  try {
    outcome = await providerActions.attachProvider("alpha", entry, runtimeSelection); outcome = "attached";
  } catch (error) {
    message = error.message;
  }
  process.stdout.write(JSON.stringify({ outcome, message, attachCalls, attached, liveId }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    outcome: string | null;
    message: string | null;
    attachCalls: number;
    attached: boolean;
    liveId: string;
  };
}

describe("MCP provider attach retry", () => {
  it("retries one exact OpenShell sandbox mutation conflict", () => {
    expect(runAttachScenario("success")).toMatchObject({
      outcome: "attached",
      message: null,
      attachCalls: 2,
      attached: true,
    });
  });

  it("refuses to retry when the attachment identity drifts", () => {
    const result = runAttachScenario("drift");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("changed before attach");
    expect(result.attachCalls).toBe(1);
    expect(result.attached).toBe(false);
  });

  it("bounds repeated sandbox mutation conflicts", () => {
    const result = runAttachScenario("exhausted");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.attachCalls).toBe(2);
    expect(result.attached).toBe(false);
  });

  it("does not retry unrelated attach failures", () => {
    const result = runAttachScenario("other-error");
    expect(result.outcome).toBeNull();
    expect(result.message).toBe("OpenShell could not authenticate the provider operation.");
    expect(result.attachCalls).toBe(1);
    expect(result.attached).toBe(false);
  });
  it("refuses to retry when the provider revision changes", () => {
    const result = runAttachScenario("revision");
    expect(result.message).toContain("changed during attach");
    expect(result.attachCalls).toBe(1);
    expect(result.attached).toBe(false);
  });

  it("does not retry without an attachment observation", () => {
    const result = runAttachScenario("unknown");
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.attachCalls).toBe(1);
    expect(result.attached).toBe(false);
  });

  it("does not retry when another attachment supplies the credential key", () => {
    const result = runAttachScenario("collision");
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.attachCalls).toBe(1);
    expect(result.attached).toBe(false);
  });
});
