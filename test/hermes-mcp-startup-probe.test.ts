// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type ProbeResult = { status: number; stdout: string; stderr: string };

function runHermesProbe(results: ProbeResult[]) {
  const script = String.raw`
const globalActions = require("./src/lib/actions/global.js");
const wait = require("./src/lib/core/wait.js");
const results = ${JSON.stringify(results)};
let calls = 0;
globalActions.runOpenshellProviderCommand = () => results[calls++];
wait.waitUntil = (condition) => [0, 1, 2].some(() => condition());
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
let message = "";
try {
  adapters.assertAgentMcpMutationRuntimeCapability("hermes-box", "hermes-config");
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({ calls, message }));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 30_000,
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout) as { calls: number; message: string };
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

describe("Hermes managed MCP startup probe", () => {
  it("retries only the exact transient gateway-starting result", () => {
    expect(runHermesProbe([starting, ready])).toEqual({ calls: 2, message: "" });
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
    expect(result.message).toContain("nemoclaw hermes-box recover");
    expect(result.message).toContain("managed service lifecycle");
  });

  it("fails clearly when the gateway never becomes ready", () => {
    const result = runHermesProbe([starting, starting, starting]);

    expect(result.calls).toBe(3);
    expect(result.message).toContain("after waiting for startup");
    expect(result.message).toContain("nemoclaw hermes-box recover");
    expect(result.message).toContain("Hermes gateway is not running for managed MCP reload");
  });
});
