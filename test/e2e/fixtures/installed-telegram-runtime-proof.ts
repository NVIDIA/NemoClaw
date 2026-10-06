// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

function addPathWalk(candidates: string[], seen: Set<string>, start: string): void {
  if (!start) return;
  let current = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    for (const candidate of [
      path.join(current, "node_modules/openclaw/dist/extensions/telegram/runtime-api.js"),
      path.join(current, "dist/extensions/telegram/runtime-api.js"),
    ]) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function resolveTelegramRuntimeApiPath() {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };
  for (const base of [process.cwd(), "/sandbox", "/usr/local/lib", "/tmp/npm-global/lib"]) {
    add(path.join(base, "node_modules/openclaw/dist/extensions/telegram/runtime-api.js"));
    add(path.join(base, "openclaw/dist/extensions/telegram/runtime-api.js"));
  }
  try {
    add(
      path.join(
        execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
        "openclaw/dist/extensions/telegram/runtime-api.js",
      ),
    );
  } catch {}
  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw || true"], {
      encoding: "utf8",
    }).trim();
    if (openclawBin) {
      addPathWalk(
        candidates,
        seen,
        path.dirname(execFileSync("readlink", ["-f", openclawBin], { encoding: "utf8" }).trim()),
      );
    }
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function requestFakeTelegram(
  endpoint: string,
  fields: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const payload = JSON.stringify(fields);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "host.openshell.internal",
        port: Number(process.env.FAKE_TELEGRAM_API_PORT),
        path: `/bot${token}/${endpoint}`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let body = "";
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => {
          try {
            const parsed = body ? JSON.parse(body) : {};
            if ((response.statusCode ?? 500) >= 300 || parsed.ok !== true) {
              reject(new Error(`fake Telegram ${endpoint} rejected the request`));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(
              new Error(
                `invalid JSON from fake Telegram: ${error instanceof Error ? error.message : String(error)}`,
              ),
            );
          }
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("fake Telegram request timed out")));
    request.end(payload);
  });
}

const runtimeApiCandidate = resolveTelegramRuntimeApiPath();
if (!runtimeApiCandidate) throw new Error("could not find installed OpenClaw Telegram runtime API");
const { sendMessageTelegram } = await import(
  pathToFileURL(fs.realpathSync(runtimeApiCandidate)).href
);
if (typeof sendMessageTelegram !== "function")
  throw new Error("installed Telegram runtime API is invalid");
const config = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const account = config.channels?.telegram?.accounts?.default;
if (!account || Object.prototype.hasOwnProperty.call(account, "botToken")) {
  throw new Error("Telegram account configuration persisted a token or is missing");
}
const token = process.env.TELEGRAM_BOT_TOKEN;
if (
  typeof token !== "string" ||
  !/^openshell:resolve:env:v[0-9]+_TELEGRAM_BOT_TOKEN$/u.test(token)
) {
  throw new Error("missing revision-scoped Telegram credential placeholder");
}
const target = process.env.OPENCLAW_MESSAGE_TARGET ?? "42424242";
const text = process.env.OPENCLAW_MESSAGE_TEXT ?? "NemoClaw OpenClaw Telegram plugin mock E2E";
const result = (await sendMessageTelegram(target, text, {
  cfg: config,
  token,
  accountId: "default",
  api: {
    sendMessage: (chatId: string | number, body: string, params: Record<string, unknown> = {}) =>
      requestFakeTelegram("sendMessage", { chat_id: chatId, text: body, ...params }, token),
  },
})) as { chatId?: unknown; messageId?: unknown };
console.log(
  JSON.stringify({
    ok: true,
    proof: "openclaw-telegram-runtime-send",
    chatId: String(result.chatId ?? target),
    messageId: String(result.messageId ?? ""),
  }),
);
