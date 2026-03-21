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
    assert.match(cliSource, /run\(`\$\{defaultSandboxEnv\(\)\}bash "\$\{SCRIPTS\}\/start-services\.sh" --stop`\)/);
    assert.match(cliSource, /run\(`\$\{defaultSandboxEnv\(\)\}bash "\$\{SCRIPTS\}\/start-services\.sh" --status`\)/);
  });

  it("loads the saved Telegram token into the service env", () => {
    assert.match(cliSource, /async function start\(\)/);
    assert.match(cliSource, /const tgToken = getCredential\("TELEGRAM_BOT_TOKEN"\)/);
    assert.match(cliSource, /const sandboxEnv = defaultSandboxEnv\(\)/);
    assert.match(cliSource, /if \(tgToken\) envParts\.push\(`TELEGRAM_BOT_TOKEN=\$\{shellQuote\(tgToken\)\}`\)/);
    assert.match(cliSource, /run\(`\$\{envParts\.join\(" "\)\} bash "\$\{SCRIPTS\}\/start-services\.sh"`\)/);
  });
});
