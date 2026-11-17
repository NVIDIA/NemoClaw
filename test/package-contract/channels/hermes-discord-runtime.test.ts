// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SandboxEntry } from "../../../src/lib/state/registry";

const requireCompiled = createRequire(import.meta.url);
const { showSandboxChannelStatus, exitCodeFor } = requireCompiled(
  path.resolve("dist/lib/actions/sandbox/channel-status.js"),
) as typeof import("../../../src/lib/actions/sandbox/channel-status");

// Run only inside a disposable managed Hermes image with an empty agent home.
const enabled = process.env.NEMOCLAW_HERMES_RUNTIME_TEST === "1";
const runtimeStatus = "/sandbox/.hermes/runtime/gateway_state.json";
const secret = "synthetic-discord-secret-for-redaction";
const nativeWriter = String.raw`
import subprocess, sys
sys.path.insert(0, "/opt/hermes")
from gateway.status import write_runtime_status
write_runtime_status(
    gateway_state="running", platform="discord", platform_state=sys.argv[1],
    error_code="discord_auth_error" if sys.argv[1] == "fatal" else None,
    error_message=sys.argv[2],
)
# Keep the native writer alive while the unchanged CLI probe reads its metadata.
sys.exit(subprocess.run(["sh", "-c", sys.argv[3]], check=False).returncode)
`;

describe.runIf(enabled)("compiled Discord status with the native Hermes writer", () => {
  it("reports rejection, recovery and a dead writer without exposing native errors (#13809)", async () => {
    expect(existsSync(runtimeStatus)).toBe(false);
    const sandbox = {
      name: "alpha",
      agent: "hermes",
      messaging: {
        schemaVersion: 1,
        plan: {
          schemaVersion: 1,
          sandboxName: "alpha",
          agent: "hermes",
          workflow: "onboard",
          channels: [
            {
              channelId: "discord",
              displayName: "Discord",
              authMode: "token-paste",
              active: true,
              selected: true,
              configured: true,
              disabled: false,
              inputs: [],
              hooks: [],
            },
          ],
          disabledChannels: [],
          credentialBindings: [],
          networkPolicy: { presets: [], entries: [] },
          agentRender: [],
          buildSteps: [],
          stateUpdates: [],
          healthChecks: [],
        },
      },
    } as SandboxEntry;
    let nativeState: string | null = "fatal";
    const executions: { status: number | null; stdout: string; stderr: string }[] = [];
    const deps = {
      getSandbox: () => sandbox,
      getAppliedPresets: () => ["discord"],
      getGatewayPresets: () => ["discord"],
      execSandbox: async (_name: string, command: string, timeoutMs?: number) => {
        const isProbe = command.startsWith("/opt/hermes/.venv/bin/python");
        const result =
          nativeState === null || !isProbe
            ? spawnSync("sh", ["-c", command], { encoding: "utf8", timeout: timeoutMs })
            : spawnSync(
                "/opt/hermes/.venv/bin/python",
                ["-c", nativeWriter, nativeState, secret, command],
                {
                  encoding: "utf8",
                  timeout: timeoutMs,
                },
              );
        executions.push({ status: result.status, stdout: result.stdout, stderr: result.stderr });
        return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
      },
    };
    const options = { deps, channel: "discord", asJson: true, quietJson: true };
    try {
      const rejected = await showSandboxChannelStatus("alpha", options);
      expect(existsSync(runtimeStatus)).toBe(true);
      nativeState = "connected";
      const recovered = await showSandboxChannelStatus("alpha", options);
      nativeState = null;
      const deadWriter = await showSandboxChannelStatus("alpha", options);
      expect([rejected, recovered, deadWriter]).toMatchObject([
        { report: { verdict: "credential_rejected" } },
        { report: { verdict: "healthy" } },
        { report: { verdict: "unknown" } },
      ]);
      expect([exitCodeFor(rejected!), exitCodeFor(recovered!), exitCodeFor(deadWriter!)]).toEqual([
        1, 0, 0,
      ]);
      expect(JSON.stringify({ rejected, recovered, deadWriter, executions })).not.toContain(secret);
    } finally {
      rmSync(runtimeStatus, { force: true });
    }
  });
});
