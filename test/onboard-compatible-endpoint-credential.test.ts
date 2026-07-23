// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

describe("OpenAI-compatible endpoint credentials", () => {
  it("skips the API key prompt for an exact localhost endpoint (#7424)", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-localhost-credential-"));
    const scriptPath = path.join(tmpDir, "check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const messages = [];
const lines = [];

for (const key of [
  "COMPATIBLE_API_KEY",
  "NEMOCLAW_NON_INTERACTIVE",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_PROVIDER_KEY",
]) {
  delete process.env[key];
}

function selectRecentMenuOption(pattern) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*(\d+)\)\s+(.+)$/.exec(lines[index]);
    if (match && pattern.test(match[2])) return match[1];
  }
  throw new Error("Could not find provider menu option " + pattern);
}

credentials.prompt = async (message) => {
  messages.push(message);
  if (/Choose \[/.test(message)) {
    return selectRecentMenuOption(/^Other OpenAI-compatible endpoint$/);
  }
  if (/OpenAI-compatible base URL/.test(message)) {
    return "http://localhost:8000/v1";
  }
  if (/Other OpenAI-compatible endpoint API key/.test(message)) {
    throw new Error("localhost must not prompt for an API key");
  }
  if (/Other OpenAI-compatible endpoint model/.test(message)) {
    throw new Error("reached localhost model prompt");
  }
  return "";
};
runner.runCapture = () => "";

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => lines.push(args.join(" "));
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await setupNim(null);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
})().catch((error) => {
  if (error.message === "reached localhost model prompt") {
    console.log(JSON.stringify({ messages, key: process.env.COMPATIBLE_API_KEY || null }));
    return;
  }
  console.error(error);
  process.exit(1);
});
`;

    try {
      fs.writeFileSync(scriptPath, script);
      const result = spawnSync(process.execPath, [scriptPath], {
        cwd: repoRoot,
        encoding: "utf-8",
        env: { ...process.env, HOME: tmpDir },
        timeout: 30_000,
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout.trim());
      assert.equal(payload.key, null);
      assert.ok(
        payload.messages.some((message: string) =>
          /Other OpenAI-compatible endpoint model/.test(message),
        ),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
