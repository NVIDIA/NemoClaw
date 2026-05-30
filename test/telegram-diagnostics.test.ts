// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Unit tests for nemoclaw-blueprint/scripts/telegram-diagnostics.js.
//
// The diagnostics preload mutates global state on require (process.stderr,
// http.request / https.request); each scenario runs in its own child Node
// process so the wraps cannot leak across cases. We focus on the
// startup-grace breadcrumb added for #4314 / #4390: when Telegram is
// configured but the bridge fails to log "starting provider" and never
// touches the Bot API, the preload must surface a single actionable line
// instead of leaving the channel observably silent.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const DIAGNOSTICS_PATH = path.join(
  import.meta.dirname,
  "..",
  "nemoclaw-blueprint",
  "scripts",
  "telegram-diagnostics.js",
);

function runDriver(driverBody: string, env: Record<string, string> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-telegram-diag-"));
  const driverPath = path.join(tmpDir, "driver.js");
  const configPath = path.join(tmpDir, "openclaw.json");
  fs.writeFileSync(driverPath, driverBody);
  try {
    return {
      result: spawnSync(process.execPath, [driverPath], {
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          DIAGNOSTICS_PATH,
          OPENCLAW_CONFIG_PATH: configPath,
          ...env,
        },
        timeout: 5_000,
      }),
      configPath,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("telegram-diagnostics: startup-grace breadcrumb (#4314, #4390)", () => {
  // The diagnostics preload only fires the startup-grace timer in OpenClaw
  // gateway processes — mirroring sandbox-safety-net's gatewayProcessFlavor
  // check. The driver must set process.title to one of the gateway flavors
  // before requiring the module or the timer is skipped entirely (this is
  // the intended behavior; see the non-gateway test below).
  const GATEWAY_TITLE_SETUP = `process.title = 'openclaw-gateway';\n`;

  it("emits a 'bridge did not start' breadcrumb when Telegram is configured but no provider startup signal arrives", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: { botToken: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" } } } },
      }));
      process.env.TELEGRAM_BOT_TOKEN = "openshell:resolve:env:TELEGRAM_BOT_TOKEN";
      require(process.env.DIAGNOSTICS_PATH);
      setTimeout(() => process.exit(0), 250);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "50" });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/bridge did not start within \d+s/);
  });

  it("does NOT emit the startup-grace breadcrumb after the bridge logs 'starting provider'", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: {} } } },
      }));
      require(process.env.DIAGNOSTICS_PATH);
      // Simulate the bridge announcing itself before the grace window expires.
      process.stderr.write("[telegram] [default] starting provider\\n");
      setTimeout(() => process.exit(0), 250);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "50" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/bridge did not start within/);
  });

  it("does NOT emit the startup-grace breadcrumb when channels.telegram.enabled is false", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: false, accounts: { default: {} } } },
      }));
      require(process.env.DIAGNOSTICS_PATH);
      setTimeout(() => process.exit(0), 250);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "50" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/bridge did not start within/);
  });

  it("stays silent in non-gateway processes that inherit NODE_OPTIONS=--require", () => {
    // The preload is exported into NODE_OPTIONS for every Node child the
    // sandbox spawns. Without the gateway-process gate, every short-lived
    // tool (npm install, doctor, the user's own scripts) would emit a false
    // "bridge did not start" warning. Process.title here stays "node", so
    // the timer must short-circuit before scheduling.
    const driver = `
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: {} } } },
      }));
      require(process.env.DIAGNOSTICS_PATH);
      setTimeout(() => process.exit(0), 250);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "50" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/bridge did not start within/);
  });

  it("logs Telegram DM allowlist state without exposing IDs", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: { dmPolicy: "allowlist", allowFrom: ["8388960805"] } } } },
      }));
      require(process.env.DIAGNOSTICS_PATH);
      setTimeout(() => process.exit(0), 100);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "1000" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("DM allowlist configured (1 entry)");
    expect(result.stderr).not.toContain("8388960805");
  });

  it("logs an actionable warning when Telegram DM allowlist is empty", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: { dmPolicy: "allowlist", allowFrom: [] } } } },
      }));
      require(process.env.DIAGNOSTICS_PATH);
      setTimeout(() => process.exit(0), 100);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "1000" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("DM allowlist is empty; set TELEGRAM_ALLOWED_IDS");
  });

  it("does not warn about an empty allowlist when Telegram is not in allowlist mode", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: {} } } },
      }));
      require(process.env.DIAGNOSTICS_PATH);
      setTimeout(() => process.exit(0), 100);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "1000" });
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("DM allowlist is empty");
  });

  it("logs outbound sendMessage attempts without leaking the bot token", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      const { EventEmitter } = require("events");
      const http = require("http");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: { dmPolicy: "allowlist", allowFrom: ["123"] } } } },
      }));
      http.request = function () {
        const req = new EventEmitter();
        req.end = function () {
          process.nextTick(() => req.emit("response", { statusCode: 200 }));
        };
        return req;
      };
      require(process.env.DIAGNOSTICS_PATH);
      http.request({ hostname: "api.telegram.org", path: "/bot123456:SECRET/sendMessage" }).end();
      setTimeout(() => process.exit(0), 100);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "1000" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("outbound sendMessage attempted; Bot API returned HTTP 200");
    expect(result.stderr).not.toContain("123456:SECRET");
  });

  it("logs inbound getUpdates metadata without exposing Telegram IDs or message text", () => {
    const driver = `
      ${GATEWAY_TITLE_SETUP}
      const fs = require("fs");
      const { EventEmitter } = require("events");
      const http = require("http");
      fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
        channels: { telegram: { enabled: true, accounts: { default: { dmPolicy: "allowlist", allowFrom: ["8388960805"] } } } },
      }));
      http.request = function () {
        const req = new EventEmitter();
        req.end = function () {
          const res = new EventEmitter();
          res.statusCode = 200;
          process.nextTick(() => {
            req.emit("response", res);
            res.emit("data", JSON.stringify({
              ok: true,
              result: [{
                update_id: 111111,
                message: {
                  message_id: 42,
                  from: { id: 8388960805 },
                  chat: { id: 8388960805, type: "private" },
                  text: "hello bot please reply",
                },
              }],
            }));
            res.emit("end");
          });
        };
        return req;
      };
      require(process.env.DIAGNOSTICS_PATH);
      http.request({ hostname: "api.telegram.org", path: "/bot123456:SECRET/getUpdates" }).end();
      setTimeout(() => process.exit(0), 100);
    `;
    const { result } = runDriver(driver, { NEMOCLAW_TELEGRAM_STARTUP_GRACE_MS: "1000" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain(
      "inbound update received (update_id=present; message_id=present; chat_type=private; sender_allowlisted=true)",
    );
    expect(result.stderr).not.toContain("8388960805");
    expect(result.stderr).not.toContain("hello bot please reply");
    expect(result.stderr).not.toContain("123456:SECRET");
  });
});
