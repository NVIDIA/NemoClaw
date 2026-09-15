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
  proof: "openclaw-pipeline-runtime";
  allowedReplyTarget: string;
  deniedPrepared: true;
  deniedFeedbackMethod: "chat.postEphemeral";
  deniedFeedbackCount: 1;
  messageId: string;
  channelId: string;
};

export const SLACK_RUNTIME_DISCOVERY_SOURCE = String.raw`
function addManagedNpmProjectSlackCandidates(projectsDir, addExternalCandidate) {
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const projectRoot = path.join(projectsDir, entry.name);
    let dependencies;
    try {
      dependencies = JSON.parse(
        fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"),
      ).dependencies;
    } catch {
      continue;
    }
    if (!dependencies || !Object.hasOwn(dependencies, "@openclaw/slack")) continue;
    addExternalCandidate(
      path.join(projectRoot, "node_modules", "@openclaw", "slack"),
    );
  }
}

function resolveInstalledPackageRoot(candidate) {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
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
  const openclawStateDir = process.env.OPENCLAW_STATE_DIR || "/sandbox/.openclaw";
  addExternalCandidate(path.join(openclawStateDir, "extensions", "slack"));
  addManagedNpmProjectSlackCandidates(
    path.join(openclawStateDir, "npm", "projects"),
    addExternalCandidate,
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

  for (const candidate of externalCandidates) {
    const distDir = path.join(candidate, "dist");
    const runtimeApiPath = path.join(distDir, "runtime-api.js");
    const pipelineRuntimePath = findPipelineRuntimePath(distDir);
    if (fs.existsSync(runtimeApiPath) && pipelineRuntimePath) {
      return {
        kind: "external",
        root: resolveInstalledPackageRoot(candidate),
      };
    }
  }
  for (const candidate of coreCandidates) {
    const distDir = path.join(candidate, "dist/extensions/slack");
    const runtimeApiPath = path.join(distDir, "runtime-api.js");
    const pipelineRuntimePath = findPipelineRuntimePath(distDir);
    if (fs.existsSync(runtimeApiPath) && pipelineRuntimePath) {
      return { kind: "core", root: resolveInstalledPackageRoot(candidate) };
    }
  }
  return null;
}

function findPipelineRuntimePath(slackDir) {
  try {
    return fs
      .readdirSync(slackDir)
      .filter((entry) => /^pipeline\.runtime-.*\.js$/.test(entry))
      .map((entry) => path.join(slackDir, entry))
      .sort()[0];
  } catch {
    return undefined;
  }
}

async function importProofModules(slackDir) {
  const pipelinePath = findPipelineRuntimePath(slackDir);
  if (!pipelinePath) throw new Error("OpenClaw Slack pipeline runtime not found");
  const [pipelineModule, runtimeModule] = await Promise.all([
    import(pathToFileURL(pipelinePath).href),
    import(pathToFileURL(path.join(slackDir, "runtime-api.js")).href),
  ]);
  return {
    prepareSlackMessage: pipelineModule.prepareSlackMessage,
    sendMessageSlack: runtimeModule.sendMessageSlack,
  };
}
`;

export const SLACK_INSTALLED_RUNTIME_PROOF_SOURCE = String.raw`
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

${SLACK_RUNTIME_DISCOVERY_SOURCE}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
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
const token = process.env.SLACK_BOT_TOKEN;
const appToken = process.env.SLACK_APP_TOKEN;
invariant(
  /^openshell:resolve:env:v[0-9]+_SLACK_BOT_TOKEN$/.test(token || ""),
  "missing revision-scoped SLACK_BOT_TOKEN environment placeholder",
);
invariant(
  /^openshell:resolve:env:v[0-9]+_SLACK_APP_TOKEN$/.test(appToken || ""),
  "missing revision-scoped SLACK_APP_TOKEN environment placeholder",
);

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
const slackDir = path.join(
  location.root,
  location.kind === "external" ? "dist" : "dist/extensions/slack",
);
const slackApi = await importProofModules(slackDir);
const { prepareSlackMessage, sendMessageSlack } = slackApi;
invariant(
  typeof prepareSlackMessage === "function" && typeof sendMessageSlack === "function",
  "installed OpenClaw Slack API does not expose prepareSlackMessage and sendMessageSlack",
);
const ctx = createPipelineSlackProofContext(appClient);
Object.assign(ctx, { botToken: token, botUserId: "B1", botId: "B1", teamId: "T1", apiAppId: "A1" });
const account = {
  accountId: "default",
  botToken: token,
  appToken,
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
    proof: "openclaw-pipeline-runtime",
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
        value.proof === "openclaw-pipeline-runtime" &&
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
    preserveSymlinks: false,
    redactionValues,
    timeoutMs: 120_000,
  });
  expectExitZero(result, "installed OpenClaw Slack runtime proof");
  return parseInstalledSlackProof(result.stdout, result.stderr);
}
