// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const TELEGRAM_RUNTIME_PRELOAD = path.join(
  import.meta.dirname,
  "..",
  "src/lib/messaging/channels/telegram/runtime/telegram-diagnostics.ts",
);

function messagingRuntimeSetupSection(
  src: string,
  options: {
    planPath: string;
    connectPreloadsPath: string;
    sourcePrefix: string;
    targetPrefix: string;
  },
): string {
  const start = src.indexOf("# ── Messaging runtime setup from manifest metadata");
  const end = src.indexOf("_read_gateway_token()", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start, end)
    .replace(
      '_MESSAGING_RUNTIME_SETUP_PLAN="/tmp/nemoclaw-messaging-runtime-setup.json"',
      `_MESSAGING_RUNTIME_SETUP_PLAN=${JSON.stringify(options.planPath)}`,
    )
    .replace(
      '_MESSAGING_CONNECT_PRELOADS_FILE="/tmp/nemoclaw-messaging-connect-preloads.list"',
      `_MESSAGING_CONNECT_PRELOADS_FILE=${JSON.stringify(options.connectPreloadsPath)}`,
    )
    .replaceAll("/tmp/nemoclaw-messaging-connect-preloads.list", options.connectPreloadsPath)
    .replace(
      'PRELOAD_SOURCE_PREFIX = "/usr/local/lib/nemoclaw/preloads/"',
      `PRELOAD_SOURCE_PREFIX = ${JSON.stringify(options.sourcePrefix)}`,
    )
    .replace(
      'PRELOAD_TARGET_PREFIX = "/tmp/nemoclaw-"',
      `PRELOAD_TARGET_PREFIX = ${JSON.stringify(options.targetPrefix)}`,
    );
}

function encodeRuntimeSetupPlan(
  channelId: string,
  runtimeSetup: Record<string, unknown>,
  options: { active?: boolean } = {},
): string {
  const active = options.active ?? true;
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
          active,
          selected: true,
          configured: true,
          disabled: !active,
          inputs: [],
          hooks: [],
        },
      ],
      disabledChannels: active ? [] : [channelId],
      credentialBindings: [],
      networkPolicy: { presets: [], entries: [] },
      agentRender: [],
      buildSteps: [],
      runtimeSetup: {
        nodePreloads: withChannelId(runtimeSetup.nodePreloads),
        envAliases: withChannelId(runtimeSetup.envAliases),
        secretScans: withChannelId(runtimeSetup.secretScans),
      },
      stateUpdates: [],
      healthChecks: [],
    }),
  ).toString("base64");
}

describe("Telegram runtime preload installation", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");

  it("installs Telegram diagnostics only when Telegram is configured", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-install-"));
    const sourcePrefix = path.join(tmpDir, "preloads") + path.sep;
    const sourcePath = path.join(sourcePrefix, "telegram-diagnostics.js");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const connectPreloadsPath = path.join(tmpDir, "connect-preloads.list");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(sourcePrefix, { recursive: true });
    fs.copyFileSync(TELEGRAM_RUNTIME_PRELOAD, sourcePath);
    const runtimeSetup = {
      nodePreloads: [
        {
          source: sourcePath,
          target: preloadPath,
          injectInto: ["boot", "connect"],
          optional: false,
          installMessage:
            "[channels] Installing Telegram diagnostics (provider readiness + inference errors)",
          installedMessage: "[channels] Telegram diagnostics installed (NODE_OPTIONS updated)",
        },
      ],
    };
    const run = (active: boolean) => {
      fs.rmSync(preloadPath, { force: true });
      fs.rmSync(planPath, { force: true });
      fs.rmSync(connectPreloadsPath, { force: true });
      fs.writeFileSync(
        scriptPath,
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
          'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
          "NODE_OPTIONS='--require /already-loaded.js'",
          `export NEMOCLAW_MESSAGING_PLAN_B64=${JSON.stringify(encodeRuntimeSetupPlan("telegram", runtimeSetup, { active }))}`,
          messagingRuntimeSetupSection(src, {
            planPath,
            connectPreloadsPath,
            sourcePrefix,
            targetPrefix: tmpDir + path.sep,
          }),
          "write_messaging_runtime_setup_plan",
          "install_messaging_runtime_preloads",
          'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
        ].join("\n"),
        { mode: 0o700 },
      );
      return spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
    };

    try {
      const noTelegram = run(false);
      expect(noTelegram.status).toBe(0);
      expect(fs.existsSync(preloadPath)).toBe(false);
      expect(noTelegram.stdout).toContain("NODE_OPTIONS=--require /already-loaded.js");
      expect(noTelegram.stdout).not.toContain(preloadPath);

      const withTelegram = run(true);
      expect(withTelegram.status).toBe(0);
      expect(fs.existsSync(preloadPath)).toBe(true);
      expect((fs.statSync(preloadPath).mode & 0o777).toString(8)).toBe("444");
      expect(withTelegram.stdout).toContain("--require /already-loaded.js");
      expect(withTelegram.stdout).toContain(`--require ${preloadPath}`);
      expect(withTelegram.stderr).toContain("Telegram diagnostics installed");
      expect(fs.readFileSync(connectPreloadsPath, "utf-8")).toContain(preloadPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("loads Telegram diagnostics from the baked runtime artifact when env plan is absent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-artifact-"));
    const sourcePrefix = path.join(tmpDir, "preloads") + path.sep;
    const sourcePath = path.join(sourcePrefix, "telegram-diagnostics.js");
    const preloadPath = path.join(tmpDir, "telegram-diagnostics.js");
    const planPath = path.join(tmpDir, "runtime-plan.json");
    const artifactPath = path.join(tmpDir, "messaging-runtime-plan.json");
    const connectPreloadsPath = path.join(tmpDir, "connect-preloads.list");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.mkdirSync(sourcePrefix, { recursive: true });
    fs.copyFileSync(TELEGRAM_RUNTIME_PRELOAD, sourcePath);
    const runtimeSetup = {
      nodePreloads: [
        {
          source: sourcePath,
          target: preloadPath,
          injectInto: ["boot", "connect"],
          optional: false,
          installedMessage: "[channels] Telegram diagnostics installed from artifact",
        },
      ],
    };
    fs.writeFileSync(
      artifactPath,
      Buffer.from(encodeRuntimeSetupPlan("telegram", runtimeSetup), "base64").toString("utf-8"),
    );
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'id() { if [ "${1:-}" = "-u" ]; then printf "1000"; else command id "$@"; fi; }',
        'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; chmod 444 "$target"; }',
        "NODE_OPTIONS='--require /already-loaded.js'",
        `export NEMOCLAW_MESSAGING_RUNTIME_PLAN_PATH=${JSON.stringify(artifactPath)}`,
        "unset NEMOCLAW_MESSAGING_PLAN_B64 || true",
        messagingRuntimeSetupSection(src, {
          planPath,
          connectPreloadsPath,
          sourcePrefix,
          targetPrefix: tmpDir + path.sep,
        }),
        "write_messaging_runtime_setup_plan",
        "install_messaging_runtime_preloads",
        'printf "NODE_OPTIONS=%s\\n" "$NODE_OPTIONS"',
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(preloadPath)).toBe(true);
      expect(result.stdout).toContain("--require /already-loaded.js");
      expect(result.stdout).toContain(`--require ${preloadPath}`);
      expect(result.stderr).toContain("Telegram diagnostics installed from artifact");
      expect(fs.readFileSync(connectPreloadsPath, "utf-8")).toContain(preloadPath);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
