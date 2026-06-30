// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.join(import.meta.dirname, "../..");
const compiledPreload = path.join(
  repoRoot,
  "dist",
  "lib",
  "messaging",
  "channels",
  "teams",
  "runtime",
  "msteams-message-hints.js",
);

function writePinnedPackageEntry(root: string): void {
  const distDir = path.join(root, "node_modules", "@openclaw", "msteams", "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, "node_modules", "@openclaw", "msteams", "package.json"),
    JSON.stringify({
      name: "@openclaw/msteams",
      version: "2026.5.27",
      main: "dist/index.js",
    }),
  );
  fs.writeFileSync(
    path.join(distDir, "channel-plugin-api.js"),
    [
      "const msteamsPlugin = {",
      "  agentPrompt: {",
      "    messageToolHints: () => [",
      "      '- Adaptive Cards supported.',",
      "      '- MSTeams targeting: reply to the current conversation.',",
      "    ],",
      "  },",
      "};",
      "module.exports = { msteamsPlugin };",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(distDir, "index.js"),
    'module.exports = require("./channel-plugin-api.js");\n',
  );
}

describe("compiled Microsoft Teams message hint preload contract", () => {
  it("patches the pinned package entry shape and restores the loader hook", () => {
    expect(
      fs.existsSync(compiledPreload),
      "Run `npm run build:cli` before the package-contract project.",
    ).toBe(true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-package-contract-"));
    writePinnedPackageEntry(tmp);
    try {
      const script = `
process.title = "openclaw-gateway";
const Module = require("node:module");
const originalLoad = Module._load;
require(${JSON.stringify(compiledPreload)});
const plugin = require("@openclaw/msteams").msteamsPlugin;
process.stdout.write(JSON.stringify({
  hints: plugin.agentPrompt.messageToolHints({ cfg: {} }),
  restored: Module._load === originalLoad,
}));
`;
      const result = spawnSync(process.execPath, ["-e", script], {
        cwd: tmp,
        encoding: "utf8",
        timeout: 10_000,
      });

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      const payload = JSON.parse(result.stdout) as { hints: string[]; restored: boolean };
      const mentionHints = payload.hints.filter((hint) => hint.includes("@[Display Name]("));
      const mentionIndex = payload.hints.findIndex((hint) => hint.includes("@[Display Name]("));
      const targetingIndex = payload.hints.findIndex((hint) =>
        hint.startsWith("- MSTeams targeting:"),
      );
      expect(mentionHints).toHaveLength(1);
      expect(mentionIndex).toBeGreaterThanOrEqual(0);
      expect(targetingIndex).toBeGreaterThan(mentionIndex);
      expect(payload.restored).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
