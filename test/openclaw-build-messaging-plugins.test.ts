// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for scripts/openclaw-build-messaging-plugins.py.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "openclaw-build-messaging-plugins.py",
);

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function runDryRun(envOverrides: Record<string, string> = {}) {
  return spawnSync("python3", [SCRIPT_PATH, "--dry-run"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      ...envOverrides,
    },
    timeout: 10_000,
  });
}

function parseDryRun(envOverrides: Record<string, string> = {}) {
  const result = runDryRun(envOverrides);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("openclaw-build-messaging-plugins.py", () => {
  it("pins selected external messaging plugins to OPENCLAW_VERSION", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
        "telegram",
        "discord",
        "slack",
        "whatsapp",
      ]),
    });

    expect(payload.installSpecs).toEqual([
      "@openclaw/discord@2026.5.22",
      "@openclaw/slack@2026.5.22",
      "@openclaw/whatsapp@2026.5.22",
    ]);
    expect(payload.doctorEnv).toEqual({
      DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
      SLACK_APP_TOKEN: "xapp-OPENSHELL-RESOLVE-ENV-SLACK_APP_TOKEN",
      SLACK_BOT_TOKEN: "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    });
  });

  it("does not inject placeholder token env vars for unselected channels", () => {
    const payload = parseDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["discord", "discord"]),
    });

    expect(payload.channels).toEqual(["discord"]);
    expect(payload.installSpecs).toEqual(["@openclaw/discord@2026.5.22"]);
    expect(payload.doctorEnv).toEqual({
      DISCORD_BOT_TOKEN: "openshell:resolve:env:DISCORD_BOT_TOKEN",
    });
  });

  it("does not require OPENCLAW_VERSION when no external messaging plugin is selected", () => {
    const payload = parseDryRun({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
    });

    expect(payload.installSpecs).toEqual([]);
    expect(payload.doctorEnv).toEqual({
      TELEGRAM_BOT_TOKEN: "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
    });
  });

  it("fails fast on malformed channel payloads", () => {
    const result = runDryRun({
      OPENCLAW_VERSION: "2026.5.22",
      NEMOCLAW_MESSAGING_CHANNELS_B64: "not-base64-json",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("NEMOCLAW_MESSAGING_CHANNELS_B64");
  });

  it("runs pinned installs before doctor and limits doctor env injection to the doctor command", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-message-plugins-"));
    const tracePath = path.join(tmp, "openclaw.trace");
    const fakeOpenclaw = path.join(tmp, "openclaw");
    fs.writeFileSync(
      fakeOpenclaw,
      [
        "#!/bin/sh",
        "printf '%s|%s|%s|%s|%s|%s|%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" \"${TELEGRAM_BOT_TOKEN:-}\" \"${DISCORD_BOT_TOKEN:-}\" \"${SLACK_BOT_TOKEN:-}\" >> \"$OPENCLAW_TRACE\"",
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("python3", [SCRIPT_PATH], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          PATH: `${tmp}:${process.env.PATH || "/usr/bin:/bin"}`,
          OPENCLAW_TRACE: tracePath,
          OPENCLAW_VERSION: "2026.5.22",
          NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([
            "telegram",
            "discord",
            "slack",
            "whatsapp",
          ]),
        },
        timeout: 10_000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(tracePath, "utf-8").trim().split("\n")).toEqual([
        "plugins|install|@openclaw/discord@2026.5.22||||",
        "plugins|install|@openclaw/slack@2026.5.22||||",
        "plugins|install|@openclaw/whatsapp@2026.5.22||||",
        [
          "doctor",
          "--fix",
          "--non-interactive",
          "",
          "openshell:resolve:env:TELEGRAM_BOT_TOKEN",
          "openshell:resolve:env:DISCORD_BOT_TOKEN",
          "xoxb-OPENSHELL-RESOLVE-ENV-SLACK_BOT_TOKEN",
        ].join("|"),
      ]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
