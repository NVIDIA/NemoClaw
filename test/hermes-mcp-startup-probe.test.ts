// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type ProbeResult = { status: number; stdout: string; stderr: string };
type SupervisorResult = ProbeResult | null;

function runHermesProbe(
  results: ProbeResult[],
  shieldsDown = true,
  supervisorResults: SupervisorResult[] = [],
) {
  const script = String.raw`
const globalActions = require("./src/lib/actions/global.js");
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const wait = require("./src/lib/core/wait.js");
const shields = require("./src/lib/shields/index.js");
const results = ${JSON.stringify(results)};
const supervisorResults = ${JSON.stringify(supervisorResults)};
let calls = 0;
let recoveryCalls = 0;
const recoveryActions = [];
globalActions.runOpenshellProviderCommand = () => results[calls++];
processRecovery.executeGatewaySupervisorAction = (_sandbox, action, timeout) => {
  recoveryActions.push({ action, timeout });
  return supervisorResults[recoveryCalls++] ?? null;
};
wait.waitUntil = (condition, optionsOrTimeout) => {
  const maxAttempts = typeof optionsOrTimeout === "object"
    ? (optionsOrTimeout.maxAttempts ?? Number.POSITIVE_INFINITY)
    : Number.POSITIVE_INFINITY;
  let attempts = 0;
  while (calls < results.length && attempts < maxAttempts) {
    attempts += 1;
    if (condition()) return true;
  }
  return false;
};
shields.isShieldsDown = () => ${JSON.stringify(shieldsDown)};
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
let message = "";
try {
  adapters.assertAgentMcpMutationRuntimeCapability("hermes-box", "hermes-config");
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({ calls, recoveryActions, message }));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as {
    calls: number;
    recoveryActions: Array<{ action: string; timeout: number }>;
    message: string;
  };
}

const starting: ProbeResult = {
  status: 1,
  stdout: "",
  stderr: "Hermes gateway is not running for managed MCP reload",
};
const ready: ProbeResult = {
  status: 0,
  stdout: '{"ok":true}\n',
  stderr: "",
};
const recovered: SupervisorResult = {
  status: 0,
  stdout: `v1 ${"a".repeat(64)} complete ok 0 4242\nGATEWAY_PID=4242`,
  stderr: "",
};

describe("Hermes managed MCP startup probe", () => {
  it("refuses shields-up config before invoking the sandbox helper", () => {
    const result = runHermesProbe([ready], false);

    expect(result.calls).toBe(0);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("has shields up or an unreadable shields posture");
    expect(result.message).toContain("nemohermes hermes-box shields down");
  });

  it("retries only the exact transient gateway-starting result", () => {
    expect(runHermesProbe([starting, ready])).toEqual({
      calls: 2,
      recoveryActions: [],
      message: "",
    });
  });

  it("does not recover when the third exact startup probe is ready", () => {
    expect(runHermesProbe([starting, starting, ready])).toEqual({
      calls: 3,
      recoveryActions: [],
      message: "",
    });
  });

  it("uses one host-authenticated recovery after repeated exact not-ready probes", () => {
    expect(runHermesProbe([starting, starting, starting, ready], true, [recovered])).toEqual({
      calls: 4,
      recoveryActions: [{ action: "recover", timeout: 210_000 }],
      message: "",
    });
  });

  it("keeps the fresh helper wait when privileged recovery is unavailable", () => {
    expect(runHermesProbe([starting, starting, starting, ready])).toEqual({
      calls: 4,
      recoveryActions: [{ action: "recover", timeout: 210_000 }],
      message: "",
    });
  });

  it("does not treat controller success as transaction-helper readiness", () => {
    const result = runHermesProbe([starting, starting, starting, starting, starting], true, [
      recovered,
    ]);

    expect(result.calls).toBe(5);
    expect(result.recoveryActions).toEqual([{ action: "recover", timeout: 210_000 }]);
    expect(result.message).toContain("after managed gateway recovery");
  });

  it.each([
    "GATEWAY_CONFIG_HASH_MISMATCH",
    "SUPERVISOR_REBUILD_REQUIRED",
    "SUPERVISOR_UNSAFE_CONTROL_DIR",
    "SUPERVISOR_INVALID_STATUS",
    "GATEWAY_HEALTH_TIMEOUT",
    "SUPERVISOR_TIMEOUT",
    "SUPERVISOR_BUSY",
  ])("fails typed managed-recovery integrity refusal %s without another sandbox probe", (marker) => {
    const result = runHermesProbe([starting, starting, starting, ready], true, [
      { status: 1, stdout: "", stderr: marker },
    ]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([{ action: "recover", timeout: 210_000 }]);
    expect(result.message).toContain("managed gateway recovery failed before MCP mutation");
    expect(result.message).toContain(marker);
  });

  it.each([
    {
      label: "non-numeric PID",
      result: { status: 0, stdout: "GATEWAY_PID=garbage", stderr: "" },
    },
    {
      label: "failure output beside a completion",
      result: { ...recovered!, stderr: "SUPERVISOR_UNSAFE_CONTROL_DIR" },
    },
    {
      label: "failure status beside a completion",
      result: { ...recovered!, status: 1 },
    },
    {
      label: "partial completion protocol",
      result: {
        status: 1,
        stdout: `v1 ${"a".repeat(64)} complete ok 0 4242`,
        stderr: "",
      },
    },
  ])("rejects invalid controller response: $label", ({ result: invalidResult }) => {
    const result = runHermesProbe([starting, starting, starting, ready], true, [invalidResult]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([{ action: "recover", timeout: 210_000 }]);
    expect(result.message).toContain("managed gateway recovery failed before MCP mutation");
  });

  it("fails immediately on trust and topology errors", () => {
    const result = runHermesProbe([
      {
        status: 1,
        stdout: "",
        stderr: "Hermes gateway PID does not identify the trusted launcher",
      },
      ready,
    ]);

    expect(result.calls).toBe(1);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("does not identify the trusted launcher");
    expect(result.message).not.toContain("nemoclaw hermes-box recover");
  });

  it("directs an unmanaged but trusted gateway to recovery before mutation", () => {
    const result = runHermesProbe([
      {
        status: 1,
        stdout: "",
        stderr: "Hermes gateway is not running under the managed service lifecycle",
      },
      ready,
    ]);

    expect(result.calls).toBe(1);
    expect(result.recoveryActions).toEqual([]);
    expect(result.message).toContain("nemoclaw hermes-box recover");
    expect(result.message).toContain("managed service lifecycle");
  });

  it("fails clearly when the gateway never becomes ready", () => {
    const result = runHermesProbe([starting, starting, starting]);

    expect(result.calls).toBe(3);
    expect(result.recoveryActions).toEqual([{ action: "recover", timeout: 210_000 }]);
    expect(result.message).toContain("after managed gateway recovery");
    expect(result.message).toContain("no controller result");
  });
});
