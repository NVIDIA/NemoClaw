#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

# Shared hermetic Telegram Bot API helpers for OpenClaw messaging E2E checks.

append_exit_trap_for_fake_telegram_api() {
  local command="$1"
  local existing
  existing="$(trap -p EXIT | sed "s/^trap -- '//;s/' EXIT$//")"
  trap ''"${existing:+$existing; }$command"'' EXIT
}

cleanup_fake_telegram_api() {
  if [ -n "${FAKE_TELEGRAM_API_CONTAINER:-}" ]; then
    docker rm -f "$FAKE_TELEGRAM_API_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ -n "${FAKE_TELEGRAM_API_DIR:-}" ]; then
    rm -rf "$FAKE_TELEGRAM_API_DIR" 2>/dev/null || true
  fi
}

start_fake_telegram_api() {
  local token="$1"
  mkdir -p "$REPO/.tmp"
  FAKE_TELEGRAM_API_DIR="$(mktemp -d "$REPO/.tmp/fake-telegram.XXXXXX")"
  FAKE_TELEGRAM_API_PORT_FILE="$FAKE_TELEGRAM_API_DIR/port"
  FAKE_TELEGRAM_API_CAPTURE_FILE="$FAKE_TELEGRAM_API_DIR/capture.jsonl"
  FAKE_TELEGRAM_API_CONTAINER="nemoclaw-fake-telegram-$$-$RANDOM"
  FAKE_TELEGRAM_API_HOST="host.docker.internal"
  : >"$FAKE_TELEGRAM_API_CAPTURE_FILE"

  if ! docker run -d --rm \
    --name "$FAKE_TELEGRAM_API_CONTAINER" \
    -p 0:8080 \
    -e FAKE_TELEGRAM_API_PORT=8080 \
    -e FAKE_TELEGRAM_API_EXPECTED_TOKEN="$token" \
    -e FAKE_TELEGRAM_API_PORT_FILE=/tmp/fake-telegram/port \
    -e FAKE_TELEGRAM_API_CAPTURE_FILE=/tmp/fake-telegram/capture.jsonl \
    -v "$FAKE_TELEGRAM_API_DIR:/tmp/fake-telegram" \
    -v "$REPO/test/e2e/lib:/opt/nemoclaw-e2e:ro" \
    node:22-bookworm-slim \
    node /opt/nemoclaw-e2e/fake-telegram-api.cjs \
    >"$FAKE_TELEGRAM_API_DIR/container.id" 2>"$FAKE_TELEGRAM_API_DIR/server.log"; then
    cat "$FAKE_TELEGRAM_API_DIR/server.log" >&2 || true
    return 1
  fi
  append_exit_trap_for_fake_telegram_api cleanup_fake_telegram_api

  for _ in $(seq 1 50); do
    if [ -s "$FAKE_TELEGRAM_API_PORT_FILE" ]; then
      local published_port
      published_port="$(docker port "$FAKE_TELEGRAM_API_CONTAINER" 8080/tcp 2>/dev/null | head -1 | sed 's/.*://')"
      if [ -n "$published_port" ]; then
        export FAKE_TELEGRAM_API_PORT
        FAKE_TELEGRAM_API_PORT="$published_port"
        return 0
      fi
    fi
    if ! docker inspect "$FAKE_TELEGRAM_API_CONTAINER" >/dev/null 2>&1; then
      docker logs "$FAKE_TELEGRAM_API_CONTAINER" >&2 || true
      cat "$FAKE_TELEGRAM_API_DIR/server.log" >&2 || true
      return 1
    fi
    sleep 0.1
  done
  cat "$FAKE_TELEGRAM_API_DIR/server.log" >&2 || true
  return 1
}

fake_telegram_api_allowed_ip_options() {
  printf '%s' 'allowed-ip=10.0.0.0/8,allowed-ip=172.16.0.0/12,allowed-ip=192.168.0.0/16'
}

apply_fake_telegram_api_policy() {
  local sandbox_name="$1"
  local port="$2"
  local host="${FAKE_TELEGRAM_API_HOST:-host.openshell.internal}"
  local allowed_ip_options
  allowed_ip_options="$(fake_telegram_api_allowed_ip_options)"
  openshell policy update "$sandbox_name" \
    --add-endpoint "${host}:${port}:read-write:rest:enforce:request-body-credential-rewrite,${allowed_ip_options}" \
    --add-allow "${host}:${port}:GET:/**" \
    --add-allow "${host}:${port}:POST:/**" \
    --binary /usr/local/bin/node \
    --binary /usr/bin/node \
    --wait
}

run_openclaw_telegram_mock_send() {
  local port="$1"
  local target="$2"
  local message="$3"
  local host="${FAKE_TELEGRAM_API_HOST:-host.openshell.internal}"
  local target_b64 message_b64
  target_b64=$(printf '%s' "$target" | base64 | tr -d '\n')
  message_b64=$(printf '%s' "$message" | base64 | tr -d '\n')

  sandbox_exec_stdin "FAKE_TELEGRAM_API_HOST='$host' FAKE_TELEGRAM_API_PORT='$port' OPENCLAW_MESSAGE_TARGET_B64='$target_b64' OPENCLAW_MESSAGE_TEXT_B64='$message_b64' node --preserve-symlinks --input-type=module - 2>&1" <<'NODE'
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function decodeBase64(value) {
  return Buffer.from(value || "", "base64").toString("utf8");
}

function addPathWalk(candidates, seen, start) {
  if (!start) return;
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    if (!seen.has(current)) {
      seen.add(current);
      candidates.push(path.join(current, "node_modules/openclaw/dist/extensions/telegram/test-api.js"));
      candidates.push(path.join(current, "dist/extensions/telegram/test-api.js"));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function resolveTelegramTestApiPath() {
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
      add(path.join(path.dirname(require.resolve("openclaw/package.json", { paths: [base] })), "dist/extensions/telegram/test-api.js"));
    } catch {}
  }

  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    add(path.join(globalRoot, "openclaw/dist/extensions/telegram/test-api.js"));
  } catch {}

  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw || true"], { encoding: "utf8" }).trim();
    if (openclawBin) {
      const realBin = execFileSync("readlink", ["-f", openclawBin], { encoding: "utf8" }).trim();
      addPathWalk(candidates, seen, path.dirname(realBin));
    }
  } catch {}

  try {
    const searchRoots = ["/usr/local", "/tmp/npm-global", "/sandbox"].filter((root) => fs.existsSync(root));
    if (searchRoots.length) {
      const discovered = execFileSync("find", [
        ...searchRoots,
        "-path",
        "*/node_modules/openclaw/dist/extensions/telegram/test-api.js",
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

function requestFakeTelegram(endpoint, fields, token) {
  const payload = JSON.stringify(fields);
  const options = {
    hostname: process.env.FAKE_TELEGRAM_API_HOST || "host.openshell.internal",
    port: Number(process.env.FAKE_TELEGRAM_API_PORT),
    path: `/bot${token}/${endpoint}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
      "User-Agent": "nemoclaw-openclaw-telegram-plugin-e2e",
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
          reject(new Error(`invalid JSON from fake Telegram: ${error.message}: ${responseBody}`));
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300 || parsed.ok !== true) {
          reject(new Error(`fake Telegram ${endpoint} failed: HTTP ${res.statusCode} ${JSON.stringify(parsed)}`));
          return;
        }
        resolve(parsed.result);
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error("fake Telegram message API timed out"));
    });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const testApiPath = resolveTelegramTestApiPath();
  if (!testApiPath) throw new Error("could not find installed OpenClaw Telegram test-api.js");

  const { sendMessageTelegram } = await import(pathToFileURL(testApiPath).href);
  if (typeof sendMessageTelegram !== "function") {
    throw new Error("installed Telegram test API does not export sendMessageTelegram");
  }

  const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
  const account = cfg.channels?.telegram?.accounts?.default;
  if (!account?.botToken) throw new Error("missing channels.telegram.accounts.default.botToken in openclaw.json");

  const target = decodeBase64(process.env.OPENCLAW_MESSAGE_TARGET_B64);
  const text = decodeBase64(process.env.OPENCLAW_MESSAGE_TEXT_B64);
  const token = account.botToken;
  const api = {
    sendMessage: (chatId, body, params = {}) => requestFakeTelegram("sendMessage", {
      chat_id: chatId,
      text: body,
      ...params,
    }, token),
  };

  const result = await sendMessageTelegram(target, text, {
    cfg,
    token,
    accountId: "default",
    api,
  });

  console.log(JSON.stringify({
    ok: true,
    proof: "openclaw-telegram-runtime-send",
    chatId: result.chatId ?? target,
    messageId: result.messageId ?? null,
  }));
}

main()
  .then(() => {
    console.log("__OPENCLAW_MESSAGE_SEND_EXIT__:0");
  })
  .catch((error) => {
    console.error(error.stack || error.message || String(error));
    console.log("__OPENCLAW_MESSAGE_SEND_EXIT__:1");
    process.exit(1);
  });
NODE
}

check_fake_telegram_capture_send() {
  local expected_token="$1"
  local expected_chat="$2"
  local expected_text="$3"
  node - "$FAKE_TELEGRAM_API_CAPTURE_FILE" "$expected_token" "$expected_chat" "$expected_text" <<'NODE'
const fs = require("fs");
const [file, expectedToken, expectedChat, expectedText] = process.argv.slice(2);
const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => JSON.parse(line))
  .filter((row) => row.event === "request" && row.endpoint === "sendMessage");
const last = rows.at(-1);
if (!last) {
  console.log("NO_SEND_MESSAGE");
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
if (String(last.chatId) !== String(expectedChat)) {
  console.log(`BAD_CHAT ${last.chatId}`);
  process.exit(5);
}
if (last.text !== expectedText) {
  console.log(`BAD_TEXT ${last.text}`);
  process.exit(6);
}
if (!expectedToken) {
  console.log("MISSING_EXPECTED_TOKEN");
  process.exit(7);
}
console.log("OK");
NODE
}
