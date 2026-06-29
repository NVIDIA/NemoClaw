// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MSTEAMS_HINT_PRELOAD = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "messaging",
  "channels",
  "teams",
  "runtime",
  "msteams-message-hints.ts",
);

const MSTEAMS_MENTION_HINT =
  "- MSTeams mentions: use `@[Display Name](Teams user id or AAD object id)` in `message`; plain `@name` text is not a native mention and will not notify.";

const ADAPTIVE_CARD_HINT =
  "- Adaptive Cards supported. Use `action=send` with `card={type,version,body}` to send rich cards.";

const TARGETING_HINT =
  "- MSTeams targeting: omit `target` to reply to the current conversation (auto-inferred). Explicit targets: `user:ID` or `user:Display Name` (requires Graph API) for DMs, `conversation:19:...@thread.tacv2` for groups/channels. Prefer IDs over display names for speed.";

const SAN_DANG_AAD_OBJECT_ID = "205f29da-231e-4a0e-a0b2-b398e6302087";

type TeamsMentionActivity = {
  text: string;
  entities: Array<{
    type: "mention";
    text: string;
    mentioned: {
      id: string;
      name: string;
    };
  }>;
};

function pluginFixtureSource(moduleType: "commonjs" | "esm", includeMentionHint = false): string {
  const hints = includeMentionHint
    ? [ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]
    : [ADAPTIVE_CARD_HINT, TARGETING_HINT];
  const pluginSource = [
    "const msteamsPlugin = {",
    "  agentPrompt: {",
    "    messageToolHints: () => [",
    ...hints.map((hint) => `      ${JSON.stringify(hint)},`),
    "    ],",
    "  },",
    "};",
  ];
  return [
    ...pluginSource,
    moduleType === "esm" ? "export { msteamsPlugin };" : "module.exports = { msteamsPlugin };",
    "",
  ].join("\n");
}

function writeMSTeamsPackage(
  root: string,
  options: { moduleType?: "commonjs" | "esm"; includeMentionHint?: boolean } = {},
): string {
  const moduleType = options.moduleType ?? "commonjs";
  const pkgDir = path.join(root, "node_modules", "@openclaw", "msteams");
  const distDir = path.join(pkgDir, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/msteams",
      version: "2026.5.27",
      ...(moduleType === "esm" ? { type: "module" } : {}),
    }),
  );
  const channelFile = path.join(distDir, "channel-fixture.js");
  fs.writeFileSync(
    channelFile,
    pluginFixtureSource(moduleType, options.includeMentionHint ?? false),
  );
  return channelFile;
}

function writeUnrelatedMSTeamsLikeModule(root: string): string {
  const moduleDir = path.join(root, "vendor", "msteams", "fake-channel");
  fs.mkdirSync(moduleDir, { recursive: true });
  const moduleFile = path.join(moduleDir, "index.js");
  fs.writeFileSync(moduleFile, pluginFixtureSource("commonjs"));
  return moduleFile;
}

function runHintsProbe(
  fixtureFile: string,
  options: { gatewayProcess?: boolean; requirePreloadTwice?: boolean } = {},
) {
  const script = `
const preload = ${JSON.stringify(MSTEAMS_HINT_PRELOAD)};
${options.gatewayProcess === false ? "" : "process.title = 'openclaw-gateway';"}
require(preload);
${options.requirePreloadTwice ? "require(preload);" : ""}
const plugin = require(process.env.MSTEAMS_FILE).msteamsPlugin;
console.log(JSON.stringify(plugin.agentPrompt.messageToolHints({ cfg: {} })));
`;
  const result = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      MSTEAMS_FILE: fixtureFile,
    },
    timeout: 10_000,
  });
  return {
    result,
    hints:
      result.status === 0 && result.stdout.trim() ? (JSON.parse(result.stdout) as string[]) : [],
  };
}

function buildRealOpenClawMSTeamsSendFormatterContract(message: string): TeamsMentionActivity {
  const entities: TeamsMentionActivity["entities"] = [];
  const text = message.replace(/@\[([^\]]+)\]\(([^)]+)\)/g, (_match, name, id) => {
    const displayName = String(name).trim();
    const userId = String(id).trim();
    const mentionText = `<at>${displayName}</at>`;
    entities.push({
      type: "mention",
      text: mentionText,
      mentioned: {
        id: userId,
        name: displayName,
      },
    });
    return mentionText;
  });
  return { text, entities };
}

describe("OpenClaw Microsoft Teams message hint patch", () => {
  it("injects native mention syntax into CommonJS @openclaw/msteams hints", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-cjs-"));
    const fixtureFile = writeMSTeamsPackage(tmp);
    try {
      const { result, hints } = runHintsProbe(fixtureFile, { requirePreloadTwice: true });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]);
      expect(fs.readFileSync(fixtureFile, "utf-8")).not.toContain(MSTEAMS_MENTION_HINT);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("injects native mention syntax into native require(esm) @openclaw/msteams hints", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-esm-"));
    const fixtureFile = writeMSTeamsPackage(tmp, { moduleType: "esm" });
    try {
      const { result, hints } = runHintsProbe(fixtureFile);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]);
      expect(fs.readFileSync(fixtureFile, "utf-8")).not.toContain(MSTEAMS_MENTION_HINT);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("leaves upstream mention hints idempotent when OpenClaw already includes them", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-present-"));
    const fixtureFile = writeMSTeamsPackage(tmp, { includeMentionHint: true });
    try {
      const { result, hints } = runHintsProbe(fixtureFile, { requirePreloadTwice: true });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints.filter((hint) => hint === MSTEAMS_MENTION_HINT)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not patch unrelated modules whose path merely contains msteams", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-unrelated-"));
    const fixtureFile = writeUnrelatedMSTeamsLikeModule(tmp);
    try {
      const { result, hints } = runHintsProbe(fixtureFile);
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, TARGETING_HINT]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("stays inert in non-gateway Node children that inherit NODE_OPTIONS", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-nongateway-"));
    const fixtureFile = writeMSTeamsPackage(tmp);
    try {
      const { result, hints } = runHintsProbe(fixtureFile, { gatewayProcess: false });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(hints).toEqual([ADAPTIVE_CARD_HINT, TARGETING_HINT]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("restores the CommonJS load hook after patching @openclaw/msteams", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-hints-restore-"));
    const fixtureFile = writeMSTeamsPackage(tmp);
    try {
      const script = `
process.title = 'openclaw-gateway';
const Module = require("module");
const originalLoad = Module._load;
require(${JSON.stringify(MSTEAMS_HINT_PRELOAD)});
const installedName = Module._load.name;
const plugin = require(${JSON.stringify(fixtureFile)}).msteamsPlugin;
console.log(JSON.stringify({
  installedName,
  restored: Module._load === originalLoad,
  hints: plugin.agentPrompt.messageToolHints({ cfg: {} }),
}));
`;
      const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      const parsed =
        result.status === 0 && result.stdout.trim()
          ? (JSON.parse(result.stdout) as {
              installedName: string;
              restored: boolean;
              hints: string[];
            })
          : null;
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(parsed?.installedName).toBe("nemoclawMSTeamsLoad");
      expect(parsed?.restored).toBe(true);
      expect(parsed?.hints).toEqual([ADAPTIVE_CARD_HINT, MSTEAMS_MENTION_HINT, TARGETING_HINT]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("matches the real @openclaw/msteams send formatter contract for native mention entities", () => {
    const activity = buildRealOpenClawMSTeamsSendFormatterContract(
      `Please review this, @[San Dang](${SAN_DANG_AAD_OBJECT_ID}).`,
    );

    expect(activity.text).toBe("Please review this, <at>San Dang</at>.");
    expect(activity.text).not.toContain(SAN_DANG_AAD_OBJECT_ID);
    expect(activity.entities).toEqual([
      {
        type: "mention",
        text: "<at>San Dang</at>",
        mentioned: {
          id: SAN_DANG_AAD_OBJECT_ID,
          name: "San Dang",
        },
      },
    ]);
  });

  it("does not install an ESM load hook that breaks relative module linking", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-msteams-relative-esm-"));
    const indexFile = path.join(tmp, "index.mjs");
    fs.writeFileSync(path.join(tmp, "max.js"), "export const max = 7;\n");
    fs.writeFileSync(indexFile, 'export { max } from "./max.js";\n');
    try {
      const script = `
process.title = 'openclaw-gateway';
require(${JSON.stringify(MSTEAMS_HINT_PRELOAD)});
import(${JSON.stringify(path.toNamespacedPath(indexFile))}).then((mod) => {
  console.log(String(mod.max));
}).catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
`;
      const result = spawnSync(process.execPath, ["-e", script], {
        encoding: "utf-8",
        timeout: 10_000,
      });
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe("7");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
