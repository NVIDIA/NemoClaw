// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

import {
  expectExitZero,
  type FakeDockerApi,
  runSandboxNode,
} from "./messaging-providers-helpers.ts";

export type InstalledSlackRuntimeProof = {
  ok: true;
  proof: "openclaw-pipeline-runtime" | "openclaw-private-helper";
  allowedReplyTarget: string;
  deniedPrepared: true;
  deniedFeedbackMethod: "chat.postEphemeral";
  deniedFeedbackCount: 1;
  messageId: string;
  channelId: string;
};

export const SLACK_INSTALLED_RUNTIME_PROOF_SOURCE = String.raw`
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const allowLegacyTestApi = process.env.NEMOCLAW_E2E_ALLOW_LEGACY_SLACK_TEST_API === "1";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function resolveOpenClawSlackApiLocation() {
  const externalCandidates = [];
  const coreCandidates = [];
  const seen = new Set();
  const require = createRequire(import.meta.url);
  const addExternalCandidate = (candidate) => {
    if (!candidate) return;
    const normalized = path.resolve(candidate);
    if (!seen.has("external:" + normalized)) {
      seen.add("external:" + normalized);
      externalCandidates.push(normalized);
    }
  };
  const addCoreCandidate = (candidate) => {
    if (!candidate) return;
    const normalized = path.resolve(candidate);
    if (!seen.has("core:" + normalized)) {
      seen.add("core:" + normalized);
      coreCandidates.push(normalized);
    }
  };
  const addPathWalk = (start) => {
    if (!start) return;
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      addExternalCandidate(path.join(current, "node_modules/@openclaw/slack"));
      addCoreCandidate(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };
  const findPipelineRuntimePath = (distDir) => {
    try {
      return fs
        .readdirSync(distDir)
        .filter((entry) => /^pipeline\.runtime-.*\.js$/.test(entry))
        .map((entry) => path.join(distDir, entry))
        .sort()[0];
    } catch {
      return undefined;
    }
  };

  addExternalCandidate(
    path.join(process.env.OPENCLAW_STATE_DIR || "/sandbox/.openclaw", "extensions", "slack"),
  );
  addExternalCandidate(process.env.OPENCLAW_SLACK_PACKAGE_ROOT);
  addCoreCandidate(process.env.OPENCLAW_PACKAGE_ROOT);
  for (const base of [
    process.cwd(),
    "/sandbox",
    "/usr/local/lib/node_modules",
    "/tmp/npm-global/lib/node_modules",
  ]) {
    try {
      addExternalCandidate(
        path.dirname(require.resolve("@openclaw/slack/package.json", { paths: [base] })),
      );
    } catch {}
    try {
      addCoreCandidate(path.dirname(require.resolve("openclaw/package.json", { paths: [base] })));
    } catch {}
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    addExternalCandidate(path.join(globalRoot, "@openclaw/slack"));
    addCoreCandidate(path.join(globalRoot, "openclaw"));
  } catch {}
  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw || true"], {
      encoding: "utf8",
    }).trim();
    if (openclawBin) {
      addPathWalk(
        path.dirname(execFileSync("readlink", ["-f", openclawBin], { encoding: "utf8" }).trim()),
      );
    }
  } catch {}
  addExternalCandidate("/usr/local/lib/node_modules/@openclaw/slack");
  addExternalCandidate("/tmp/npm-global/lib/node_modules/@openclaw/slack");
  addCoreCandidate("/usr/local/lib/node_modules/openclaw");
  addCoreCandidate("/tmp/npm-global/lib/node_modules/openclaw");

  const openclawRoot = coreCandidates.find(
    (candidate) =>
      fs.existsSync(path.join(candidate, "package.json")) &&
      fs.existsSync(path.join(candidate, "dist/plugin-sdk/temp-path.js")),
  );
  for (const candidate of externalCandidates) {
    const distDir = path.join(candidate, "dist");
    const runtimeApiPath = path.join(distDir, "runtime-api.js");
    const pipelineRuntimePath = findPipelineRuntimePath(distDir);
    if (fs.existsSync(runtimeApiPath) && pipelineRuntimePath) {
      return {
        kind: "external",
        apiKind: "pipeline-runtime",
        root: candidate,
        openclawRoot,
      };
    }
    if (allowLegacyTestApi && fs.existsSync(path.join(distDir, "test-api.js"))) {
      return { kind: "external", apiKind: "test-api", root: candidate, openclawRoot };
    }
  }
  for (const candidate of coreCandidates) {
    const distDir = path.join(candidate, "dist/extensions/slack");
    const runtimeApiPath = path.join(distDir, "runtime-api.js");
    const pipelineRuntimePath = findPipelineRuntimePath(distDir);
    if (fs.existsSync(runtimeApiPath) && pipelineRuntimePath) {
      return { kind: "core", apiKind: "pipeline-runtime", root: candidate };
    }
    if (allowLegacyTestApi && fs.existsSync(path.join(distDir, "test-api.js"))) {
      return { kind: "core", apiKind: "test-api", root: candidate };
    }
  }
  return null;
}

function linkNodeModulesEntries(nodeModulesRoot, sourceNodeModules, skip = new Set()) {
  if (!fs.existsSync(sourceNodeModules)) return;
  for (const entry of fs.readdirSync(sourceNodeModules)) {
    const sourceEntry = path.join(sourceNodeModules, entry);
    const destEntry = path.join(nodeModulesRoot, entry);
    if (entry.startsWith("@") && fs.statSync(sourceEntry).isDirectory()) {
      fs.mkdirSync(destEntry, { recursive: true });
      for (const scopedEntry of fs.readdirSync(sourceEntry)) {
        const key = entry + "/" + scopedEntry;
        if (skip.has(key)) continue;
        const sourceScopedEntry = path.join(sourceEntry, scopedEntry);
        const destScopedEntry = path.join(destEntry, scopedEntry);
        if (!fs.existsSync(destScopedEntry)) {
          fs.symlinkSync(sourceScopedEntry, destScopedEntry, "dir");
        }
      }
    } else if (!skip.has(entry) && !fs.existsSync(destEntry)) {
      fs.symlinkSync(sourceEntry, destEntry, "dir");
    }
  }
}

function createCoreProofRoot(openclawRoot) {
  const proofWorkspace = fs.mkdtempSync("/tmp/openclaw-slack-proof-");
  const proofRoot = path.join(proofWorkspace, "node_modules/openclaw");
  fs.mkdirSync(proofRoot, { recursive: true });
  fs.copyFileSync(path.join(openclawRoot, "package.json"), path.join(proofRoot, "package.json"));
  fs.symlinkSync(path.join(openclawRoot, "dist"), path.join(proofRoot, "dist"), "dir");
  const nodeModulesRoot = path.join(proofRoot, "node_modules");
  fs.mkdirSync(nodeModulesRoot, { recursive: true });
  linkNodeModulesEntries(nodeModulesRoot, path.join(openclawRoot, "node_modules"));
  linkNodeModulesEntries(nodeModulesRoot, path.dirname(openclawRoot));
  return proofRoot;
}

function createExternalProofRoot(location) {
  if (!location.openclawRoot) return location.root;
  const proofWorkspace = fs.mkdtempSync("/tmp/openclaw-slack-external-proof-");
  const nodeModulesRoot = path.join(proofWorkspace, "node_modules");
  const openclawScopeRoot = path.join(nodeModulesRoot, "@openclaw");
  fs.mkdirSync(openclawScopeRoot, { recursive: true });
  const slackProofRoot = path.join(openclawScopeRoot, "slack");
  fs.symlinkSync(location.root, slackProofRoot, "dir");
  fs.symlinkSync(location.openclawRoot, path.join(nodeModulesRoot, "openclaw"), "dir");
  const skip = new Set(["openclaw", "@openclaw/slack"]);
  linkNodeModulesEntries(nodeModulesRoot, path.resolve(location.root, "../.."), skip);
  linkNodeModulesEntries(nodeModulesRoot, path.join(location.root, "node_modules"), skip);
  linkNodeModulesEntries(nodeModulesRoot, path.dirname(location.openclawRoot), skip);
  linkNodeModulesEntries(nodeModulesRoot, path.join(location.openclawRoot, "node_modules"), skip);
  return slackProofRoot;
}

function resolveTestApiImport(testApiSource, exportName) {
  const escaped = exportName.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      "import\\s+\\{[^}]*\\bas\\s+" + escaped + "\\b[^}]*\\}\\s+from\\s+[\"']([^\"']+)[\"']",
    ),
    new RegExp(
      "import\\s+\\{[^}]*\\b" + escaped + "\\b[^}]*\\}\\s+from\\s+[\"']([^\"']+)[\"']",
    ),
  ];
  const match = patterns.map((pattern) => testApiSource.match(pattern)).find(Boolean);
  if (!match) throw new Error("OpenClaw Slack test API does not expose " + exportName);
  return match[1];
}

function findPipelineRuntimePath(slackDir) {
  return fs
    .readdirSync(slackDir)
    .filter((entry) => /^pipeline\.runtime-.*\.js$/.test(entry))
    .map((entry) => path.join(slackDir, entry))
    .sort()[0];
}

async function importProofModules(slackDir, apiKind) {
  if (apiKind === "pipeline-runtime") {
    const pipelinePath = findPipelineRuntimePath(slackDir);
    invariant(pipelinePath, "OpenClaw Slack pipeline runtime not found");
    const [pipelineModule, runtimeModule] = await Promise.all([
      import(pathToFileURL(pipelinePath).href),
      import(pathToFileURL(path.join(slackDir, "runtime-api.js")).href),
    ]);
    return {
      proofApiKind: "pipeline-runtime",
      prepareSlackMessage: pipelineModule.prepareSlackMessage,
      sendMessageSlack: runtimeModule.sendMessageSlack,
    };
  }
  const testApiSource = fs.readFileSync(path.join(slackDir, "test-api.js"), "utf8");
  const helperPath = resolveTestApiImport(testApiSource, "createInboundSlackTestContext");
  const preparePath = resolveTestApiImport(testApiSource, "prepareSlackMessage");
  const sendPath = resolveTestApiImport(testApiSource, "sendMessageSlack");
  const [helperModule, prepareModule, sendModule] = await Promise.all([
    import(pathToFileURL(path.join(slackDir, helperPath)).href),
    import(pathToFileURL(path.join(slackDir, preparePath)).href),
    import(pathToFileURL(path.join(slackDir, sendPath)).href),
  ]);
  return {
    proofApiKind: "test-api",
    createInboundSlackTestContext:
      helperModule.createInboundSlackTestContext || helperModule.t,
    prepareSlackMessage: prepareModule.prepareSlackMessage || prepareModule.t,
    sendMessageSlack: sendModule.sendMessageSlack || sendModule.t,
  };
}

async function importOpenClawSlackProofApi(location) {
  const proofRoot =
    location.kind === "external" ? createExternalProofRoot(location) : createCoreProofRoot(location.root);
  const slackDir = path.join(
    proofRoot,
    location.kind === "external" ? "dist" : "dist/extensions/slack",
  );
  return importProofModules(slackDir, location.apiKind);
}

function postForm(pathname, fields, authorization) {
  const body = new URLSearchParams(fields).toString();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "host.openshell.internal",
        port: Number(process.env.FAKE_SLACK_API_PORT),
        path: pathname,
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          try {
            resolve({
              statusCode: res.statusCode,
              body: responseBody ? JSON.parse(responseBody) : {},
            });
          } catch (error) {
            reject(new Error("invalid JSON from fake Slack: " + error.message));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("fake Slack postMessage timed out")));
    req.write(body);
    req.end();
  });
}

const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const slackAccount = cfg.channels?.slack?.accounts?.default;
invariant(slackAccount, "missing channels.slack.accounts.default");
invariant(slackAccount.dmPolicy === "allowlist", "unexpected Slack dmPolicy");
invariant(slackAccount.groupPolicy === "allowlist", "unexpected Slack groupPolicy");
const wildcard = slackAccount.channels?.["*"];
invariant(
  wildcard?.enabled && wildcard.requireMention === true,
  "missing enabled requireMention wildcard Slack channel config",
);
const allowedUser = process.env.SLACK_ALLOWED_USER || "U0AR85ATALW";
const deniedUser = process.env.SLACK_DENIED_USER || "U999DENIED";
invariant(
  Array.isArray(wildcard.users) && wildcard.users.includes(allowedUser),
  "Slack wildcard users do not include the configured allowed user",
);
invariant(!wildcard.users.includes(deniedUser), "Slack wildcard users include the denied user");

const channelId = "C0E2ESLACK";
const baseMessage = {
  channel: channelId,
  channel_type: "channel",
  team: "T1",
  text: "<@B1> channel mention proof",
};
const proofText = "NemoClaw Slack channel mention proof";
const token = slackAccount.botToken;

function createPipelineSlackProofContext(appClient) {
  const assistantThreads = new Map();
  return {
    cfg,
    runtime: {},
    app: { client: appClient },
    botToken: token,
    botUserId: "B1",
    botId: "B1",
    teamId: "T1",
    apiAppId: "A1",
    channelsConfig: slackAccount.channels,
    channelsConfigKeys: Object.keys(slackAccount.channels || {}),
    defaultRequireMention: slackAccount.requireMention ?? true,
    threadRequireExplicitMention: false,
    threadInheritParent: false,
    threadHistoryScope: "thread",
    allowNameMatching: false,
    allowFrom: Array.isArray(slackAccount.allowFrom) ? slackAccount.allowFrom : [],
    dmPolicy: slackAccount.dmPolicy,
    groupPolicy: slackAccount.groupPolicy,
    historyLimit: 0,
    dmHistoryLimit: 0,
    mediaMaxBytes: 0,
    textLimit: 4000,
    channelHistories: new Map(),
    typingReaction: null,
    ackReactionScope: "off",
    removeAckAfterReply: false,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    isChannelAllowed: ({ channelId: candidateId, channelName }) => {
      const channels = slackAccount.channels || {};
      return Boolean(
        channels[candidateId]?.enabled ||
          (channelName && channels[channelName]?.enabled) ||
          channels["*"]?.enabled,
      );
    },
    resolveChannelName: async (channel) => ({
      id: channel,
      name: "nemoclaw-test",
      type: "channel",
      is_channel: true,
    }),
    resolveUserName: async (user) => ({
      id: user,
      name: user,
      real_name: user,
      profile: { display_name: user, real_name: user },
    }),
    getSlackAssistantThreadContext: (channel, threadTs) =>
      assistantThreads.get(channel + ":" + threadTs),
    saveSlackAssistantThreadContext: (context) => {
      if (context?.channelId && context?.threadTs) {
        assistantThreads.set(context.channelId + ":" + context.threadTs, context);
      }
    },
    setSlackThreadStatus: async () => ({ ok: true }),
  };
}

const senderFeedbackCalls = [];
const appClient = {
  assistant: { threads: { setStatus: async () => ({ ok: true }) } },
  conversations: {
    info: async () => ({
      ok: true,
      channel: { id: channelId, name: "nemoclaw-test", is_channel: true },
    }),
    open: async ({ users }) => ({ ok: true, channel: { id: "D" + users } }),
  },
  reactions: {
    add: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
  },
  users: {
    info: async ({ user }) => ({
      ok: true,
      user: { id: user, name: user, profile: { display_name: user, real_name: user } },
    }),
  },
  chat: {
    postEphemeral: async (payload) => {
      senderFeedbackCalls.push({
        method: "chat.postEphemeral",
        channel: payload.channel,
        user: payload.user,
        text: payload.text,
      });
      return { ok: true, message_ts: "1710000000.000200" };
    },
    postMessage: async (payload) => {
      senderFeedbackCalls.push({
        method: "chat.postMessage",
        channel: payload.channel,
        text: payload.text,
      });
      return { ok: true, ts: "1710000000.000201" };
    },
  },
};

const location = resolveOpenClawSlackApiLocation();
invariant(location, "could not find installed OpenClaw Slack proof API");
const slackApi = await importOpenClawSlackProofApi(location);
const { createInboundSlackTestContext, prepareSlackMessage, sendMessageSlack, proofApiKind } =
  slackApi;
invariant(
  typeof prepareSlackMessage === "function" && typeof sendMessageSlack === "function",
  "installed OpenClaw Slack API does not expose prepareSlackMessage and sendMessageSlack",
);
const ctx =
  typeof createInboundSlackTestContext === "function"
    ? createInboundSlackTestContext({
        cfg,
        appClient,
        channelsConfig: slackAccount.channels,
        defaultRequireMention: slackAccount.requireMention ?? true,
      })
    : createPipelineSlackProofContext(appClient);
Object.assign(ctx, { botToken: token, botUserId: "B1", botId: "B1", teamId: "T1", apiAppId: "A1" });
const account = {
  accountId: "default",
  botToken: token,
  appToken: slackAccount.appToken,
  config: slackAccount,
};
const allowedPrepared = await prepareSlackMessage({
  ctx,
  account,
  message: { ...baseMessage, user: allowedUser, ts: "1710000000.000100" },
  opts: { source: "app_mention", wasMentioned: true },
});
invariant(allowedPrepared, "allowed Slack app_mention did not prepare");
invariant(
  allowedPrepared.replyTarget === "channel:" + channelId,
  "allowed Slack app_mention returned the wrong reply target",
);
invariant(senderFeedbackCalls.length === 0, "allowed Slack app_mention produced feedback");

const deniedPrepared = await prepareSlackMessage({
  ctx,
  account,
  message: { ...baseMessage, user: deniedUser, ts: "1710000000.000101" },
  opts: { source: "app_mention", wasMentioned: true },
});
invariant(deniedPrepared === null, "denied Slack app_mention unexpectedly prepared");
invariant(
  senderFeedbackCalls.length === 1,
  "denied Slack app_mention did not produce exactly one feedback action",
);
const deniedFeedback = senderFeedbackCalls[0];
invariant(
  deniedFeedback.method === "chat.postEphemeral" &&
    deniedFeedback.channel === channelId &&
    deniedFeedback.user === deniedUser,
  "denied Slack app_mention feedback was not bounded to the denied sender",
);
invariant(Boolean(deniedFeedback.text), "denied Slack feedback text was empty");
invariant(
  !deniedFeedback.text.includes(allowedUser) &&
    !/allow\s*list|allowlist|allowed users/i.test(deniedFeedback.text),
  "denied Slack feedback leaked allowlist details",
);

const fakeClient = {
  chat: {
    postMessage: async (payload) => {
      const response = await postForm(
        "/api/chat.postMessage",
        {
          token,
          channel: payload.channel || "",
          text: payload.text || "",
          ...(payload.thread_ts ? { thread_ts: payload.thread_ts } : {}),
          ...(payload.blocks ? { blocks: JSON.stringify(payload.blocks) } : {}),
        },
        "Bearer " + token,
      );
      invariant(
        response.statusCode === 200 && response.body?.ok === true,
        "installed Slack send helper failed against fake Slack API",
      );
      return response.body;
    },
  },
};
const sendResult = await sendMessageSlack(allowedPrepared.replyTarget, proofText, {
  cfg,
  token,
  client: fakeClient,
  accountId: "default",
});
invariant(sendResult.channelId === channelId, "sendMessageSlack returned the wrong channel");
console.log(
  JSON.stringify({
    ok: true,
    proof:
      proofApiKind === "pipeline-runtime"
        ? "openclaw-pipeline-runtime"
        : "openclaw-private-helper",
    allowedReplyTarget: allowedPrepared.replyTarget,
    deniedPrepared: deniedPrepared === null,
    deniedFeedbackMethod: deniedFeedback.method,
    deniedFeedbackCount: senderFeedbackCalls.length,
    messageId: sendResult.messageId,
    channelId: sendResult.channelId,
  }),
);
`;

export function parseInstalledSlackProof(stdout: string, stderr = ""): InstalledSlackRuntimeProof {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line) as Partial<InstalledSlackRuntimeProof>;
      if (
        value.ok === true &&
        (value.proof === "openclaw-pipeline-runtime" ||
          value.proof === "openclaw-private-helper") &&
        value.deniedPrepared === true &&
        value.deniedFeedbackMethod === "chat.postEphemeral" &&
        value.deniedFeedbackCount === 1 &&
        typeof value.allowedReplyTarget === "string" &&
        typeof value.channelId === "string" &&
        typeof value.messageId === "string"
      ) {
        return value as InstalledSlackRuntimeProof;
      }
    } catch {
      // Module discovery can emit non-JSON diagnostics before the proof record.
    }
  }
  const diagnostics = [
    stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
    stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  throw new Error(
    `installed Slack runtime proof did not emit a valid result:\n${
      diagnostics || "stdout and stderr were empty"
    }`,
  );
}

export async function runInstalledSlackRuntimeProof(
  sandbox: SandboxClient,
  fakeSlack: FakeDockerApi,
  allowedUser: string,
  redactionValues: string[],
): Promise<InstalledSlackRuntimeProof> {
  const result = await runSandboxNode(sandbox, SLACK_INSTALLED_RUNTIME_PROOF_SOURCE, {
    artifactName: "installed-slack-runtime-proof",
    env: {
      FAKE_SLACK_API_PORT: fakeSlack.port,
      SLACK_ALLOWED_USER: allowedUser,
      SLACK_DENIED_USER: "U999DENIED",
    },
    redactionValues,
    timeoutMs: 120_000,
  });
  expectExitZero(result, "installed OpenClaw Slack runtime proof");
  return parseInstalledSlackProof(result.stdout, result.stderr);
}
