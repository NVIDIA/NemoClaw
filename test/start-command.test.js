// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const cliPath = path.join(__dirname, "..", "bin", "nemoclaw.js");
const cliSource = fs.readFileSync(cliPath, "utf-8");

describe("nemoclaw start command", () => {
  it("targets service commands at the default sandbox", () => {
    assert.match(cliSource, /function defaultSandboxEnv\(\)/);
    assert.match(
      cliSource,
      /function stop\(\)\s*{[\s\S]*?defaultSandboxEnv\(\)[\s\S]*?start-services\.sh" --stop/,
    );
    assert.match(
      cliSource,
      /function showStatus\(\)\s*{[\s\S]*?defaultSandboxEnv\(\)[\s\S]*?start-services\.sh" --status/,
    );
  });

  it("loads the saved Telegram token into the service env", () => {
    assert.match(cliSource, /async function start\(\)/);
    assert.match(
      cliSource,
      /async function start\(\)\s*{[\s\S]*?const tgToken = getCredential\("TELEGRAM_BOT_TOKEN"\)/,
    );
    assert.match(
      cliSource,
      /async function start\(\)\s*{[\s\S]*?const sandboxEnv = defaultSandboxEnv\(\)/,
    );
    assert.match(
      cliSource,
      /async function start\(\)\s*{[\s\S]*?if\s*\(sandboxEnv\)\s*envParts\.push\(sandboxEnv\.trim\(\)\)/,
    );
    assert.match(
      cliSource,
      /async function start\(\)\s*{[\s\S]*?if\s*\(tgToken\)\s*envParts\.push\(`TELEGRAM_BOT_TOKEN=\$\{shellQuote\(tgToken\)\}`\)/,
    );
    assert.match(
      cliSource,
      /async function start\(\)\s*{[\s\S]*?run\(\s*`\$\{envParts\.join\(" "\)\}\s+bash "\$\{SCRIPTS\}\/start-services\.sh"`\s*\)/,
    );
  });
});
