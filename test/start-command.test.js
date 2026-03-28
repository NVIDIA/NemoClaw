// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cliPath = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const cliSource = fs.readFileSync(cliPath, "utf-8");

describe("nemoclaw start command", () => {
  it("targets service commands at the default sandbox", () => {
    expect(cliSource).toMatch(/function defaultSandboxEnv\(\)/);
    expect(cliSource).toMatch(
      /function stop\(\)\s*{[\s\S]*?defaultSandboxEnv\(\)[\s\S]*?start-services\.sh" --stop/,
    );
    expect(cliSource).toMatch(
      /function showStatus\(\)\s*{[\s\S]*?defaultSandboxEnv\(\)[\s\S]*?start-services\.sh" --status/,
    );
  });

  it("loads the saved Telegram token into the service env", () => {
    expect(cliSource).toMatch(/async function start\(\)/);
    expect(cliSource).toMatch(
      /async function start\(\)\s*{[\s\S]*?const tgToken = getCredential\("TELEGRAM_BOT_TOKEN"\)/,
    );
    expect(cliSource).toMatch(
      /async function start\(\)\s*{[\s\S]*?const sandboxEnv = defaultSandboxEnv\(\)/,
    );
    expect(cliSource).toMatch(
      /async function start\(\)\s*{[\s\S]*?if\s*\(sandboxEnv\)\s*envParts\.push\(sandboxEnv\.trim\(\)\)/,
    );
    expect(cliSource).toMatch(
      /async function start\(\)\s*{[\s\S]*?if\s*\(tgToken\)\s*envParts\.push\(`TELEGRAM_BOT_TOKEN=\$\{shellQuote\(tgToken\)\}`\)/,
    );
    expect(cliSource).toMatch(
      /async function start\(\)\s*{[\s\S]*?run\(\s*`\$\{envParts\.join\(" "\)\}\s+bash "\$\{SCRIPTS\}\/start-services\.sh"`\s*\)/,
    );
  });
});
