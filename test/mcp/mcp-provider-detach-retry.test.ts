// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  MCP_POLICY_BASE,
  MCP_POLICY_RECEIPT_AUTHORITY,
} from "../helpers/mcp-policy-receipt-process-fixture";

type DetachScenario =
  | "success"
  | "drift"
  | "exhausted"
  | "other-error"
  | "attach-already-exact"
  | "attach-authority-mismatch"
  | "detach-authority-mismatch"
  | "idempotent-detach-output"
  | "detach-finalize-failure"
  | "detach-post-cas-readback-failure";

function runDetachScenario(scenario: DetachScenario) {
  const script = String.raw`
const scenario = ${JSON.stringify(scenario)};
const policyAuthority = require("./src/lib/adapters/openshell/policy-authority.js");
const policies = require("./src/lib/policy/index.js");
const providerCommands = require("./src/lib/adapters/openshell/provider-command.js");
const expectedId = "11111111-2222-4333-8444-555555555555";
const foreignId = "99999999-8888-4777-8666-555555555555";
let attached = true;
let liveId = expectedId;
let detachCalls = 0;
let attachCalls = 0;
let receiptFinalized = false;
const receiptAuthority = ${JSON.stringify(MCP_POLICY_RECEIPT_AUTHORITY)};
if (scenario === "attach-authority-mismatch") attached = false;
policyAuthority.captureSandboxBasePolicy = () => ${JSON.stringify(MCP_POLICY_BASE)};
policies.inspectPolicyMutationAuthority = () => {
  if (scenario === "attach-authority-mismatch" || scenario === "detach-authority-mismatch") {
    throw new Error("policy creation receipt does not match the live sandbox policy");
  }
  return receiptAuthority;
};
policies.assertNemoClawManagedPolicy = () => {};
policies.recheckPolicyMutationAuthority = () => receiptAuthority;
policies.finalizePolicyMutationReceipt = () => {
  receiptFinalized = true;
  if (scenario === "detach-finalize-failure") {
    throw new Error("simulated detach receipt finalization failure");
  }
  if (scenario === "detach-post-cas-readback-failure") {
    throw new policies.PolicyMutationReceiptFinalVerificationError(
      "simulated post-CAS detach readback failure",
    );
  }
};
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
    if (
      (detachCalls === 1 &&
        scenario !== "detach-finalize-failure" &&
        scenario !== "detach-post-cas-readback-failure" &&
        scenario !== "idempotent-detach-output") ||
      scenario === "exhausted"
    ) {
      if (scenario === "drift") liveId = foreignId;
      return {
        status: 1,
        stdout: "",
        stderr: "Failed to detach provider: sandbox was modified by another operation. Please retry the command.",
      };
    }
    attached = false;
    if (scenario === "idempotent-detach-output") {
      return {
        status: 0,
        stdout: "Provider alpha-mcp-fake was not attached to sandbox alpha.",
        stderr: "",
      };
    }
    return { status: 0, stdout: "Detached provider alpha-mcp-fake from sandbox alpha.", stderr: "" };
  }
  if (args[0] === "sandbox" && args[1] === "provider" && args[2] === "attach") {
    attachCalls += 1;
    attached = true;
    return { status: 0, stdout: "Attached provider", stderr: "" };
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
  if (scenario === "attach-already-exact" || scenario === "attach-authority-mismatch") {
    providerActions.attachProvider("alpha", entry);
    outcome = "attached";
  } else {
    outcome = providerActions.detachProvider("alpha", entry);
  }
} catch (error) {
  message = error.message;
}
process.stdout.write(JSON.stringify({
  outcome,
  message,
  detachCalls,
  attachCalls,
  attached,
  liveId,
  receiptFinalized,
}));
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
    attachCalls: number;
    attached: boolean;
    liveId: string;
    receiptFinalized: boolean;
  };
}

describe("MCP provider detach retry", () => {
  it("retries one exact OpenShell sandbox mutation conflict", () => {
    expect(runDetachScenario("success")).toMatchObject({
      outcome: "detached",
      message: null,
      detachCalls: 2,
      attachCalls: 0,
      attached: false,
      receiptFinalized: true,
    });
  });

  it("refuses to retry when the attachment identity drifts", () => {
    const result = runDetachScenario("drift");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.detachCalls).toBe(1);
    expect(result.attached).toBe(true);
    expect(result.receiptFinalized).toBe(false);
  });

  it("bounds repeated sandbox mutation conflicts", () => {
    const result = runDetachScenario("exhausted");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("sandbox was modified by another operation");
    expect(result.detachCalls).toBe(2);
    expect(result.attached).toBe(true);
    expect(result.receiptFinalized).toBe(false);
  });

  it("does not retry unrelated detach failures", () => {
    const result = runDetachScenario("other-error");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("permission denied");
    expect(result.detachCalls).toBe(1);
    expect(result.attached).toBe(true);
    expect(result.receiptFinalized).toBe(false);
  });

  it.each(["attach-authority-mismatch", "detach-authority-mismatch"] as const)(
    "fails closed before an exact %s mutation when policy authority does not match (#9833)",
    (scenario) => {
      const result = runDetachScenario(scenario);
      expect(result.outcome).toBeNull();
      expect(result.message).toContain("policy creation receipt does not match");
      expect(result.detachCalls).toBe(0);
      expect(result.attachCalls).toBe(0);
      expect(result.receiptFinalized).toBe(false);
    },
  );

  it("does not attach or rotate the receipt when the exact attachment exists (#9833)", () => {
    expect(runDetachScenario("attach-already-exact")).toMatchObject({
      outcome: "attached",
      message: null,
      attachCalls: 0,
      attached: true,
      receiptFinalized: false,
    });
  });

  it("does not reattach after detach receipt finalization fails (#9833)", () => {
    const result = runDetachScenario("detach-finalize-failure");
    expect(result.outcome).toBeNull();
    expect(result.message).toContain("simulated detach receipt finalization failure");
    expect(result.detachCalls).toBe(1);
    expect(result.attachCalls).toBe(0);
    expect(result.attached).toBe(false);
    expect(result.receiptFinalized).toBe(true);
  });

  it("rotates the receipt when exact detach ends absent with idempotent output (#9833)", () => {
    expect(runDetachScenario("idempotent-detach-output")).toMatchObject({
      outcome: "detached",
      message: null,
      detachCalls: 1,
      attachCalls: 0,
      attached: false,
      receiptFinalized: true,
    });
  });

  it("accepts an exact detached edge after a post-CAS readback failure (#9833)", () => {
    const result = runDetachScenario("detach-post-cas-readback-failure");
    expect(result).toMatchObject({
      outcome: "detached",
      message: null,
      detachCalls: 1,
      attachCalls: 0,
      attached: false,
      receiptFinalized: true,
    });
  });
});
