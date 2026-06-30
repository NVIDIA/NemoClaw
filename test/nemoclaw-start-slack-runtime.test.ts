// @ts-nocheck
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

describe("Slack runtime env normalization (#4274)", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  function runNormalize(env: Record<string, string | undefined> = {}): {
    bot: string;
    app: string;
    result: ReturnType<typeof spawnSync>;
  } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-slack-runtime-env-"));
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const scriptPath = path.join(tmpDir, "run.sh");
    const runtimeValue = {
      envAliases: [
        {
          envKey: "SLACK_BOT_TOKEN",
          match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_BOT_TOKEN$",
          value: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
          message:
            "[channels] Normalized SLACK_BOT_TOKEN runtime placeholder to the Bolt-compatible alias",
        },
        {
          envKey: "SLACK_APP_TOKEN",
          match: "^openshell:resolve:env:(v[0-9]+_)?SLACK_APP_TOKEN$",
          value: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
          message:
            "[channels] Normalized SLACK_APP_TOKEN runtime placeholder to the Bolt-compatible alias",
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
        'printf "BOT=%s\\n" "${SLACK_BOT_TOKEN-__UNSET__}"',
        'printf "APP=%s\\n" "${SLACK_APP_TOKEN-__UNSET__}"',
      ].join("\n"),
      { mode: 0o700 },
    );

    const childEnv: Record<string, string> = { PATH: process.env.PATH || "" };
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined) childEnv[key] = value;
    }
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: childEnv,
      timeout: 5000,
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    const bot = (result.stdout.match(/^BOT=(.*)$/m)?.[1] ?? "").trimEnd();
    const app = (result.stdout.match(/^APP=(.*)$/m)?.[1] ?? "").trimEnd();
    return { bot, app, result };
  }

  it("normalizes revision-scoped Slack placeholders to Bolt-compatible aliases", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "openshell:resolve:env:v51_SLACK_BOT_TOKEN",
      SLACK_APP_TOKEN: "openshell:resolve:env:v51_SLACK_APP_TOKEN",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
    expect(run.app).toBe("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");
  });

  it("does not leak the revision suffix into the normalized env or logs", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "openshell:resolve:env:v51_SLACK_BOT_TOKEN",
      SLACK_APP_TOKEN: "openshell:resolve:env:v51_SLACK_APP_TOKEN",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).not.toContain("v51_");
    expect(run.app).not.toContain("v51_");
    expect(run.result.stderr).not.toContain("v51_");
    expect(run.bot).not.toContain("openshell:resolve:env:");
    expect(run.app).not.toContain("openshell:resolve:env:");
  });

  it("normalizes the canonical non-revision placeholder too", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "openshell:resolve:env:SLACK_BOT_TOKEN",
      SLACK_APP_TOKEN: "openshell:resolve:env:SLACK_APP_TOKEN",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
    expect(run.app).toBe("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");
  });

  it("leaves already-aliased Slack tokens unchanged", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      SLACK_APP_TOKEN: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN");
    expect(run.app).toBe("xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN");
  });

  it("leaves real Slack tokens untouched", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "xoxb-123-real-bot-token",
      SLACK_APP_TOKEN: "xapp-1-real-app-token",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("xoxb-123-real-bot-token");
    expect(run.app).toBe("xapp-1-real-app-token");
  });

  it("does not create Slack env vars that were never set", () => {
    const run = runNormalize();

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("__UNSET__");
    expect(run.app).toBe("__UNSET__");
  });

  it("leaves a placeholder that resolves a different key untouched", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "openshell:resolve:env:v51_SOME_OTHER_KEY",
      SLACK_APP_TOKEN: "openshell:resolve:env:v51_SOME_OTHER_KEY",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("openshell:resolve:env:v51_SOME_OTHER_KEY");
    expect(run.app).toBe("openshell:resolve:env:v51_SOME_OTHER_KEY");
  });

  it("leaves a suffix-collision key untouched", () => {
    const run = runNormalize({
      SLACK_BOT_TOKEN: "openshell:resolve:env:v51_NOT_SLACK_BOT_TOKEN",
      SLACK_APP_TOKEN: "openshell:resolve:env:MY_SLACK_APP_TOKEN",
    });

    expect(run.result.status, run.result.stderr).toBe(0);
    expect(run.bot).toBe("openshell:resolve:env:v51_NOT_SLACK_BOT_TOKEN");
    expect(run.app).toBe("openshell:resolve:env:MY_SLACK_APP_TOKEN");
  });
});
