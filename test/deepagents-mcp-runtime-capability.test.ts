// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

type ProbeResult = { status: number; stdout: string; stderr: string } | null;

function runDeepAgentsProbe(result: ProbeResult) {
  const script = String.raw`
const processRecovery = require("./src/lib/actions/sandbox/process-recovery.js");
const calls = [];
processRecovery.executeSandboxCommand = (sandboxName, command) => {
  calls.push({ sandboxName, command });
  return ${JSON.stringify(result)};
};
const adapters = require("./src/lib/actions/sandbox/mcp-bridge-adapters.js");
let message = "";
try {
  adapters.assertAgentMcpMutationRuntimeCapability("deepagents-box", "deepagents-config");
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
process.stdout.write(JSON.stringify({ calls, message }));
`;
  const child = spawnSync(process.execPath, ["-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
  });
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
  return JSON.parse(child.stdout) as {
    calls: Array<{ sandboxName: string; command: string }>;
    message: string;
  };
}

describe("Deep Agents managed MCP runtime capability", () => {
  it("accepts only the exact managed launcher capability marker", () => {
    expect(
      runDeepAgentsProbe({
        status: 0,
        stdout: "NEMOCLAW_DEEPAGENTS_MCP_CAPABILITY=1\n",
        stderr: "",
      }),
    ).toEqual({
      calls: [
        {
          sandboxName: "deepagents-box",
          command: "/usr/local/bin/deepagents-code --nemoclaw-mcp-capability",
        },
      ],
      message: "",
    });
  });

  it("requires a rebuild before MCP side effects on stale or unreachable images", () => {
    for (const result of [
      null,
      { status: 2, stdout: "", stderr: "unknown option" },
      { status: 0, stdout: "deepagents-code 0.1.12\n", stderr: "" },
    ]) {
      const probe = runDeepAgentsProbe(result);
      expect(probe.calls).toHaveLength(1);
      expect(probe.message).toMatch(/does not contain the managed MCP-aware launcher/i);
      expect(probe.message).toMatch(/rebuild the sandbox before changing authenticated MCP state/i);
      expect(probe.message).not.toContain("unknown option");
    }
  });
});
