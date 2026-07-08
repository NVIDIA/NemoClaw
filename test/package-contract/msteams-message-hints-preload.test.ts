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

// Reviewed from the published @openclaw/msteams artifact, not inferred from
// NemoClaw source. The integrity is npm's dist.integrity; the SHA-256 values
// identify the exact runtime entry and plugin entry reviewed for 2026.6.10.
// This fixture intentionally models only that package/load boundary. It does
// not vendor or claim to test the upstream Bot Framework send/parser code.
const REVIEWED_MSTEAMS_CONTRACT = {
  version: "2026.6.10",
  npmIntegrity:
    "sha512-GjHnCPvjbnI0C7mEFcdT2uKDH4/WwOe2dZBfQiWxBtkE76m6TNG0J9dJjD4mc8/pk8rXSO0cWw+KV9jzWtF9VA==",
  runtimeExtension: "./dist/index.js",
  pluginSpecifier: "./channel-plugin-api.js",
  indexSha256: "2a83ee979d5ee9f12c7ac507ebd87024be3315de3f2cc87c81effc9ca85246d1",
  pluginEntrySha256: "2d451b31ba4fbcc0e22ea4654fdc55dc05ae680765b7d636bfbf89177eb1be4b",
} as const;

function readPinnedOpenClawVersion(): string {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "nemoclaw", "package.json"), "utf8"),
  ) as { openclaw?: { build?: { openclawVersion?: unknown } } };
  return String(packageJson.openclaw?.build?.openclawVersion ?? "");
}

function writeReviewedPackageShape(root: string, version: string): string {
  const packageDir = path.join(root, "node_modules", "@openclaw", "msteams");
  const distDir = path.join(packageDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/msteams",
      version,
      type: "module",
      openclaw: { runtimeExtensions: [REVIEWED_MSTEAMS_CONTRACT.runtimeExtension] },
    }),
  );
  fs.writeFileSync(
    path.join(distDir, "reviewed-channel-entry-contract.js"),
    // The published package's runtime extension delegates to
    // defineBundledChannelEntry. OpenClaw 2026.6.10 then uses createRequire for
    // built dist/*.js plugin entries. Preserve that reviewed loader seam here
    // without copying the upstream Teams sender or parser implementation.
    [
      'import { createRequire } from "node:module";',
      'import { fileURLToPath } from "node:url";',
      "const nodeRequire = createRequire(import.meta.url);",
      "export function defineBundledChannelEntry({ importMetaUrl, plugin }) {",
      "  return {",
      "    loadChannelPlugin() {",
      "      const modulePath = fileURLToPath(new URL(plugin.specifier, importMetaUrl));",
      "      const loaded = nodeRequire(modulePath);",
      "      return loaded[plugin.exportName];",
      "    },",
      "  };",
      "}",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(distDir, "index.js"),
    [
      'import { defineBundledChannelEntry } from "./reviewed-channel-entry-contract.js";',
      "export default defineBundledChannelEntry({",
      "  importMetaUrl: import.meta.url,",
      `  plugin: { specifier: ${JSON.stringify(REVIEWED_MSTEAMS_CONTRACT.pluginSpecifier)}, exportName: "msteamsPlugin" },`,
      "});",
      "",
    ].join("\n"),
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
      "export { msteamsPlugin };",
      "",
    ].join("\n"),
  );
  return packageDir;
}

describe("compiled Microsoft Teams message hint preload contract", () => {
  it("requires package-shape re-review when the repository OpenClaw pin changes", () => {
    expect(readPinnedOpenClawVersion()).toBe(REVIEWED_MSTEAMS_CONTRACT.version);
  });

  it("patches the reviewed package-load shape without claiming Bot Framework delivery", () => {
    expect(
      fs.existsSync(compiledPreload),
      "Run `npm run build:cli` before the package-contract project.",
    ).toBe(true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-package-contract-"));
    const packageDir = writeReviewedPackageShape(tmp, readPinnedOpenClawVersion());
    try {
      const script = `
process.title = "openclaw-gateway";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const Module = require("node:module");
const originalLoad = Module._load;
require(${JSON.stringify(compiledPreload)});
(async () => {
  const packageDir = ${JSON.stringify(packageDir)};
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  const entryPath = path.join(packageDir, packageJson.openclaw.runtimeExtensions[0]);
  const entry = (await import(pathToFileURL(entryPath).href)).default;
  const plugin = entry.loadChannelPlugin();
  process.stdout.write(JSON.stringify({
    hints: plugin.agentPrompt.messageToolHints({ cfg: {} }),
    restored: Module._load === originalLoad,
  }));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
});
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
