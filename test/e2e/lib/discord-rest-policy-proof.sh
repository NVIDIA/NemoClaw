#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared hermetic Discord REST helpers for policy/binary-whitelist E2E checks.

append_exit_trap_for_fake_discord_rest_api() {
  local command="$1"
  local existing
  existing="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")"
  trap ''"${existing:+$existing; }$command"'' EXIT
}

cleanup_fake_discord_rest_api() {
  if [ -n "${FAKE_DISCORD_REST_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_DISCORD_REST_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_DISCORD_REST_DIR:-}" ]; then
    rm -rf "$FAKE_DISCORD_REST_DIR" 2>/dev/null || true
  fi
}

cleanup_fake_discord_message_api() {
  if [ -n "${FAKE_DISCORD_MESSAGE_API_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_DISCORD_MESSAGE_API_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_DISCORD_MESSAGE_API_DIR:-}" ]; then
    rm -rf "$FAKE_DISCORD_MESSAGE_API_DIR" 2>/dev/null || true
  fi
}

start_fake_discord_rest_api() {
  if ! command -v openssl >/dev/null 2>&1; then
    echo "openssl is required for fake Discord REST TLS cert generation" >&2
    return 1
  fi

  mkdir -p "$REPO/.tmp"
  FAKE_DISCORD_REST_DIR="$(mktemp -d "$REPO/.tmp/fake-discord-rest.XXXXXX")"
  FAKE_DISCORD_REST_PORT_FILE="$FAKE_DISCORD_REST_DIR/port"
  FAKE_DISCORD_REST_CAPTURE_FILE="$FAKE_DISCORD_REST_DIR/capture.jsonl"
  FAKE_DISCORD_REST_KEY_PATH="$FAKE_DISCORD_REST_DIR/key.pem"
  FAKE_DISCORD_REST_CERT_PATH="$FAKE_DISCORD_REST_DIR/cert.pem"
  FAKE_DISCORD_REST_CONTAINER="nemoclaw-fake-discord-rest-$$-$RANDOM"
  FAKE_DISCORD_REST_HOST="host.docker.internal"
  : >"$FAKE_DISCORD_REST_CAPTURE_FILE"
  append_exit_trap_for_fake_discord_rest_api cleanup_fake_discord_rest_api

  if ! openssl req -x509 -newkey rsa:2048 \
    -keyout "$FAKE_DISCORD_REST_KEY_PATH" \
    -out "$FAKE_DISCORD_REST_CERT_PATH" \
    -days 7 \
    -nodes \
    -subj "/CN=host.docker.internal" \
    -addext "subjectAltName=DNS:host.docker.internal,DNS:host.openshell.internal" \
    >/dev/null 2>&1; then
    echo "failed to generate fake Discord REST TLS certificate" >&2
    return 1
  fi

  if ! docker run -d --rm \
    --name "$FAKE_DISCORD_REST_CONTAINER" \
    -p 0:8443 \
    -e FAKE_DISCORD_REST_PORT=8443 \
    -e FAKE_DISCORD_REST_KEY_PATH=/tmp/fake-discord-rest/key.pem \
    -e FAKE_DISCORD_REST_CERT_PATH=/tmp/fake-discord-rest/cert.pem \
    -e FAKE_DISCORD_REST_PORT_FILE=/tmp/fake-discord-rest/port \
    -e FAKE_DISCORD_REST_CAPTURE_FILE=/tmp/fake-discord-rest/capture.jsonl \
    -v "$FAKE_DISCORD_REST_DIR:/tmp/fake-discord-rest" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-discord-rest-api.cjs \
    >"$FAKE_DISCORD_REST_DIR/container.id" 2>"$FAKE_DISCORD_REST_DIR/server.log"; then
    cat "$FAKE_DISCORD_REST_DIR/server.log" >&2 || true
    return 1
  fi

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_DISCORD_REST_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_DISCORD_REST_CONTAINER" 8443/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        export FAKE_DISCORD_REST_PORT
        FAKE_DISCORD_REST_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_DISCORD_REST_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_DISCORD_REST_CONTAINER" >&2 || true
      cat "$FAKE_DISCORD_REST_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_DISCORD_REST_DIR/server.log" >&2 || true
  return 1
}

start_fake_discord_message_api() {
  local token="$1"
  mkdir -p "$REPO/.tmp"
  FAKE_DISCORD_MESSAGE_API_DIR="$(mktemp -d "$REPO/.tmp/fake-discord-message.XXXXXX")"
  FAKE_DISCORD_MESSAGE_API_PORT_FILE="$FAKE_DISCORD_MESSAGE_API_DIR/port"
  FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE="$FAKE_DISCORD_MESSAGE_API_DIR/capture.jsonl"
  FAKE_DISCORD_MESSAGE_API_CONTAINER="nemoclaw-fake-discord-message-$$-$RANDOM"
  FAKE_DISCORD_MESSAGE_API_HOST="host.docker.internal"
  : >"$FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE"

  if ! docker run -d --rm \
    --name "$FAKE_DISCORD_MESSAGE_API_CONTAINER" \
    -p 0:8080 \
    -e FAKE_DISCORD_MESSAGE_API_PORT=8080 \
    -e FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN="$token" \
    -e FAKE_DISCORD_MESSAGE_API_PORT_FILE=/tmp/fake-discord-message/port \
    -e FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE=/tmp/fake-discord-message/capture.jsonl \
    -v "$FAKE_DISCORD_MESSAGE_API_DIR:/tmp/fake-discord-message" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-discord-message-api.cjs \
    >"$FAKE_DISCORD_MESSAGE_API_DIR/container.id" 2>"$FAKE_DISCORD_MESSAGE_API_DIR/server.log"; then
    cat "$FAKE_DISCORD_MESSAGE_API_DIR/server.log" >&2 || true
    return 1
  fi
  append_exit_trap_for_fake_discord_rest_api cleanup_fake_discord_message_api

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_DISCORD_MESSAGE_API_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_DISCORD_MESSAGE_API_CONTAINER" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        export FAKE_DISCORD_MESSAGE_API_PORT
        FAKE_DISCORD_MESSAGE_API_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_DISCORD_MESSAGE_API_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_DISCORD_MESSAGE_API_CONTAINER" >&2 || true
      cat "$FAKE_DISCORD_MESSAGE_API_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_DISCORD_MESSAGE_API_DIR/server.log" >&2 || true
  return 1
}

apply_fake_discord_rest_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_DISCORD_REST_HOST:-host.openshell.internal}"
  local preset_file
  preset_file="$FAKE_DISCORD_REST_DIR/policy.yaml"

  cat >"$preset_file" <<EOF_POLICY
preset:
  name: fake-discord-rest
  description: "Hermetic Discord-shaped HTTPS REST endpoint for binary whitelist E2E"

network_policies:
  fake_discord_rest:
    name: fake_discord_rest
    endpoints:
      # L4 TLS pass-through keeps the proof focused on CONNECT-time binary
      # authorization: Node is allowed to tunnel to the fake HTTPS REST
      # server, while curl must be denied before any upstream request arrives.
      - host: $host
        port: $port
        access: full
        tls: skip
        allowed_ips:
          - 10.0.0.0/8
          - 172.16.0.0/12
          - 192.168.0.0/16
    binaries:
      - { path: /usr/local/bin/node }
      - { path: /usr/bin/node }
EOF_POLICY

  NEMOCLAW_NON_INTERACTIVE=1 nemoclaw "$sandbox_name" policy-add --from-file "$preset_file" --yes >/tmp/nemoclaw-fake-discord-rest-policy.log 2>&1 || {
    cat /tmp/nemoclaw-fake-discord-rest-policy.log >&2 || true
    return 1
  }
}

fake_discord_message_api_allowed_ip_options() {
  printf '%s' 'allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16'
}

apply_fake_discord_message_api_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_DISCORD_MESSAGE_API_HOST:-host.openshell.internal}"
  local allowed_ip_options
  allowed_ip_options="$(fake_discord_message_api_allowed_ip_options)"
  openshell policy update "$sandbox_name" \
    --add-endpoint "${host}:${port}:read-write:rest:enforce:request-body-credential-rewrite,${allowed_ip_options}" \
    --add-allow "${host}:${port}:GET:/**" \
    --add-allow "${host}:${port}:POST:/**" \
    --binary /usr/local/bin/node \
    --binary /usr/bin/node \
    --wait
}

run_fake_discord_plugin_send_proof() {
  local port="$1"
  local channel_id="$2"
  local message="$3"
  local host="${FAKE_DISCORD_MESSAGE_API_HOST:-host.openshell.internal}"
  local message_b64
  message_b64=$(printf '%s' "$message" | base64 | tr -d '\n')

  sandbox_exec_stdin "FAKE_DISCORD_MESSAGE_API_HOST='$host' FAKE_DISCORD_MESSAGE_API_PORT='$port' FAKE_DISCORD_MESSAGE_CHANNEL_ID='$channel_id' FAKE_DISCORD_MESSAGE_TEXT_B64='$message_b64' node --preserve-symlinks --input-type=module - 2>&1" <<'NODE'
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

function decodeBase64(value) {
  return Buffer.from(value || "", "base64").toString("utf8");
}

function addPathWalk(candidates, seen, start) {
  if (!start) return;
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (!seen.has(current)) {
      seen.add(current);
      candidates.push(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function resolveDiscordSendApiPath() {
  const require = createRequire(import.meta.url);
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };

  for (const base of [process.cwd(), "/sandbox", "/usr/local/lib/node_modules", "/tmp/npm-global/lib/node_modules"]) {
    try {
      add(path.join(path.dirname(require.resolve("@openclaw/discord/package.json", { paths: [base] })), "dist/runtime-api.send.js"));
    } catch {}
    try {
      add(path.join(path.dirname(require.resolve("openclaw/package.json", { paths: [base] })), "dist/extensions/discord/runtime-api.send.js"));
    } catch {}
  }

  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    add(path.join(globalRoot, "@openclaw/discord/dist/runtime-api.send.js"));
    add(path.join(globalRoot, "openclaw/dist/extensions/discord/runtime-api.send.js"));
  } catch {}

  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw || true"], { encoding: "utf8" }).trim();
    if (openclawBin) {
      const realBin = execFileSync("readlink", ["-f", openclawBin], { encoding: "utf8" }).trim();
      const walk = [];
      const walkSeen = new Set();
      addPathWalk(walk, walkSeen, path.dirname(realBin));
      for (const root of walk) {
        add(path.join(root, "node_modules/@openclaw/discord/dist/runtime-api.send.js"));
        add(path.join(root, "dist/extensions/discord/runtime-api.send.js"));
      }
    }
  } catch {}

  try {
    const searchRoots = ["/usr/local", "/tmp/npm-global", "/sandbox"].filter((root) => fs.existsSync(root));
    if (searchRoots.length) {
      const discovered = execFileSync("find", [
        ...searchRoots,
        "(",
        "-path",
        "*/node_modules/@openclaw/discord/dist/runtime-api.send.js",
        "-o",
        "-path",
        "*/node_modules/openclaw/dist/extensions/discord/runtime-api.send.js",
        ")",
        "-print",
        "-quit",
      ], { encoding: "utf8" }).trim();
      add(discovered);
    }
  } catch {}

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function requestFakeDiscord(method, apiPath, body, token) {
  const payload = body === undefined ? "" : JSON.stringify(body.body ?? body);
  const options = {
    hostname: process.env.FAKE_DISCORD_MESSAGE_API_HOST || "host.openshell.internal",
    port: Number(process.env.FAKE_DISCORD_MESSAGE_API_PORT),
    path: `/api/v10${apiPath}`,
    method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "User-Agent": "nemoclaw-openclaw-discord-plugin-e2e",
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
          reject(new Error(`invalid JSON from fake Discord: ${error.message}: ${responseBody}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`fake Discord returned HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.rawError = parsed;
          reject(err);
          return;
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("fake Discord message API timed out"));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

const sendApiPath = resolveDiscordSendApiPath();
if (!sendApiPath) fail("could not find installed OpenClaw Discord runtime-api.send.js");

const { sendMessageDiscord } = await import(pathToFileURL(sendApiPath).href);
if (typeof sendMessageDiscord !== "function") fail("installed Discord runtime API does not export sendMessageDiscord");

const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const account = cfg.channels?.discord?.accounts?.default;
if (!account?.token) fail("missing channels.discord.accounts.default.token in openclaw.json");

const channelId = process.env.FAKE_DISCORD_MESSAGE_CHANNEL_ID || "420000000000000123";
const text = decodeBase64(process.env.FAKE_DISCORD_MESSAGE_TEXT_B64);
const token = account.token;
const rest = {
  get: (apiPath) => requestFakeDiscord("GET", apiPath, undefined, token),
  post: (apiPath, data) => requestFakeDiscord("POST", apiPath, data, token),
  patch: (apiPath, data) => requestFakeDiscord("PATCH", apiPath, data, token),
  put: (apiPath, data) => requestFakeDiscord("PUT", apiPath, data, token),
  delete: (apiPath, data) => requestFakeDiscord("DELETE", apiPath, data, token),
};

const result = await sendMessageDiscord(`channel:${channelId}`, text, {
  cfg,
  accountId: "default",
  rest,
});

console.log(JSON.stringify({
  ok: true,
  proof: "openclaw-discord-runtime-send",
  channelId: result.channelId ?? channelId,
  messageId: result.messageId ?? result.platformMessageIds?.[0] ?? null,
}));
NODE
}

check_fake_discord_message_capture() {
  local expected_channel="$1"
  local expected_text="$2"
  node - "$FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE" "$expected_channel" "$expected_text" <<'NODE'
const fs = require("fs");
const [file, expectedChannel, expectedText] = process.argv.slice(2);
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.event === "request" && row.method === "POST" && row.path.endsWith("/messages"));
const last = rows.at(-1);
if (!last) {
  console.log("NO_MESSAGE_REQUEST");
  process.exit(2);
}
if (last.tokenMatchesExpected !== true) {
  console.log("BAD_TOKEN_REWRITE");
  process.exit(3);
}
if (last.tokenLooksPlaceholder) {
  console.log("PLACEHOLDER_LEAK");
  process.exit(4);
}
if (last.channelId !== expectedChannel) {
  console.log(`BAD_CHANNEL ${last.channelId}`);
  process.exit(5);
}
if (last.content !== expectedText) {
  console.log(`BAD_TEXT ${last.content}`);
  process.exit(6);
}
console.log("OK");
NODE
}

run_fake_discord_rest_node_request() {
  local port="$1"
  local path="$2"
  local host="${FAKE_DISCORD_REST_HOST:-host.openshell.internal}"
  sandbox_exec_stdin "FAKE_DISCORD_REST_HOST='$host' FAKE_DISCORD_REST_PORT='$port' FAKE_DISCORD_REST_PATH='$path' node - 2>&1" <<'NODE'
const https = require("https");

const options = {
  hostname: process.env.FAKE_DISCORD_REST_HOST || "host.openshell.internal",
  port: Number(process.env.FAKE_DISCORD_REST_PORT),
  path: process.env.FAKE_DISCORD_REST_PATH || "/api/v10/gateway",
  method: "GET",
  rejectUnauthorized: false,
  headers: { "User-Agent": "nemoclaw-e2e-node" },
};

const req = https.request(options, (res) => {
  let body = "";
  res.on("data", (chunk) => {
    body += chunk;
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
req.end();
NODE
}

run_fake_discord_rest_curl_request() {
  local port="$1"
  local host="${FAKE_DISCORD_REST_HOST:-host.openshell.internal}"
  sandbox_exec "set +e
rm -f /tmp/nemoclaw-fake-discord-curl.err /tmp/nemoclaw-fake-discord-curl.body
curl -k -v --max-time 15 https://$host:$port/api/v10/gateway \
  -A nemoclaw-e2e-curl \
  -o /tmp/nemoclaw-fake-discord-curl.body \
  2>/tmp/nemoclaw-fake-discord-curl.err
rc=\$?
printf 'RC=%s\n' \"\$rc\"
grep -E 'Uses proxy|CONNECT .* HTTP|HTTP/1\\.[01] 403|CONNECT tunnel failed|Connection established|policy_denied|Forbidden' /tmp/nemoclaw-fake-discord-curl.err /tmp/nemoclaw-fake-discord-curl.body 2>/dev/null || true
" 2>/dev/null || true
}

fake_discord_rest_capture_counts() {
  node - "$FAKE_DISCORD_REST_CAPTURE_FILE" <<'NODE'
const fs = require("fs");
const file = process.argv[2];
const rows = fs.readFileSync(file, "utf8").trim().split(/\n+/).filter(Boolean).map((line) => JSON.parse(line));
const requests = rows.filter((row) => row.event === "request");
const node = requests.filter((row) => String(row.userAgent || "").includes("nemoclaw-e2e-node")).length;
const curl = requests.filter((row) => String(row.userAgent || "").includes("nemoclaw-e2e-curl")).length;
console.log(`requests=${requests.length} node=${node} curl=${curl}`);
NODE
}
