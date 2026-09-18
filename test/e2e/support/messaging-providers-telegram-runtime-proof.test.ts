// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";

import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { sendWithInstalledTelegramRuntime } from "../live/messaging-providers-telegram-runtime-proof.ts";

function successfulCommand(stdout = "") {
  return {
    artifacts: { result: "", stderr: "", stdout: "" },
    command: [],
    exitCode: 0,
    signal: null,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

it("transmits and runs the installed Telegram proof atomically with redaction", async () => {
  const upload = vi.fn().mockResolvedValue(successfulCommand());
  const exec = vi.fn().mockResolvedValue(
    successfulCommand(
      JSON.stringify({
        ok: true,
        proof: "openclaw-telegram-runtime-send",
        chatId: "42424242",
        messageId: "telegram-message-1",
      }),
    ),
  );
  const sandbox = { exec, upload } as unknown as SandboxClient;
  const redactionValues = ["raw-telegram-token", "openshell:resolve:env:v7_TELEGRAM_BOT_TOKEN"];

  const proof = await sendWithInstalledTelegramRuntime(
    sandbox,
    { port: "32123" },
    "42424242",
    "credential rewrite proof",
    redactionValues,
  );

  expect(proof).toEqual({
    ok: true,
    proof: "openclaw-telegram-runtime-send",
    chatId: "42424242",
    messageId: "telegram-message-1",
  });
  expect(upload).not.toHaveBeenCalled();
  expect(exec).toHaveBeenCalledWith(
    `e2e-msg-${process.pid}`,
    [
      "sh",
      "-lc",
      expect.stringContaining('exec env "$@" node --experimental-strip-types "$script_path"'),
      "nemoclaw-telegram-runtime-proof",
      expect.any(String),
      `/tmp/nemoclaw-installed-telegram-runtime-proof-${process.pid}.ts`,
      "FAKE_TELEGRAM_API_PORT=32123",
      "OPENCLAW_MESSAGE_TARGET=42424242",
      "OPENCLAW_MESSAGE_TEXT=credential rewrite proof",
    ],
    expect.objectContaining({
      artifactName: "installed-telegram-runtime-proof",
      redactionValues,
    }),
  );
});
