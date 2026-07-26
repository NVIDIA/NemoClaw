// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SandboxClient } from "../fixtures/clients/sandbox.ts";

import {
  expectExitZero,
  type FakeDockerApi,
  runSandboxNode,
} from "./messaging-providers-helpers.ts";

export type InstalledTelegramRuntimeProof = {
  ok: true;
  proof: "openclaw-telegram-runtime-send";
  chatId: string;
  messageId: string;
};

export const TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE = String.raw`
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

function addPathWalk(candidates, seen, start) {
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
  const require = createRequire(import.meta.url);
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (candidate && !seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
  };
  for (const base of [
    process.cwd(),
    "/sandbox",
    "/usr/local/lib/node_modules",
    "/tmp/npm-global/lib/node_modules",
  ]) {
    try {
      add(
        path.join(
          path.dirname(require.resolve("openclaw/package.json", { paths: [base] })),
          "dist/extensions/telegram/runtime-api.js",
        ),
      );
    } catch {}
    try {
      add(
        path.join(
          path.resolve(path.dirname(require.resolve("openclaw", { paths: [base] })), ".."),
          "dist/extensions/telegram/runtime-api.js",
        ),
      );
    } catch {}
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    add(path.join(globalRoot, "openclaw/dist/extensions/telegram/runtime-api.js"));
  } catch {}
  try {
    const openclawBin = execFileSync("sh", ["-lc", "command -v openclaw || true"], {
      encoding: "utf8",
    }).trim();
    if (openclawBin) {
      const realBin = execFileSync("readlink", ["-f", openclawBin], {
        encoding: "utf8",
      }).trim();
      addPathWalk(candidates, seen, path.dirname(realBin));
    }
  } catch {}
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function requestFakeTelegram(endpoint, fields, token) {
  const payload = JSON.stringify(fields);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "host.openshell.internal",
        port: Number(process.env.FAKE_TELEGRAM_API_PORT),
        path: "/bot" + token + "/" + endpoint,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "nemoclaw-openclaw-telegram-plugin-e2e",
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          try {
            const parsed = responseBody ? JSON.parse(responseBody) : {};
            if (res.statusCode < 200 || res.statusCode >= 300 || parsed.ok !== true) {
              reject(
                new Error(
                  "fake Telegram " +
                    endpoint +
                    " failed: HTTP " +
                    res.statusCode +
                    " " +
                    JSON.stringify(parsed),
                ),
              );
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(new Error("invalid JSON from fake Telegram: " + error.message));
          }
        });
      },
    );
    req.on("error", reject);
    req.setTimeout(30000, () =>
      req.destroy(new Error("fake Telegram message API timed out")),
    );
    req.write(payload);
    req.end();
  });
}

const runtimeApiPath = resolveTelegramRuntimeApiPath();
if (!runtimeApiPath) {
  throw new Error(
    "could not find installed OpenClaw Telegram runtime-api.js at openclaw/dist/extensions/telegram/runtime-api.js",
  );
}
const { sendMessageTelegram } = await import(pathToFileURL(runtimeApiPath).href);
if (typeof sendMessageTelegram !== "function") {
  throw new Error("installed Telegram runtime API does not export sendMessageTelegram");
}
const cfg = JSON.parse(fs.readFileSync("/sandbox/.openclaw/openclaw.json", "utf8"));
const account = cfg.channels?.telegram?.accounts?.default;
if (!account?.botToken) {
  throw new Error("missing channels.telegram.accounts.default.botToken in openclaw.json");
}
const target = process.env.OPENCLAW_MESSAGE_TARGET || "42424242";
const text = process.env.OPENCLAW_MESSAGE_TEXT || "NemoClaw OpenClaw Telegram plugin mock E2E";
const token = account.botToken;
const api = {
  sendMessage: (chatId, body, params = {}) =>
    requestFakeTelegram(
      "sendMessage",
      {
        chat_id: chatId,
        text: body,
        ...params,
      },
      token,
    ),
};
const result = await sendMessageTelegram(target, text, {
  cfg,
  token,
  accountId: "default",
  api,
});
console.log(
  JSON.stringify({
    ok: true,
    proof: "openclaw-telegram-runtime-send",
    chatId: String(result.chatId ?? target),
    messageId: String(result.messageId ?? ""),
  }),
);
`;

function parseInstalledTelegramProof(stdout: string): InstalledTelegramRuntimeProof {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      const value = JSON.parse(line) as Partial<InstalledTelegramRuntimeProof>;
      if (
        value.ok === true &&
        value.proof === "openclaw-telegram-runtime-send" &&
        typeof value.chatId === "string" &&
        value.chatId.length > 0 &&
        typeof value.messageId === "string" &&
        value.messageId.length > 0
      ) {
        return value as InstalledTelegramRuntimeProof;
      }
    } catch {
      // Module discovery can emit non-JSON diagnostics before the proof record.
    }
  }
  throw new Error(`installed Telegram runtime proof did not emit a valid result:\n${stdout}`);
}

export async function runInstalledTelegramRuntimeProof(
  sandbox: SandboxClient,
  fakeTelegram: FakeDockerApi,
  target: string,
  text: string,
  redactionValues: string[],
): Promise<InstalledTelegramRuntimeProof> {
  const result = await runSandboxNode(sandbox, TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE, {
    artifactName: "installed-telegram-runtime-proof",
    env: {
      FAKE_TELEGRAM_API_PORT: fakeTelegram.port,
      OPENCLAW_MESSAGE_TARGET: target,
      OPENCLAW_MESSAGE_TEXT: text,
    },
    redactionValues,
    timeoutMs: 120_000,
  });
  expectExitZero(result, "installed OpenClaw Telegram runtime proof");
  return parseInstalledTelegramProof(result.stdout);
}
