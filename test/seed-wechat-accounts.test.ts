// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Functional tests for scripts/seed-wechat-accounts.py.
// Runs the actual Python script with controlled env vars + a temp HOME and
// asserts on the on-disk state it leaves behind. Mirrors the spawn-and-read
// pattern from generate-openclaw-config.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT_PATH = path.join(import.meta.dirname, "..", "scripts", "seed-wechat-accounts.py");

const PLACEHOLDER = "openshell:resolve:env:WECHAT_BOT_TOKEN";

let tmpDir: string;

function configB64(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function channelsB64(channels: string[]): string {
  return Buffer.from(JSON.stringify(channels)).toString("base64");
}

function runSeed(envOverrides: Record<string, string> = {}) {
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: tmpDir,
    // Default to wechat-in-active-channels so existing tests exercise the
    // openclaw.json-patching path. Tests that simulate `channels stop wechat`
    // override this with `channelsB64([])` (or any list excluding wechat).
    NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["wechat"]),
    ...envOverrides,
  };
  return spawnSync("python3", [SCRIPT_PATH], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    env,
    timeout: 10_000,
  });
}

function writeOpenclawConfig(extra: Record<string, unknown> = {}) {
  const cfgDir = path.join(tmpDir, ".openclaw");
  fs.mkdirSync(cfgDir, { recursive: true });
  const cfgPath = path.join(cfgDir, "openclaw.json");
  const baseCfg = { gateway: { port: 1 }, channels: {}, ...extra };
  fs.writeFileSync(cfgPath, JSON.stringify(baseCfg, null, 2) + "\n");
  return cfgPath;
}

function readJson(p: string): any {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-seed-wechat-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("seed-wechat-accounts.py: gating", () => {
  it("no-ops silently when NEMOCLAW_WECHAT_CONFIG_B64 is unset", () => {
    // The script now runs unconditionally from generate-openclaw-config.py
    // on every build, so the "no host-side QR login was performed" path is
    // the common case and must stay quiet — no stderr noise, no on-disk
    // state under the plugin state dir.
    const result = runSeed();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const pluginDir = path.join(tmpDir, ".openclaw", "openclaw-weixin");
    expect(fs.existsSync(pluginDir)).toBe(false);
  });

  it("no-ops silently when accountId is missing from the config payload", () => {
    // baseUrl + userId without accountId would leave the upstream plugin
    // unable to pick a filename. Bail without writing — quietly, since this
    // is reachable in non-WeChat onboards too.
    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ baseUrl: "https://x", userId: "u" }),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const pluginDir = path.join(tmpDir, ".openclaw", "openclaw-weixin");
    expect(fs.existsSync(pluginDir)).toBe(false);
  });
});

describe("seed-wechat-accounts.py: per-account state files", () => {
  it("writes accounts.json index and per-account file with placeholder token", () => {
    writeOpenclawConfig();
    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({
        accountId: "primary",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "user-42",
      }),
    });
    expect(result.status).toBe(0);

    const pluginDir = path.join(tmpDir, ".openclaw", "openclaw-weixin");
    const index = readJson(path.join(pluginDir, "accounts.json"));
    expect(index).toEqual(["primary"]);

    const account = readJson(path.join(pluginDir, "accounts", "primary.json"));
    expect(account.token).toBe(PLACEHOLDER);
    expect(account.baseUrl).toBe("https://ilinkai.wechat.com");
    expect(account.userId).toBe("user-42");
    // savedAt must be a parseable ISO timestamp (the upstream plugin reads it).
    expect(Number.isNaN(Date.parse(account.savedAt))).toBe(false);
  });

  it("omits baseUrl and userId when they are absent in the config", () => {
    writeOpenclawConfig();
    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });
    expect(result.status).toBe(0);

    const account = readJson(
      path.join(tmpDir, ".openclaw", "openclaw-weixin", "accounts", "primary.json"),
    );
    expect(account.token).toBe(PLACEHOLDER);
    expect("baseUrl" in account).toBe(false);
    expect("userId" in account).toBe(false);
  });

  it("appends to an existing accounts.json instead of overwriting", () => {
    // Append-only invariant: a prior seed (or upstream-plugin save) must not
    // be clobbered when a second accountId is registered.
    writeOpenclawConfig();
    const pluginDir = path.join(tmpDir, ".openclaw", "openclaw-weixin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "accounts.json"), JSON.stringify(["old"]) + "\n");

    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "new-one" }),
    });
    expect(result.status).toBe(0);

    const index = readJson(path.join(pluginDir, "accounts.json"));
    expect(index).toEqual(["old", "new-one"]);
  });

  it("does not duplicate an accountId already present in the index", () => {
    writeOpenclawConfig();
    const pluginDir = path.join(tmpDir, ".openclaw", "openclaw-weixin");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "accounts.json"), JSON.stringify(["primary"]) + "\n");

    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });
    expect(result.status).toBe(0);

    const index = readJson(path.join(pluginDir, "accounts.json"));
    expect(index).toEqual(["primary"]);
  });

  it("respects OPENCLAW_STATE_DIR as the state-dir override", () => {
    const altState = path.join(tmpDir, "alt-state");
    fs.mkdirSync(altState, { recursive: true });
    fs.writeFileSync(
      path.join(altState, "openclaw.json"),
      JSON.stringify({ channels: {} }, null, 2) + "\n",
    );

    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
      OPENCLAW_STATE_DIR: altState,
    });
    expect(result.status).toBe(0);

    expect(fs.existsSync(path.join(altState, "openclaw-weixin", "accounts.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, ".openclaw", "openclaw-weixin"))).toBe(false);
  });
});

describe("seed-wechat-accounts.py: openclaw.json patching (channels.openclaw-weixin)", () => {
  it("registers channels.openclaw-weixin.accounts.<id>.enabled=true", () => {
    // Without enabled=true the upstream plugin's auth/accounts.ts treats the
    // account as disabled and the bridge no-ops. This is the load-bearing
    // bit of the post-install patch.
    writeOpenclawConfig();
    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });
    expect(result.status).toBe(0);

    const cfg = readJson(path.join(tmpDir, ".openclaw", "openclaw.json"));
    expect(cfg.channels["openclaw-weixin"].accounts.primary.enabled).toBe(true);
  });

  it("writes a channelConfigUpdatedAt in JS Date.toISOString() shape (ms + 'Z')", () => {
    // The upstream plugin compares this string with values it produces via
    // Date.toISOString(). A Python isoformat() with offset would diverge.
    writeOpenclawConfig();
    runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });

    const cfg = readJson(path.join(tmpDir, ".openclaw", "openclaw.json"));
    const updatedAt = cfg.channels["openclaw-weixin"].channelConfigUpdatedAt;
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("preserves existing unrelated keys in openclaw.json", () => {
    // The patch must merge into the existing config — clobbering gateway or
    // other channels would break everything else generate-openclaw-config.py
    // wrote moments earlier.
    writeOpenclawConfig({
      gateway: { port: 9999, marker: "keep-me" },
      channels: { telegram: { accounts: { default: { enabled: true } } } },
    });
    runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });

    const cfg = readJson(path.join(tmpDir, ".openclaw", "openclaw.json"));
    expect(cfg.gateway).toEqual({ port: 9999, marker: "keep-me" });
    expect(cfg.channels.telegram.accounts.default.enabled).toBe(true);
    expect(cfg.channels["openclaw-weixin"].accounts.primary.enabled).toBe(true);
  });

  it("bails (and warns) when openclaw.json is missing — does not invent a config", () => {
    // generate-openclaw-config.py runs first and is responsible for producing
    // openclaw.json. If it failed silently, we'd rather print a warning than
    // create a half-formed file from this script's narrow vantage point.
    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("not found; cannot register channel");
    expect(fs.existsSync(path.join(tmpDir, ".openclaw", "openclaw.json"))).toBe(false);

    // Per-account state files must still have been written (they sit in the
    // plugin's own state dir, not openclaw.json).
    const pluginDir = path.join(tmpDir, ".openclaw", "openclaw-weixin");
    expect(fs.existsSync(path.join(pluginDir, "accounts.json"))).toBe(true);
  });

  it("survives a corrupted openclaw.json without crashing", () => {
    const cfgPath = path.join(tmpDir, ".openclaw", "openclaw.json");
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    fs.writeFileSync(cfgPath, "{not valid json");
    const result = runSeed({
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("could not parse");
    // Original (broken) file is left intact for a human to inspect.
    expect(fs.readFileSync(cfgPath, "utf-8")).toBe("{not valid json");
  });
});

describe("seed-wechat-accounts.py: stopped-channel preservation", () => {
  // When NEMOCLAW_MESSAGING_CHANNELS_B64 omits wechat (operator ran
  // `channels stop wechat` before rebuild) we still want the per-account
  // state files on disk so a later `channels start wechat` rebuild can
  // revive the bridge without a fresh QR scan. The openclaw.json patch is
  // what we suppress — without channels.openclaw-weixin.accounts.<id>.enabled
  // the upstream plugin treats the account as inactive and the bridge
  // no-ops, even though the placeholder token + baseUrl/userId are present
  // in the accounts file.

  it("writes account state files but skips openclaw.json patch when wechat is not in active channels", () => {
    writeOpenclawConfig({ gateway: { port: 7777 } });
    const result = runSeed({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64(["telegram"]),
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({
        accountId: "primary",
        baseUrl: "https://ilinkai.wechat.com",
        userId: "wxid-42",
      }),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("wechat not in active channels");

    // Per-account files survive — ready for the next `channels start`.
    const account = readJson(
      path.join(tmpDir, ".openclaw", "openclaw-weixin", "accounts", "primary.json"),
    );
    expect(account.token).toBe(PLACEHOLDER);
    expect(account.baseUrl).toBe("https://ilinkai.wechat.com");
    expect(account.userId).toBe("wxid-42");
    const index = readJson(path.join(tmpDir, ".openclaw", "openclaw-weixin", "accounts.json"));
    expect(index).toEqual(["primary"]);

    // openclaw.json must not have the channel block, but the unrelated
    // gateway key the test seeded earlier must survive untouched.
    const cfg = readJson(path.join(tmpDir, ".openclaw", "openclaw.json"));
    expect(cfg.channels?.["openclaw-weixin"]).toBeUndefined();
    expect(cfg.gateway).toEqual({ port: 7777 });
  });

  it("treats an empty channel list as 'wechat stopped'", () => {
    // Defensive: a malformed/empty NEMOCLAW_MESSAGING_CHANNELS_B64 must
    // not silently re-enable wechat. Account state still gets written for
    // recovery, the channel block does not.
    writeOpenclawConfig();
    const result = runSeed({
      NEMOCLAW_MESSAGING_CHANNELS_B64: channelsB64([]),
      NEMOCLAW_WECHAT_CONFIG_B64: configB64({ accountId: "primary" }),
    });
    expect(result.status).toBe(0);

    expect(
      fs.existsSync(path.join(tmpDir, ".openclaw", "openclaw-weixin", "accounts", "primary.json")),
    ).toBe(true);
    const cfg = readJson(path.join(tmpDir, ".openclaw", "openclaw.json"));
    expect(cfg.channels?.["openclaw-weixin"]).toBeUndefined();
  });
});
