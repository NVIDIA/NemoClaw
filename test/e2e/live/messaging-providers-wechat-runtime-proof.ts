// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

const readWechatPackageName: (
  candidate: string,
  fileSystem: typeof fs,
  pathModule: typeof path,
) => string | undefined = function readWechatPackageName(candidate, fileSystem, pathModule) {
  try {
    return JSON.parse(fileSystem.readFileSync(pathModule.join(candidate, "package.json"), "utf8"))
      .name;
  } catch {
    return undefined;
  }
};

const addManagedNpmProjectWechatCandidates: (
  projectsDir: string,
  candidates: string[],
  fileSystem: typeof fs,
  pathModule: typeof path,
) => void = function addManagedNpmProjectWechatCandidates(
  projectsDir,
  candidates,
  fileSystem,
  pathModule,
) {
  const entries = (() => {
    try {
      return fileSystem.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    candidates.push(
      pathModule.join(
        projectsDir,
        entry.name,
        "node_modules",
        "@tencent-weixin",
        "openclaw-weixin",
      ),
    );
  }
};

const linkWechatNodeModulesEntries: (
  nodeModulesRoot: string,
  sourceNodeModules: string,
  fileSystem: typeof fs,
  pathModule: typeof path,
  skip?: Set<string>,
) => void = function linkWechatNodeModulesEntries(
  nodeModulesRoot,
  sourceNodeModules,
  fileSystem,
  pathModule,
  skip = new Set(),
) {
  if (!fileSystem.existsSync(sourceNodeModules)) return;
  for (const entry of fileSystem.readdirSync(sourceNodeModules)) {
    const sourceEntry = pathModule.join(sourceNodeModules, entry);
    const destEntry = pathModule.join(nodeModulesRoot, entry);
    if (entry.startsWith("@") && fileSystem.statSync(sourceEntry).isDirectory()) {
      fileSystem.mkdirSync(destEntry, { recursive: true });
      for (const scopedEntry of fileSystem.readdirSync(sourceEntry)) {
        const key = entry + "/" + scopedEntry;
        if (skip.has(key)) continue;
        const sourceScopedEntry = pathModule.join(sourceEntry, scopedEntry);
        const destScopedEntry = pathModule.join(destEntry, scopedEntry);
        if (!fileSystem.existsSync(destScopedEntry)) {
          fileSystem.symlinkSync(sourceScopedEntry, destScopedEntry, "dir");
        }
      }
    } else if (!skip.has(entry) && !fileSystem.existsSync(destEntry)) {
      fileSystem.symlinkSync(sourceEntry, destEntry, "dir");
    }
  }
};

const resolveInstalledWechatPluginRootWithDependencies: (
  stateDir: string,
  fileSystem: typeof fs,
  pathModule: typeof path,
) => string | null = function resolveInstalledWechatPluginRootWithDependencies(
  stateDir,
  fileSystem,
  pathModule,
) {
  const candidates = [pathModule.join(stateDir, "extensions", "openclaw-weixin")];
  addManagedNpmProjectWechatCandidates(
    pathModule.join(stateDir, "npm", "projects"),
    candidates,
    fileSystem,
    pathModule,
  );
  const matches: string[] = [];
  for (const candidate of candidates) {
    if (
      readWechatPackageName(candidate, fileSystem, pathModule) !== "@tencent-weixin/openclaw-weixin"
    ) {
      continue;
    }
    try {
      const resolved = fileSystem.realpathSync(candidate);
      if (!matches.includes(resolved)) matches.push(resolved);
    } catch {}
  }
  return matches.length === 1 ? matches[0] : null;
};

export function resolveInstalledWechatPluginRoot(stateDir: string): string | null {
  return resolveInstalledWechatPluginRootWithDependencies(stateDir, fs, path);
}

const resolveInstalledOpenClawRoot: (
  executeFileSync: typeof execFileSync,
  fileSystem: typeof fs,
  pathModule: typeof path,
) => string | null = function resolveInstalledOpenClawRoot(
  executeFileSync,
  fileSystem,
  pathModule,
) {
  const candidates = [
    "/usr/local/lib/node_modules/openclaw",
    "/tmp/npm-global/lib/node_modules/openclaw",
  ];
  try {
    const globalRoot = executeFileSync("npm", ["root", "-g"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 5_000,
    }).trim();
    candidates.push(pathModule.join(globalRoot, "openclaw"));
  } catch {}
  try {
    const openclawBin = executeFileSync("sh", ["-lc", "command -v openclaw"], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 5_000,
    }).trim();
    let current = pathModule.dirname(fileSystem.realpathSync(openclawBin));
    for (let depth = 0; depth < 8; depth += 1) {
      candidates.push(current);
      const parent = pathModule.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  } catch {}
  const root = candidates.find(
    (candidate) => readWechatPackageName(candidate, fileSystem, pathModule) === "openclaw",
  );
  return root ? fileSystem.realpathSync(root) : null;
};

export const WECHAT_INSTALLED_RUNTIME_PROOF_SOURCE = String.raw`
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

const readWechatPackageName = ${readWechatPackageName.toString()};
const addManagedNpmProjectWechatCandidates = ${addManagedNpmProjectWechatCandidates.toString()};
const linkWechatNodeModulesEntries = ${linkWechatNodeModulesEntries.toString()};
const resolveInstalledWechatPluginRootWithDependencies = ${resolveInstalledWechatPluginRootWithDependencies.toString()};
const resolveInstalledOpenClawRoot = ${resolveInstalledOpenClawRoot.toString()};

function startPolicyRelay() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const headers = { ...request.headers };
      headers.host = "host.openshell.internal:" + process.env.FAKE_WECHAT_API_PORT;
      delete headers.connection;
      delete headers["proxy-connection"];
      const upstream = http.request(
        {
          hostname: "host.openshell.internal",
          port: Number(process.env.FAKE_WECHAT_API_PORT),
          path: request.url,
          method: request.method,
          headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        response.headersSent
          ? response.end("WeChat fixture relay failed")
          : response.writeHead(502).end("WeChat fixture relay failed");
      });
      request.pipe(upstream);
    });
    const rejectStartup = (error) => reject(error);
    server.once("error", rejectStartup);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectStartup);
      const address = server.address();
      const port = address !== null && typeof address !== "string" ? address.port : null;
      port === null
        ? server.close(() => reject(new Error("WeChat fixture relay did not expose an IPv4 port")))
        : resolve({ server, baseUrl: "http://127.0.0.1:" + port });
    });
  });
}

function stopPolicyRelay(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

const stateDir = process.env.OPENCLAW_STATE_DIR || "/sandbox/.openclaw";
const pluginRoot = resolveInstalledWechatPluginRootWithDependencies(stateDir, fs, path);
invariant(pluginRoot, "installed openclaw-weixin plugin is missing or has multiple installations");
const pluginMetadata = JSON.parse(fs.readFileSync(path.join(pluginRoot, "package.json"), "utf8"));
invariant(
  pluginMetadata.name === "@tencent-weixin/openclaw-weixin",
  "installed plugin is not @tencent-weixin/openclaw-weixin",
);
const openclawRoot = resolveInstalledOpenClawRoot(execFileSync, fs, path);
invariant(openclawRoot, "installed OpenClaw package root is missing");

const proofWorkspace = fs.mkdtempSync("/tmp/openclaw-wechat-proof-");
try {
  const nodeModules = path.join(proofWorkspace, "node_modules");
  const wechatScope = path.join(nodeModules, "@tencent-weixin");
  fs.mkdirSync(wechatScope, { recursive: true });
  fs.symlinkSync(pluginRoot, path.join(wechatScope, "openclaw-weixin"), "dir");
  fs.symlinkSync(openclawRoot, path.join(nodeModules, "openclaw"), "dir");
  const skip = new Set(["openclaw", "@tencent-weixin/openclaw-weixin"]);
  linkWechatNodeModulesEntries(nodeModules, path.resolve(pluginRoot, "../.."), fs, path, skip);
  linkWechatNodeModulesEntries(nodeModules, path.dirname(openclawRoot), fs, path, skip);
  linkWechatNodeModulesEntries(nodeModules, path.join(openclawRoot, "node_modules"), fs, path, skip);
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

  const relay = await startPolicyRelay();
  let result;
  try {
    const target = process.env.OPENCLAW_WECHAT_TARGET || "e2e-user@im.wechat";
    const text = process.env.OPENCLAW_WECHAT_TEXT || "NemoClaw OpenClaw WeChat plugin mock E2E";
    result = await sendModule.sendMessageWeixin({
      to: target,
      text,
      opts: {
        baseUrl: relay.baseUrl,
        token: account.token,
        contextToken: "nemoclaw-e2e-context",
        timeoutMs: 30_000,
      },
    });
  } finally {
    await stopPolicyRelay(relay.server);
  }
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
