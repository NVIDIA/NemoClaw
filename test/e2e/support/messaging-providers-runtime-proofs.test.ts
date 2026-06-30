// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SLACK_INSTALLED_RUNTIME_PROOF_SOURCE } from "../live/messaging-providers-slack-runtime-proof.ts";
import { TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE } from "../live/messaging-providers-telegram-runtime-proof.ts";

const FAKE_TELEGRAM_API = path.resolve(import.meta.dirname, "../lib/fake-telegram-api.cjs");

function expectValidModuleSource(source: string): void {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
    encoding: "utf8",
    input: source,
  });
  expect(result.status, result.stderr).toBe(0);
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

describe("messaging provider installed-runtime proofs", () => {
  it("keeps the Slack allow, deny, feedback, and send contract on installed exports", () => {
    expectValidModuleSource(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE);
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("prepareSlackMessage");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("sendMessageSlack");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("deniedPrepared === null");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("senderFeedbackCalls.length === 1");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("openclaw-pipeline-runtime");
    expect(SLACK_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("/api/chat.postMessage");
  });

  it("keeps Telegram on runtime-api.js with a fake send boundary", () => {
    expectValidModuleSource(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE);
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).toContain(
      "dist/extensions/telegram/runtime-api.js",
    );
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("sendMessageTelegram");
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).toContain("host.openshell.internal");
    expect(TELEGRAM_INSTALLED_RUNTIME_PROOF_SOURCE).not.toContain("telegram/test-api.js");
  });

  it("redacts Telegram tokens from fake API captures", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-fake-telegram-redaction-"));
    const portFile = path.join(dir, "port");
    const captureFile = path.join(dir, "capture.jsonl");
    const token = "123456:SUPER-SECRET-TELEGRAM-TOKEN";
    const child = spawn(process.execPath, [FAKE_TELEGRAM_API], {
      env: {
        ...process.env,
        FAKE_TELEGRAM_API_HOST: "127.0.0.1",
        FAKE_TELEGRAM_API_PORT: "0",
        FAKE_TELEGRAM_API_PORT_FILE: portFile,
        FAKE_TELEGRAM_API_CAPTURE_FILE: captureFile,
        FAKE_TELEGRAM_API_EXPECTED_TOKEN: token,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      await waitFor(() => fs.existsSync(portFile), `fake Telegram API did not start: ${stderr}`);
      const port = fs.readFileSync(portFile, "utf8").trim();
      const response = await fetch(`http://127.0.0.1:${port}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: "42424242", text: "redaction proof" }),
      });
      expect(response.status).toBe(200);
      await waitFor(
        () =>
          fs.existsSync(captureFile) &&
          fs.readFileSync(captureFile, "utf8").includes("sendMessage"),
        `fake Telegram API did not capture the request: ${stderr}`,
      );
      const capture = fs.readFileSync(captureFile, "utf8");
      expect(capture).not.toContain(token);
      const request = capture
        .trim()
        .split(/\n+/u)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((row) => row.event === "request");
      expect(request).toMatchObject({
        endpoint: "sendMessage",
        path: "/bot[redacted]/sendMessage",
        tokenMatchesExpected: true,
        tokenRedacted: true,
      });
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
