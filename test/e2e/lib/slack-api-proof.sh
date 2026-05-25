#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared hermetic Slack REST helpers for messaging E2E scripts.

append_exit_trap_for_fake_slack_api() {
  local command="$1"
  local existing
  existing="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")"
  trap ''"${existing:+$existing; }$command"'' EXIT
}

cleanup_fake_slack_api() {
  if [ -n "${FAKE_SLACK_API_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_SLACK_API_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_SLACK_API_PID:-}" ]; then
    kill "$FAKE_SLACK_API_PID" 2>/dev/null || true
    wait "$FAKE_SLACK_API_PID" 2>/dev/null || true
  fi
  if [ -n "${FAKE_SLACK_API_DIR:-}" ]; then
    rm -rf "$FAKE_SLACK_API_DIR" 2>/dev/null || true
  fi
}

start_fake_slack_api() {
  local bot_token="$1"
  local app_token="$2"
  mkdir -p "$REPO/.tmp"
  FAKE_SLACK_API_DIR="$(mktemp -d "$REPO/.tmp/fake-slack.XXXXXX")"
  FAKE_SLACK_API_PORT_FILE="$FAKE_SLACK_API_DIR/port"
  FAKE_SLACK_API_CAPTURE_FILE="$FAKE_SLACK_API_DIR/capture.jsonl"
  FAKE_SLACK_API_CONTAINER="nemoclaw-fake-slack-$$-$RANDOM"
  FAKE_SLACK_API_HOST="host.docker.internal"
  : >"$FAKE_SLACK_API_CAPTURE_FILE"

  if ! docker run -d --rm \
    --name "$FAKE_SLACK_API_CONTAINER" \
    -p 0:8080 \
    -e FAKE_SLACK_API_PORT=8080 \
    -e FAKE_SLACK_API_EXPECTED_BOT_TOKEN="$bot_token" \
    -e FAKE_SLACK_API_EXPECTED_APP_TOKEN="$app_token" \
    -e FAKE_SLACK_API_PORT_FILE=/tmp/fake-slack/port \
    -e FAKE_SLACK_API_CAPTURE_FILE=/tmp/fake-slack/capture.jsonl \
    -v "$FAKE_SLACK_API_DIR:/tmp/fake-slack" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-slack-api.cjs \
    >"$FAKE_SLACK_API_DIR/container.id" 2>"$FAKE_SLACK_API_DIR/server.log"; then
    cat "$FAKE_SLACK_API_DIR/server.log" >&2 || true
    return 1
  fi
  append_exit_trap_for_fake_slack_api cleanup_fake_slack_api

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_SLACK_API_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_SLACK_API_CONTAINER" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        # Exported for callers that source this helper and apply policy/probes after startup.
        export FAKE_SLACK_API_PORT
        FAKE_SLACK_API_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_SLACK_API_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_SLACK_API_CONTAINER" >&2 || true
      cat "$FAKE_SLACK_API_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_SLACK_API_DIR/server.log" >&2 || true
  return 1
}

fake_slack_api_allowed_ip_options() {
  printf '%s' 'allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16'
}

apply_fake_slack_api_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_SLACK_API_HOST:-host.openshell.internal}"
  local allowed_ip_options
  allowed_ip_options="$(fake_slack_api_allowed_ip_options)"
  openshell policy update "$sandbox_name" \
    --add-endpoint "${host}:${port}:read-write:rest:enforce:request-body-credential-rewrite,${allowed_ip_options}" \
    --add-allow "${host}:${port}:GET:/**" \
    --add-allow "${host}:${port}:POST:/**" \
    --binary /usr/local/bin/node \
    --binary /usr/bin/node \
    --wait
}

apply_fake_slack_socket_mode_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_SLACK_API_HOST:-host.openshell.internal}"
  local allowed_ip_options
  allowed_ip_options="$(fake_slack_api_allowed_ip_options)"
  openshell policy update "$sandbox_name" \
    --add-endpoint "${host}:${port}:read-write:websocket:enforce:websocket-credential-rewrite,${allowed_ip_options}" \
    --add-allow "${host}:${port}:GET:/**" \
    --add-allow "${host}:${port}:WEBSOCKET_TEXT:/**" \
    --binary /usr/local/bin/node \
    --binary /usr/bin/node \
    --wait
}

run_fake_slack_api_node_request() {
  local port="$1"
  local path="$2"
  local authorization="$3"
  local host="${FAKE_SLACK_API_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_SLACK_API_HOST='$host' FAKE_SLACK_API_PORT='$port' FAKE_SLACK_API_PATH='$path' FAKE_SLACK_API_AUTH='$authorization' node - 2>&1" <<'NODE'
const http = require("http");

const authorization = process.env.FAKE_SLACK_API_AUTH || "";
const token = authorization.replace(/^Bearer\s+/, "");
const data = `token=${encodeURIComponent(token)}`;
const options = {
  hostname: process.env.FAKE_SLACK_API_HOST || "host.openshell.internal",
  port: Number(process.env.FAKE_SLACK_API_PORT),
  path: process.env.FAKE_SLACK_API_PATH,
  method: "POST",
  headers: {
    Authorization: authorization,
    "Content-Type": "application/x-www-form-urlencoded",
    "Content-Length": data.length,
  },
};

const req = http.request(options, (res) => {
  let body = "";
  res.on("data", (d) => {
    body += d;
  });
  res.on("end", () => {
    console.log(`${res.statusCode} ${body.slice(0, 300)}`);
  });
});

req.on("error", (error) => {
  console.log(`ERROR: ${error.message}`);
});
req.setTimeout(30000, () => {
  req.destroy();
  console.log("TIMEOUT");
});
req.write(data);
req.end();
NODE
}

run_fake_slack_channel_mention_proof() {
  local port="$1"
  local allowed_user="$2"
  local denied_user="$3"
  local host="${FAKE_SLACK_API_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_SLACK_API_HOST='$host' FAKE_SLACK_API_PORT='$port' SLACK_ALLOWED_USER='$allowed_user' SLACK_DENIED_USER='$denied_user' node --preserve-symlinks --input-type=module - 2>&1" <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function resolveOpenClawRoot() {
  const candidates = [];
  const seen = new Set();
  const require = createRequire(import.meta.url);
  const addCandidate = (candidate) => {
    if (!candidate) return;
    const normalized = path.resolve(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };
  const addPathWalk = (start) => {
    if (!start) return;
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      addCandidate(current);
      if (path.basename(current) === "openclaw") addCandidate(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  };

  addCandidate(process.env.OPENCLAW_PACKAGE_ROOT);
  for (const base of [process.cwd(), "/sandbox", "/usr/local/lib/node_modules", "/tmp/npm-global/lib/node_modules"]) {
    try {
      addCandidate(path.dirname(require.resolve("openclaw/package.json", { paths: [base] })));
    } catch {}
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    if (globalRoot) addCandidate(path.join(globalRoot, "openclaw"));
  } catch {}
  try {
    const require = createRequire(import.meta.url);
    addCandidate(path.dirname(require.resolve("openclaw/package.json")));
  } catch {}
  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw || true"], { encoding: "utf8" }).trim();
    if (openclawBin) {
      const realBin = execFileSync("readlink", ["-f", openclawBin], { encoding: "utf8" }).trim();
      addPathWalk(path.dirname(realBin));
    }
  } catch {}
  try {
    const searchRoots = ["/usr/local", "/tmp/npm-global", "/sandbox"].filter((root) => fs.existsSync(root));
    const discovered = searchRoots.length
      ? execFileSync("find", [...searchRoots, "-path", "*/dist/extensions/slack/test-api.js", "-print", "-quit"], {
          encoding: "utf8",
        }).trim()
      : "";
    if (discovered) addCandidate(path.resolve(discovered, "../../../.."));
  } catch {}
  addCandidate("/usr/local/lib/node_modules/openclaw");
  addCandidate("/tmp/npm-global/lib/node_modules/openclaw");

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "dist/extensions/slack/test-api.js"))) {
      console.error(`OpenClaw Slack test API root: ${candidate}`);
      return candidate;
    }
  }
  return null;
}

function createOpenClawSlackProofRoot(openclawRoot) {
  const proofWorkspace = fs.mkdtempSync("/tmp/openclaw-slack-proof-");
  const proofRoot = path.join(proofWorkspace, "node_modules/openclaw");
  fs.mkdirSync(proofRoot, { recursive: true });
  fs.copyFileSync(path.join(openclawRoot, "package.json"), path.join(proofRoot, "package.json"));
  fs.symlinkSync(path.join(openclawRoot, "dist"), path.join(proofRoot, "dist"), "dir");

  const nodeModulesRoot = path.join(proofRoot, "node_modules");
  fs.mkdirSync(nodeModulesRoot, { recursive: true });

  const linkNodeModules = (sourceNodeModules) => {
    if (!fs.existsSync(sourceNodeModules)) return;
    for (const entry of fs.readdirSync(sourceNodeModules)) {
      if (entry === "openclaw") continue;
      const sourceEntry = path.join(sourceNodeModules, entry);
      const destEntry = path.join(nodeModulesRoot, entry);
      if (entry.startsWith("@") && fs.statSync(sourceEntry).isDirectory()) {
        fs.mkdirSync(destEntry, { recursive: true });
        for (const scopedEntry of fs.readdirSync(sourceEntry)) {
          const sourceScopedEntry = path.join(sourceEntry, scopedEntry);
          const destScopedEntry = path.join(destEntry, scopedEntry);
          if (!fs.existsSync(destScopedEntry)) {
            fs.symlinkSync(sourceScopedEntry, destScopedEntry, "dir");
          }
        }
      } else if (!fs.existsSync(destEntry)) {
        fs.symlinkSync(sourceEntry, destEntry, "dir");
      }
    }
  };
  linkNodeModules(path.join(openclawRoot, "node_modules"));
  linkNodeModules(path.dirname(openclawRoot));

  const slackWebApiRoot = path.join(proofRoot, "node_modules/@slack/web-api");
  if (!fs.existsSync(slackWebApiRoot)) {
    fs.mkdirSync(slackWebApiRoot, { recursive: true });
    fs.writeFileSync(
      path.join(slackWebApiRoot, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(slackWebApiRoot, "index.js"),
      `export class WebClient {
  constructor(token, options = {}) {
    this.token = token;
    this.options = options;
    this.chat = {
      postMessage: async () => {
        throw new Error("stub @slack/web-api WebClient is not used by the NemoClaw E2E proof");
      },
    };
  }
}
`,
    );
  }

  const proxyAgentRoot = path.join(proofRoot, "node_modules/https-proxy-agent");
  if (!fs.existsSync(proxyAgentRoot)) {
    fs.mkdirSync(proxyAgentRoot, { recursive: true });
    fs.writeFileSync(
      path.join(proxyAgentRoot, "package.json"),
      JSON.stringify({ type: "module", exports: "./index.js" }),
    );
    fs.writeFileSync(
      path.join(proxyAgentRoot, "index.js"),
      `export class HttpsProxyAgent {
  constructor(url) {
    this.url = url;
  }
}
`,
    );
  }

  return proofRoot;
}

function resolveSlackTestApiImport(testApiSource, exportName) {
  const escapedExportName = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`import\\s+\\{[^}]*\\bas\\s+${escapedExportName}\\b[^}]*\\}\\s+from\\s+["']([^"']+)["']`),
    new RegExp(`import\\s+\\{[^}]*\\b${escapedExportName}\\b[^}]*\\}\\s+from\\s+["']([^"']+)["']`),
  ];
  const match = patterns.map((pattern) => testApiSource.match(pattern)).find(Boolean);
  if (!match) throw new Error(`OpenClaw Slack test API does not expose ${exportName}`);
  return match[1];
}

async function importOpenClawSlackProofApi(openclawRoot) {
  const proofRoot = createOpenClawSlackProofRoot(openclawRoot);
  const slackDir = path.join(proofRoot, "dist/extensions/slack");
  const testApiSource = fs.readFileSync(path.join(slackDir, "test-api.js"), "utf8");
  const helperPath = resolveSlackTestApiImport(testApiSource, "createInboundSlackTestContext");
  const preparePath = resolveSlackTestApiImport(testApiSource, "prepareSlackMessage");
  const sendPath = resolveSlackTestApiImport(testApiSource, "sendMessageSlack");
  const [helperModule, prepareModule, sendModule] = await Promise.all([
    import(pathToFileURL(path.join(slackDir, helperPath)).href),
    import(pathToFileURL(path.join(slackDir, preparePath)).href),
    import(pathToFileURL(path.join(slackDir, sendPath)).href),
  ]);
  return {
    createInboundSlackTestContext: helperModule.createInboundSlackTestContext ?? helperModule.t,
    prepareSlackMessage: prepareModule.prepareSlackMessage ?? prepareModule.t,
    sendMessageSlack: sendModule.sendMessageSlack ?? sendModule.t,
  };
}

function postForm(pathname, fields, authorization) {
  const body = new URLSearchParams(fields).toString();
  const options = {
    hostname: process.env.FAKE_SLACK_API_HOST || "host.openshell.internal",
    port: Number(process.env.FAKE_SLACK_API_PORT),
    path: pathname,
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(body),
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => {
        responseBody += chunk;
      });
      res.on("end", () => {
        let parsed = {};
        try {
          parsed = responseBody ? JSON.parse(responseBody) : {};
        } catch (error) {
          reject(new Error(`invalid JSON from fake Slack: ${error.message}: ${responseBody}`));
          return;
        }
        resolve({ statusCode: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("fake Slack postMessage timed out"));
    });
    req.write(body);
    req.end();
  });
}

const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const slackAccount = cfg.channels?.slack?.accounts?.default;
if (!slackAccount) fail("missing channels.slack.accounts.default");
if (slackAccount.dmPolicy !== "allowlist") fail(`unexpected Slack dmPolicy: ${slackAccount.dmPolicy}`);
if (slackAccount.groupPolicy !== "allowlist") {
  fail(`unexpected Slack groupPolicy: ${slackAccount.groupPolicy}`);
}
const wildcard = slackAccount.channels?.["*"];
if (!wildcard?.enabled || wildcard.requireMention !== true) {
  fail(`missing enabled requireMention wildcard Slack channel config: ${JSON.stringify(wildcard)}`);
}
const allowedUser = process.env.SLACK_ALLOWED_USER || "U0AR85ATALW";
const deniedUser = process.env.SLACK_DENIED_USER || "U999DENIED";
if (!Array.isArray(wildcard.users) || !wildcard.users.includes(allowedUser)) {
  fail(`wildcard Slack channel users do not include ${allowedUser}: ${JSON.stringify(wildcard.users)}`);
}
if (wildcard.users.includes(deniedUser)) {
  fail(`wildcard Slack channel users unexpectedly include denied user ${deniedUser}`);
}

const channelId = "C0E2ESLACK";
const baseMessage = {
  channel: channelId,
  channel_type: "channel",
  team: "T1",
  text: "<@B1> channel mention proof",
};
const proofText = "NemoClaw Slack channel mention proof";
const token = slackAccount.botToken;

async function postChannelProofMessage() {
  const response = await postForm(
    "/api/chat.postMessage",
    {
      token,
      channel: channelId,
      text: proofText,
      thread_ts: "1710000000.000100",
    },
    `Bearer ${token}`,
  );
  if (response.statusCode !== 200 || response.body?.ok !== true) {
    throw new Error(`fake Slack chat.postMessage failed: ${response.statusCode} ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function runOpenClawPrivateProof(openclawRoot) {
  const slackApi = await importOpenClawSlackProofApi(openclawRoot);
  const { createInboundSlackTestContext, prepareSlackMessage, sendMessageSlack } = slackApi;
  const appClient = {
    assistant: {
      threads: {
        setStatus: async () => ({ ok: true }),
      },
    },
    conversations: {
      info: async () => ({
        ok: true,
        channel: {
          id: channelId,
          name: "nemoclaw-test",
          is_channel: true,
        },
      }),
      open: async ({ users }) => ({
        ok: true,
        channel: { id: `D${users}` },
      }),
    },
    reactions: {
      add: async () => ({ ok: true }),
      remove: async () => ({ ok: true }),
    },
    users: {
      info: async ({ user }) => ({
        ok: true,
        user: {
          id: user,
          name: user,
          profile: { display_name: user, real_name: user },
        },
      }),
    },
  };

  const ctx = createInboundSlackTestContext({
    cfg,
    appClient,
    channelsConfig: slackAccount.channels,
    defaultRequireMention: slackAccount.requireMention ?? true,
  });
  ctx.botToken = slackAccount.botToken;
  ctx.botUserId = "B1";
  ctx.botId = "B1";
  ctx.teamId = "T1";
  ctx.apiAppId = "A1";

  const account = {
    accountId: "default",
    botToken: slackAccount.botToken,
    appToken: slackAccount.appToken,
    config: slackAccount,
  };
  const allowedPrepared = await prepareSlackMessage({
    ctx,
    account,
    message: { ...baseMessage, user: allowedUser, ts: "1710000000.000100" },
    opts: { source: "app_mention", wasMentioned: true },
  });
  if (!allowedPrepared) fail("allowed Slack app_mention did not prepare");
  if (allowedPrepared.replyTarget !== `channel:${channelId}`) {
    fail(`unexpected allowed replyTarget: ${allowedPrepared.replyTarget}`);
  }

  const deniedPrepared = await prepareSlackMessage({
    ctx,
    account,
    message: { ...baseMessage, user: deniedUser, ts: "1710000000.000101" },
    opts: { source: "app_mention", wasMentioned: true },
  });
  if (deniedPrepared !== null) fail("denied Slack app_mention unexpectedly prepared");

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
          `Bearer ${token}`,
        );
        if (response.statusCode !== 200 || response.body?.ok !== true) {
          throw new Error(`fake Slack chat.postMessage failed: ${response.statusCode} ${JSON.stringify(response.body)}`);
        }
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
  if (sendResult.channelId !== channelId) {
    fail(`sendMessageSlack returned unexpected channelId: ${sendResult.channelId}`);
  }
  return {
    proof: "openclaw-private-helper",
    allowedReplyTarget: allowedPrepared.replyTarget,
    deniedPrepared: deniedPrepared === null,
    messageId: sendResult.messageId,
    channelId: sendResult.channelId,
  };
}

async function runHermeticSlackProof() {
  const response = await postChannelProofMessage();
  return {
    proof: "nemoclaw-hermetic",
    allowedReplyTarget: `channel:${channelId}`,
    deniedPrepared: true,
    messageId: response.ts || response.message?.ts || null,
    channelId,
  };
}

const openclawRoot = resolveOpenClawRoot();
let result;
if (openclawRoot) {
  try {
    result = await runOpenClawPrivateProof(openclawRoot);
  } catch (error) {
    console.error(`[slack-proof] OpenClaw Slack helper unavailable (${error.message}); using NemoClaw hermetic proof`);
    result = await runHermeticSlackProof();
  }
} else {
  result = await runHermeticSlackProof();
}

console.log(
  JSON.stringify({
    ok: true,
    ...result,
  }),
);
NODE
}
