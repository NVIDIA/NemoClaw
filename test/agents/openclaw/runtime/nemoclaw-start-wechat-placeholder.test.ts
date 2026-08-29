// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const START_SCRIPT = path.join(import.meta.dirname, "../../../..", "scripts/nemoclaw-start.sh");
const CANONICAL = "openshell:resolve:env:WECHAT_BOT_TOKEN";
const SAVED_AT = "2026-08-29T00:00:00.000Z";
const src = fs.readFileSync(START_SCRIPT, "utf-8");

interface WechatRefreshFixture {
  readonly account: Record<string, unknown>;
  readonly result: ReturnType<typeof spawnSync>;
}

function wechatConfig(enabled: boolean): Record<string, unknown> {
  return {
    channels: {
      "openclaw-weixin": {
        enabled,
        accounts: { primary: { enabled: true } },
      },
    },
  };
}

function runWechatRefresh(
  accountToken: string,
  env: Record<string, string>,
  enabled = true,
  mutateAccount?: (paths: { accountPath: string; tmpDir: string }) => void,
): WechatRefreshFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-placeholder-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  const accountPath = path.join(openclawDir, "openclaw-weixin", "accounts", "primary.json");
  const configPath = path.join(openclawDir, "openclaw.json");
  const scriptPath = path.join(tmpDir, "run.sh");
  fs.mkdirSync(path.dirname(accountPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(wechatConfig(enabled), null, 2)}\n`);
  fs.writeFileSync(
    accountPath,
    `${JSON.stringify({ token: accountToken, savedAt: SAVED_AT }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(accountPath, 0o600);
  mutateAccount?.({ accountPath, tmpDir });
  const refresh = extractShellFunctionFromSource(
    src,
    "refresh_openclaw_provider_placeholders",
  ).replaceAll("/sandbox/.openclaw", openclawDir);
  fs.writeFileSync(
    scriptPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "openclaw_config_dir_owner() { printf 'sandbox'; }",
      "prepare_openclaw_config_for_write() { :; }",
      "restore_openclaw_config_after_write() { :; }",
      refresh,
      "refresh_openclaw_provider_placeholders",
    ].join("\n"),
    { mode: 0o700 },
  );

  try {
    const result = spawnSync("bash", [scriptPath], {
      encoding: "utf-8",
      env: { PATH: process.env.PATH || "", ...env },
      timeout: 5000,
    });
    const account = JSON.parse(fs.readFileSync(accountPath, "utf-8"));
    return { account, result };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("OpenClaw WeChat provider placeholder refresh (#10079)", () => {
  it("writes the exact revision-scoped placeholder without logging it", () => {
    const scoped = "openshell:resolve:env:v42_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(CANONICAL, { WECHAT_BOT_TOKEN: scoped });

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
    expect(run.result.stderr).toContain(
      "Refreshed WeChat account provider placeholder from OpenShell runtime env: WECHAT_BOT_TOKEN",
    );
    expect(run.result.stderr).not.toContain(scoped);
  });

  it("refreshes a stale placeholder generation after provider rotation", () => {
    const scoped = "openshell:resolve:env:v51_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh("openshell:resolve:env:v42_WECHAT_BOT_TOKEN", {
      WECHAT_BOT_TOKEN: scoped,
    });

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
  });

  it.each([
    ["missing", {}],
    ["raw", { WECHAT_BOT_TOKEN: "wechat-raw-token-must-not-persist" }],
    ["wrong-key", { WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_OTHER_TOKEN" }],
    ["canonical", { WECHAT_BOT_TOKEN: CANONICAL }],
  ])("fails closed for a %s runtime credential", (_name, env) => {
    const run = runWechatRefresh(CANONICAL, env);

    expect(run.result.status).toBe(1);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.result.stderr).toContain("Refusing WeChat provider placeholder refresh");
    expect(run.result.stderr).not.toContain("wechat-raw-token-must-not-persist");
  });

  it("fails closed without logging or replacing a raw account token", () => {
    const rawToken = "wechat-account-raw-token-must-not-egress";
    const run = runWechatRefresh(rawToken, {
      WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_WECHAT_BOT_TOKEN",
    });

    expect(run.result.status).toBe(1);
    expect(run.account.token).toBe(rawToken);
    expect(run.result.stderr).toContain("neither canonical nor revision-scoped");
    expect(run.result.stderr).not.toContain(rawToken);
  });

  it("leaves the account untouched while the channel is stopped", () => {
    const run = runWechatRefresh(CANONICAL, {}, false);

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.result.stderr).not.toContain("Refusing WeChat provider placeholder refresh");
  });

  it.each([
    [
      "symlinked",
      ({ accountPath, tmpDir }: { accountPath: string; tmpDir: string }) => {
        const targetPath = path.join(tmpDir, "outside.json");
        fs.writeFileSync(targetPath, JSON.stringify({ token: CANONICAL }), { mode: 0o600 });
        fs.unlinkSync(accountPath);
        fs.symlinkSync(targetPath, accountPath);
      },
      "managed account file is missing or unsafe",
    ],
    [
      "hard-linked",
      ({ accountPath, tmpDir }: { accountPath: string; tmpDir: string }) => {
        const targetPath = path.join(tmpDir, "outside.json");
        fs.writeFileSync(targetPath, JSON.stringify({ token: CANONICAL }), { mode: 0o600 });
        fs.unlinkSync(accountPath);
        fs.linkSync(targetPath, accountPath);
      },
      "managed account file is not a single regular file",
    ],
    [
      "group-readable",
      ({ accountPath }: { accountPath: string }) => fs.chmodSync(accountPath, 0o640),
      "managed account file is accessible outside its owner",
    ],
  ])("refuses a %s account file without replacing its token", (_name, mutate, message) => {
    const run = runWechatRefresh(
      CANONICAL,
      { WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_WECHAT_BOT_TOKEN" },
      true,
      mutate,
    );

    expect(run.result.status).toBe(1);
    expect(run.result.stderr).toContain(message);
    expect(run.account.token).toBe(CANONICAL);
  });
});
