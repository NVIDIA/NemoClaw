// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const commandsPath = path.join(import.meta.dirname, "../..", "docs", "reference", "commands.mdx");

describe("onboarding recovery documentation", () => {
  it("scopes interceptor onboarding to OpenClaw and gives an exact safe fresh command (#9833)", () => {
    const commands = fs.readFileSync(commandsPath, "utf8");
    expect(commands).toMatch(
      /<AgentOnly variant="openclaw">\s+#### `--apf-interceptor`[\s\S]*?<\/AgentOnly>\s+#### `--tool-disclosure <progressive\|direct>`/u,
    );
    expect(commands).toContain("`$$nemoclaw onboard --fresh --name <new-sandbox-name>`");
    expect(commands).not.toContain("with `--fresh` and another available sandbox name");
  });
});
