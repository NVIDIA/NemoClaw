// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REFRESH_HELPER = path.join(
  import.meta.dirname,
  "../../../..",
  "scripts/lib/refresh-openclaw-wechat-placeholder.py",
);
const MUTABLE_CONFIG_NORMALIZER = path.join(
  import.meta.dirname,
  "../../../..",
  "scripts/lib/normalize_mutable_config_perms.py",
);
const CANONICAL = "openshell:resolve:env:WECHAT_BOT_TOKEN";
const SAVED_AT = "2026-08-29T00:00:00.000Z";

interface WechatRefreshFixture {
  readonly account: Record<string, unknown>;
  readonly accountFiles: readonly string[];
  readonly accountMode: number;
  readonly config: OpenClawTestConfig;
  readonly result: ReturnType<typeof spawnSync>;
}

interface OpenClawTestConfig {
  readonly channels: Record<string, unknown> & {
    telegram?: {
      accounts: { default: { botToken: string } };
    };
  };
}

interface MultiAccountFailureFixture {
  readonly accountFiles: readonly string[];
  readonly primaryAfter: string;
  readonly primaryBefore: string;
  readonly result: ReturnType<typeof spawnSync>;
  readonly secondaryAfter: string;
  readonly secondaryBefore: string;
}

function wechatConfig(
  enabled: boolean | null,
  accountEnabled: boolean | null = true,
): Record<string, unknown> {
  return {
    channels: {
      "openclaw-weixin": {
        ...(enabled === null ? {} : { enabled }),
        accounts: {
          primary:
            accountEnabled === null ? {} : { enabled: enabled === false ? false : accountEnabled },
        },
      },
    },
  };
}

function runWechatRefresh(
  accountToken: string,
  env: Record<string, string>,
  enabled: boolean | null = true,
  mutateAccount?: (paths: { accountPath: string; configPath: string; tmpDir: string }) => void,
  accountEnabled: boolean | null = true,
  faultMode: "replace-and-unlink" | null = null,
): WechatRefreshFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-placeholder-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  const accountPath = path.join(openclawDir, "openclaw-weixin", "accounts", "primary.json");
  const configPath = path.join(openclawDir, "openclaw.json");
  fs.mkdirSync(path.dirname(accountPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(wechatConfig(enabled, accountEnabled), null, 2)}\n`,
  );
  fs.writeFileSync(
    accountPath,
    `${JSON.stringify({ token: accountToken, savedAt: SAVED_AT }, null, 2)}\n`,
    { mode: 0o600 },
  );
  fs.chmodSync(accountPath, 0o600);
  mutateAccount?.({ accountPath, configPath, tmpDir });

  try {
    const pythonArgs =
      faultMode === "replace-and-unlink"
        ? [
            "-I",
            "-c",
            [
              "import os, runpy, sys",
              "def fail_replace(*_args, **_kwargs):",
              "    raise OSError('forced refresh failure')",
              "def fail_unlink(*_args, **_kwargs):",
              "    raise OSError('forced temporary cleanup failure')",
              "os.replace = fail_replace",
              "os.unlink = fail_unlink",
              `sys.argv = [${JSON.stringify(REFRESH_HELPER)}, ${JSON.stringify(configPath)}]`,
              `runpy.run_path(${JSON.stringify(REFRESH_HELPER)}, run_name="__main__")`,
            ].join("\n"),
          ]
        : ["-I", REFRESH_HELPER, configPath];
    const result = spawnSync("python3", pythonArgs, {
      encoding: "utf-8",
      env: { PATH: process.env.PATH || "", ...env },
      timeout: 5000,
    });
    const account = JSON.parse(fs.readFileSync(accountPath, "utf-8"));
    const accountFiles = fs.readdirSync(path.dirname(accountPath));
    const accountMode = fs.statSync(accountPath).mode & 0o777;
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenClawTestConfig;
    return { account, accountFiles, accountMode, config, result };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runMultiAccountCommitFailure(): MultiAccountFailureFixture {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-placeholder-"));
  const openclawDir = path.join(tmpDir, ".openclaw");
  const accountsDir = path.join(openclawDir, "openclaw-weixin", "accounts");
  const configPath = path.join(openclawDir, "openclaw.json");
  const primaryPath = path.join(accountsDir, "primary.json");
  const secondaryPath = path.join(accountsDir, "secondary.json");
  const primaryBefore = `${JSON.stringify({ token: CANONICAL, savedAt: SAVED_AT }, null, 2)}\n`;
  const secondaryBefore = `${JSON.stringify(
    { token: "openshell:resolve:env:v41_WECHAT_BOT_TOKEN", savedAt: SAVED_AT },
    null,
    2,
  )}\n`;

  fs.mkdirSync(accountsDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        channels: {
          "openclaw-weixin": {
            enabled: true,
            accounts: { primary: { enabled: true }, secondary: { enabled: true } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(primaryPath, primaryBefore, { mode: 0o600 });
  fs.writeFileSync(secondaryPath, secondaryBefore, { mode: 0o600 });

  try {
    const result = spawnSync(
      "python3",
      [
        "-I",
        "-c",
        [
          "import os, runpy, sys",
          "real_replace = os.replace",
          "failure = {'raised': False}",
          "def fail_second_commit(src, dst, *args, **kwargs):",
          "    if dst == 'secondary.json' and not failure['raised']:",
          "        failure['raised'] = True",
          "        raise OSError('forced second account commit failure')",
          "    return real_replace(src, dst, *args, **kwargs)",
          "os.replace = fail_second_commit",
          `sys.argv = [${JSON.stringify(REFRESH_HELPER)}, ${JSON.stringify(configPath)}]`,
          `runpy.run_path(${JSON.stringify(REFRESH_HELPER)}, run_name="__main__")`,
        ].join("\n"),
      ],
      {
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH || "",
          WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_WECHAT_BOT_TOKEN",
        },
        timeout: 5000,
      },
    );
    return {
      accountFiles: fs.readdirSync(accountsDir),
      primaryAfter: fs.readFileSync(primaryPath, "utf-8"),
      primaryBefore,
      result,
      secondaryAfter: fs.readFileSync(secondaryPath, "utf-8"),
      secondaryBefore,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("OpenClaw WeChat provider placeholder refresh (#10079)", () => {
  it("writes the runtime placeholder when OpenShell supplies a new revision without logging it", () => {
    const scoped = "openshell:resolve:env:v42_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(CANONICAL, { WECHAT_BOT_TOKEN: scoped });

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
    expect(run.result.stderr).toContain(
      "Refreshed WeChat account provider placeholder from OpenShell runtime env: WECHAT_BOT_TOKEN",
    );
    expect(run.result.stderr).not.toContain(scoped);
  });

  it("refreshes the account when active WeChat config omits the parent enabled field", () => {
    const scoped = "openshell:resolve:env:v42_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(CANONICAL, { WECHAT_BOT_TOKEN: scoped }, null);

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
  });

  it("refreshes the account when active WeChat config omits the account enabled field", () => {
    const scoped = "openshell:resolve:env:v42_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(CANONICAL, { WECHAT_BOT_TOKEN: scoped }, true, undefined, null);

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
  });

  it("refreshes a stale placeholder generation after provider rotation", () => {
    const scoped = "openshell:resolve:env:v51_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh("openshell:resolve:env:v42_WECHAT_BOT_TOKEN", {
      WECHAT_BOT_TOKEN: scoped,
    });

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
    expect(run.config).toEqual(wechatConfig(true));
    expect(run.result.stderr).not.toContain(scoped);
  });

  it("refreshes after mutable-config normalization and preserves its group-write mode", () => {
    const scoped = "openshell:resolve:env:v52_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(
      CANONICAL,
      { WECHAT_BOT_TOKEN: scoped },
      true,
      ({ configPath }) => {
        const normalized = spawnSync(
          "python3",
          [
            "-I",
            MUTABLE_CONFIG_NORMALIZER,
            path.dirname(configPath),
            String(process.getuid?.() ?? 0),
            String(process.getgid?.() ?? 0),
          ],
          { encoding: "utf-8", timeout: 5000 },
        );
        expect(
          fs.statSync(path.join(path.dirname(configPath), "openclaw-weixin/accounts/primary.json"))
            .mode & 0o777,
        ).toBe(0o660);
        expect(process.platform === "linux" ? normalized.status : 0, normalized.stderr).toBe(0);
      },
    );

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
    expect(run.accountMode).toBe(0o660);
  });

  it("leaves an already-current placeholder untouched", () => {
    const scoped = "openshell:resolve:env:v51_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(scoped, { WECHAT_BOT_TOKEN: scoped });

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
    expect(run.result.stderr).not.toContain("Refreshed WeChat account provider placeholder");
  });

  it("removes a validated stale helper temporary file before refreshing", () => {
    const scoped = "openshell:resolve:env:v51_WECHAT_BOT_TOKEN";
    const finishedProcess = spawnSync(process.execPath, ["-e", ""], { encoding: "utf-8" });
    expect(finishedProcess.status).toBe(0);
    const staleName = `.primary.json.nemoclaw-${finishedProcess.pid}-0123456789abcdef.tmp`;
    const run = runWechatRefresh(
      CANONICAL,
      { WECHAT_BOT_TOKEN: scoped },
      true,
      ({ accountPath }) => {
        fs.writeFileSync(path.join(path.dirname(accountPath), staleName), "stale\n", {
          mode: 0o600,
        });
      },
    );

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(scoped);
    expect(run.accountFiles).not.toContain(staleName);
  });

  it("refuses an unsafe stale helper temporary file", () => {
    const scoped = "openshell:resolve:env:v51_WECHAT_BOT_TOKEN";
    const finishedProcess = spawnSync(process.execPath, ["-e", ""], { encoding: "utf-8" });
    expect(finishedProcess.status).toBe(0);
    const staleName = `.primary.json.nemoclaw-${finishedProcess.pid}-0123456789abcdef.tmp`;
    const run = runWechatRefresh(
      CANONICAL,
      { WECHAT_BOT_TOKEN: scoped },
      true,
      ({ accountPath }) => {
        fs.writeFileSync(path.join(path.dirname(accountPath), staleName), "unsafe\n", {
          mode: 0o640,
        });
      },
    );

    expect(run.result.status).toBe(1);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.result.stderr).toContain("stale managed account temporary file is unsafe");
    expect(run.result.stderr).not.toContain(scoped);
  });

  it("reports redacted recovery guidance when refresh and temporary cleanup both fail", () => {
    const scoped = "openshell:resolve:env:v51_WECHAT_BOT_TOKEN";
    const run = runWechatRefresh(
      CANONICAL,
      { WECHAT_BOT_TOKEN: scoped },
      true,
      undefined,
      true,
      "replace-and-unlink",
    );

    expect(run.result.status).not.toBe(0);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.result.stderr).toContain(
      "restore owner write access to the managed account directory and retry startup",
    );
    expect(run.result.stderr).not.toContain(scoped);
  });

  it("restores earlier accounts when a later account commit fails", () => {
    const run = runMultiAccountCommitFailure();

    expect(run.result.status).toBe(1);
    expect(run.primaryAfter).toBe(run.primaryBefore);
    expect(run.secondaryAfter).toBe(run.secondaryBefore);
    expect(run.accountFiles).toEqual(["primary.json", "secondary.json"]);
    expect(run.result.stderr).toContain("original files were restored");
    expect(run.result.stderr).not.toContain("v41_WECHAT_BOT_TOKEN");
    expect(run.result.stderr).not.toContain("v42_WECHAT_BOT_TOKEN");
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

  it("rejects a symlinked OpenClaw configuration before changing the account", () => {
    const run = runWechatRefresh(
      CANONICAL,
      { WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_WECHAT_BOT_TOKEN" },
      true,
      ({ configPath, tmpDir }) => {
        const targetPath = path.join(tmpDir, "outside-openclaw.json");
        fs.renameSync(configPath, targetPath);
        fs.symlinkSync(targetPath, configPath);
      },
    );

    expect(run.result.status).toBe(1);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.result.stderr).toContain("openclaw.json is unreadable or unsafe");
  });

  it("rejects an invalid WeChat placeholder without updating another provider", () => {
    const telegramCanonical = "openshell:resolve:env:TELEGRAM_BOT_TOKEN";
    const run = runWechatRefresh(
      CANONICAL,
      {
        TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_OTHER_TOKEN",
      },
      true,
      ({ configPath }) => {
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenClawTestConfig;
        config.channels.telegram = {
          accounts: { default: { botToken: telegramCanonical } },
        };
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      },
    );

    expect(run.result.status).toBe(1);
    expect(run.config.channels.telegram?.accounts.default.botToken).toBe(telegramCanonical);
  });

  it("rejects an unsafe WeChat account without updating another provider", () => {
    const telegramCanonical = "openshell:resolve:env:TELEGRAM_BOT_TOKEN";
    const run = runWechatRefresh(
      CANONICAL,
      {
        TELEGRAM_BOT_TOKEN: "openshell:resolve:env:v42_TELEGRAM_BOT_TOKEN",
        WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_WECHAT_BOT_TOKEN",
      },
      true,
      ({ accountPath, configPath }) => {
        fs.chmodSync(accountPath, 0o640);
        const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as OpenClawTestConfig;
        config.channels.telegram = {
          accounts: { default: { botToken: telegramCanonical } },
        };
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      },
    );

    expect(run.result.status).toBe(1);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.config.channels.telegram?.accounts.default.botToken).toBe(telegramCanonical);
  });

  it("leaves the account untouched while the channel is stopped", () => {
    const run = runWechatRefresh(CANONICAL, {}, false);

    expect(run.result.status, String(run.result.stderr)).toBe(0);
    expect(run.account.token).toBe(CANONICAL);
    expect(run.result.stderr).not.toContain("Refusing WeChat provider placeholder refresh");
  });

  it("leaves an intentionally removed managed WeChat tree absent", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-wechat-placeholder-"));
    const openclawDir = path.join(tmpDir, ".openclaw");
    const configPath = path.join(openclawDir, "openclaw.json");
    fs.mkdirSync(openclawDir);
    fs.writeFileSync(configPath, `${JSON.stringify(wechatConfig(true), null, 2)}\n`);

    try {
      const result = spawnSync("python3", ["-I", REFRESH_HELPER, configPath], {
        encoding: "utf-8",
        env: {
          PATH: process.env.PATH || "",
          WECHAT_BOT_TOKEN: "openshell:resolve:env:v42_WECHAT_BOT_TOKEN",
        },
        timeout: 5000,
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(openclawDir, "openclaw-weixin"))).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
      "managed account file has unsafe ownership or permissions",
    ],
    [
      "symlinked account-directory",
      ({ accountPath, tmpDir }: { accountPath: string; tmpDir: string }) => {
        const accountsDir = path.dirname(accountPath);
        const outsideDir = path.join(tmpDir, "outside-accounts");
        fs.mkdirSync(outsideDir);
        fs.renameSync(accountPath, path.join(outsideDir, "primary.json"));
        fs.rmdirSync(accountsDir);
        fs.symlinkSync(outsideDir, accountsDir);
      },
      "managed account directory is missing or unsafe",
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
