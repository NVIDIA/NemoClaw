// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

import {
  expectExitZero,
  type FakeDockerApi,
  runSandboxNode,
} from "./messaging-providers-helpers.ts";

export type InstalledWechatRuntimeProof = {
  ok: true;
  proof: "openclaw-weixin-runtime-send";
  accountId: string;
  messageId: string;
  pluginVersion: string;
};

export const WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE = String.raw`
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function packageName(candidate) {
  try {
    return JSON.parse(fs.readFileSync(path.join(candidate, "package.json"), "utf8")).name;
  } catch {
    return undefined;
  }
}

function resolveOpenClawRoot() {
  const candidates = [
    "/usr/local/lib/node_modules/openclaw",
    "/tmp/npm-global/lib/node_modules/openclaw",
  ];
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    candidates.push(path.join(globalRoot, "openclaw"));
  } catch {}
  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw"], {
      encoding: "utf8",
    }).trim();
    let current = path.dirname(fs.realpathSync(openclawBin));
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {}
  return candidates.find((candidate) => packageName(candidate) === "openclaw") || null;
}

const stateDir = process.env.OPENCLAW_STATE_DIR || "/sandbox/.openclaw";
const extensionRoot = path.join(stateDir, "extensions", "openclaw-weixin");
invariant(fs.existsSync(extensionRoot), "installed openclaw-weixin extension is missing");
const pluginRoot = fs.realpathSync(extensionRoot);
const pluginMetadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
invariant(
  pluginMetadata.name === "@tencent-weixin/openclaw-weixin",
  "installed extension is not @tencent-weixin/openclaw-weixin",
);
const openclawRoot = resolveOpenClawRoot();
invariant(openclawRoot, "installed OpenClaw package root is missing");

const proofWorkspace = fs.mkdtempSync("/tmp/openclaw-wechat-proof-");
try {
  const nodeModules = path.join(proofWorkspace, "node_modules");
  const wechatScope = path.join(nodeModules, "@tencent-weixin");
  fs.mkdirSync(wechatScope, { recursive: true });
  fs.symlinkSync(pluginRoot, path.join(wechatScope, "openclaw-weixin"), "dir");
  fs.symlinkSync(openclawRoot, path.join(nodeModules, "openclaw"), "dir");
  const proofPluginRoot = path.join(wechatScope, "openclaw-weixin");
  const [accountsModule, sendModule] = await Promise.all([
    import(pathToFileURL(path.join(proofPluginRoot, "dist/src/auth/accounts.js")).href),
    import(pathToFileURL(path.join(proofPluginRoot, "dist/src/messaging/send.js")).href),
  ]);
  invariant(
    typeof accountsModule.resolveWeixinAccount === "function",
    "installed WeChat runtime does not export resolveWeixinAccount",
  );
  invariant(
    typeof sendModule.sendMessageWeixin === "function",
    "installed WeChat runtime does not export sendMessageWeixin",
  );

  const cfg = JSON.parse(fs.readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
  const accountId = process.env.WECHAT_ACCOUNT_ID;
  invariant(accountId, "WECHAT_ACCOUNT_ID is required for the installed runtime proof");
  const account = accountsModule.resolveWeixinAccount(cfg, accountId);
  invariant(account.accountId === accountId, "installed WeChat runtime resolved the wrong account");
  invariant(account.enabled === true, "installed WeChat runtime resolved a disabled account");
  invariant(account.configured === true, "installed WeChat runtime resolved an unconfigured account");
  invariant(
    account.baseUrl === process.env.EXPECTED_WECHAT_BASE_URL,
    "installed WeChat runtime resolved an unexpected account base URL",
  );
  invariant(
    /^openshell:resolve:env:v[0-9]+_WECHAT_BOT_TOKEN$/.test(account.token || ""),
    "installed WeChat runtime did not load the revision-scoped account token",
  );

  const target = process.env.OPENCLAW_WECHAT_TARGET || "e2e-user@im.wechat";
  const text = process.env.OPENCLAW_WECHAT_TEXT || "NemoClaw OpenClaw WeChat plugin mock E2E";
  const result = await sendModule.sendMessageWeixin({
    to: target,
    text,
    opts: {
      baseUrl: "http://host.openshell.internal:" + process.env.FAKE_WECHAT_API_PORT,
      token: account.token,
      contextToken: "nemoclaw-e2e-context",
      timeoutMs: 30_000,
    },
  });
  invariant(typeof result.messageId === "string" && result.messageId, "WeChat send emitted no ID");
  console.log(
    JSON.stringify({
      ok: true,
      proof: "openclaw-weixin-runtime-send",
      accountId: account.accountId,
      messageId: result.messageId,
      pluginVersion: pluginMetadata.version,
    }),
  );
} finally {
  fs.rmSync(proofWorkspace, { recursive: true, force: true });
}
`;

export function parseInstalledWechatProof(stdout: string): InstalledWechatRuntimeProof {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line) as Partial<InstalledWechatRuntimeProof>;
      if (
        value.ok === true &&
        value.proof === "openclaw-weixin-runtime-send" &&
        typeof value.accountId === "string" &&
        value.accountId.length > 0 &&
        typeof value.messageId === "string" &&
        value.messageId.length > 0 &&
        typeof value.pluginVersion === "string" &&
        value.pluginVersion.length > 0
      ) {
        return value as InstalledWechatRuntimeProof;
      }
    } catch {
      // The installed runtime can emit diagnostics before the proof record.
    }
  }
  throw new Error(`installed WeChat runtime proof did not emit a valid result:\n${stdout}`);
}

export async function runInstalledWechatRuntimeProof(
  sandbox: SandboxClient,
  fakeWechat: FakeDockerApi,
  accountId: string,
  expectedBaseUrl: string,
  target: string,
  message: string,
  redactionValues: string[],
): Promise<InstalledWechatRuntimeProof> {
  const result = await runSandboxNode(sandbox, WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE, {
    artifactName: "installed-wechat-runtime-proof",
    env: {
      OPENCLAW_STATE_DIR: "/sandbox/.openclaw",
      FAKE_WECHAT_API_PORT: fakeWechat.port,
      WECHAT_ACCOUNT_ID: accountId,
      EXPECTED_WECHAT_BASE_URL: expectedBaseUrl,
      OPENCLAW_WECHAT_TARGET: target,
      OPENCLAW_WECHAT_TEXT: message,
    },
    redactionValues,
    timeoutMs: 120_000,
  });
  expectExitZero(result, "installed OpenClaw WeChat runtime proof");
  return parseInstalledWechatProof(result.stdout);
}
