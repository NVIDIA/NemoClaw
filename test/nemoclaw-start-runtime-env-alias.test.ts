// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");

function messagingRuntimeSetupSection(src: string, planPath: string): string {
  const start = src.indexOf("# ── Messaging runtime setup from manifest metadata");
  const end = src.indexOf("_read_gateway_token()", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(
      '_MESSAGING_RUNTIME_SETUP_PLAN="/tmp/nemoclaw-messaging-runtime-setup.json"',
      `_MESSAGING_RUNTIME_SETUP_PLAN=${JSON.stringify(planPath)}`,
    );
}

function encodeRuntimeSetupPlan(channelId: string, value: Record<string, unknown>): string {
  const withChannelId = (entries: unknown) =>
    Array.isArray(entries)
      ? entries.map((entry) => ({ channelId, ...(entry as Record<string, unknown>) }))
      : [];
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      sandboxName: "test-sandbox",
      agent: "openclaw",
      workflow: "rebuild",
      channels: [
        {
          channelId,
          displayName: channelId,
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
      runtimeSetup: {
        nodePreloads: withChannelId(value.nodePreloads),
        envAliases: withChannelId(value.envAliases),
        secretScans: withChannelId(value.secretScans),
      },
      stateUpdates: [],
      healthChecks: [],
    }),
  ).toString("base64");
}

describe("messaging runtime env aliases", () => {
  it("uses Python regex semantics consistently when applying aliases", () => {
    const src = fs.readFileSync(START_SCRIPT, "utf-8");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-env-alias-"));
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const scriptPath = path.join(tmpDir, "run.sh");
    const runtimeValue = {
      envAliases: [
        {
          envKey: "SLACK_BOT_TOKEN",
          match: "(?<=openshell:)resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
          value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
          message: "[channels] normalized Slack alias",
        },
      ],
    };
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        `export NEMOCLAW_MESSAGING_PLAN_B64=${JSON.stringify(encodeRuntimeSetupPlan("slack", runtimeValue))}`,
        messagingRuntimeSetupSection(src, planPath),
        "write_messaging_runtime_setup_plan",
        "apply_messaging_runtime_env_aliases",
        'printf "SLACK_BOT_TOKEN=%s\\n" "$SLACK_BOT_TOKEN"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], {
        encoding: "utf-8",
        env: {
          ...process.env,
          SLACK_BOT_TOKEN: "openshell:resolve:env:v42_SLACK_BOT_TOKEN",
        },
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("SLACK_BOT_TOKEN=xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
      expect(result.stderr).toContain("[channels] normalized Slack alias");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
