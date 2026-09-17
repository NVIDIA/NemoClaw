// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { assertExitZero } from "../fixtures/clients/command.ts";
import { type SandboxClient, sandboxAccessEnv } from "../fixtures/clients/sandbox.ts";
import { REPO_ROOT } from "../fixtures/paths.ts";

export type InstalledTelegramRuntimeProof = {
  ok: true;
  proof: "openclaw-telegram-runtime-send";
  chatId: string;
  messageId: string;
};

const SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? `e2e-msg-${process.pid}`;
const LOCAL_PROOF_SCRIPT = path.join(REPO_ROOT, "test/e2e/lib/installed-telegram-runtime-proof.ts");
const REMOTE_PROOF_SCRIPT = `/tmp/nemoclaw-installed-telegram-runtime-proof-${process.pid}.ts`;
const ATOMIC_PROOF_RUNNER = [
  "set -eu",
  'encoded_source="$1"',
  'script_path="$2"',
  "shift 2",
  'printf \'%s\' "$encoded_source" | base64 -d > "$script_path"',
  'exec env "$@" node --experimental-strip-types "$script_path"',
].join("\n");

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

export async function sendWithInstalledTelegramRuntime(
  sandbox: SandboxClient,
  fakeTelegram: { port: string },
  target: string,
  text: string,
  redactionValues: string[],
): Promise<InstalledTelegramRuntimeProof> {
  const encodedSource = Buffer.from(fs.readFileSync(LOCAL_PROOF_SCRIPT, "utf8"), "utf8").toString(
    "base64",
  );
  const result = await sandbox.exec(
    SANDBOX_NAME,
    [
      "sh",
      "-lc",
      ATOMIC_PROOF_RUNNER,
      "nemoclaw-telegram-runtime-proof",
      encodedSource,
      REMOTE_PROOF_SCRIPT,
      `FAKE_TELEGRAM_API_PORT=${fakeTelegram.port}`,
      `OPENCLAW_MESSAGE_TARGET=${target}`,
      `OPENCLAW_MESSAGE_TEXT=${text}`,
    ],
    {
      artifactName: "installed-telegram-runtime-proof",
      env: sandboxAccessEnv(),
      redactionValues,
      timeoutMs: 120_000,
    },
  );
  assertExitZero(result, "installed OpenClaw Telegram runtime proof");
  return parseInstalledTelegramProof(result.stdout);
}
