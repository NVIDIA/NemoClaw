// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

// sandbox-state computes its backup root from HOME at module load time.
const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-snapshot-home-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "..");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "dist", "lib", "state", "sandbox.js")).href
)) as typeof import("../dist/lib/state/sandbox.js");

afterAll(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeOpenClawRegistry(sandboxName: string): void {
  fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          policies: [],
          agent: null,
        },
      },
    }),
  );
}

describe("OpenClaw durable config file (#5027)", () => {
  it("backs up and restores openclaw.json settings while sanitizing secrets", async () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-snapshot-"));
    const oldPath = process.env.PATH;
    const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
    try {
      const binDir = path.join(fixture, "bin");
      const fakeRoot = path.join(fixture, "sandbox-root");
      const openclawDir = path.join(fakeRoot, ".openclaw");
      fs.mkdirSync(binDir, { recursive: true });
      fs.mkdirSync(openclawDir, { recursive: true });

      // Reporter-shaped config: model/provider/MCP/agent settings plus a
      // provider apiKey sentinel, a channel resolve placeholder, a real inline
      // secret, and a gateway block (regenerated at startup).
      const original = {
        models: {
          mode: "merge",
          providers: {
            nvidia: {
              baseUrl: "https://integrate.api.nvidia.com/v1",
              apiKey: "unused",
              models: [{ id: "moonshotai/kimi-k2" }],
            },
          },
        },
        mcpServers: {
          filesystem: { command: "npx" },
          github: {
            command: "npx",
            env: { GITHUB_TOKEN: "ghp_raw_secret", NODE_ENV: "production" },
          },
        },
        channels: {
          discord: {
            accounts: { default: { token: "openshell:resolve:env:DISCORD_BOT_TOKEN" } },
          },
          slack: { accounts: { default: { botToken: "xoxb-123-raw-secret" } } }, // gitleaks:allow
        },
        customAgents: { researcher: { prompt: "be thorough" } },
        leaked: { apiKey: "sk-real-secret" },
        gateway: { port: 18789, authToken: "gw-token" },
      };
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify(original, null, 2));

      writeExecutable(
        path.join(binDir, "openshell"),
        `#!/bin/sh
if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then
  printf '{"name":"%s"}\n' "\${3:-alpha}"
  exit 0
fi
if [ "$1" = "sandbox" ] && [ "$2" = "ssh-config" ]; then
  printf 'Host openshell-alpha\n  HostName 127.0.0.1\n  User sandbox\n'
  exit 0
fi
exit 0
`,
      );

      writeExecutable(
        path.join(binDir, "ssh"),
        `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = path.join(${JSON.stringify(fakeRoot)}, ".openclaw");
const cmd = process.argv[process.argv.length - 1] || "";
function readStdin() {
  const chunks = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    let n = 0;
    try { n = fs.readSync(0, buf, 0, buf.length, null); } catch { break; }
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
if (cmd.includes("[ -d ")) { process.exit(0); }
if (cmd.includes("openclaw.json") && cmd.includes("cat --")) {
  process.stdout.write(fs.readFileSync(path.join(dir, "openclaw.json")));
  process.exit(0);
}
if (cmd.includes(".nemoclaw-restore") && cmd.includes("openclaw.json")) {
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, readStdin());
  if (cmd.includes("sha256sum") && cmd.includes(".config-hash")) {
    const digest = require("crypto").createHash("sha256").update(fs.readFileSync(configPath)).digest("hex");
    fs.writeFileSync(path.join(dir, ".config-hash"), digest + "  openclaw.json\\n");
  }
  process.exit(0);
}
process.exit(0);
`,
      );

      writeOpenClawRegistry("alpha");
      // writeOpenClawRegistry records agent:null → defaults to openclaw.

      process.env.NEMOCLAW_OPENSHELL_BIN = path.join(binDir, "openshell");
      process.env.PATH = `${binDir}:${oldPath || ""}`;

      const backup = sandboxState.backupSandboxState("alpha");
      expect(backup.success).toBe(true);
      expect(backup.backedUpFiles).toEqual(["openclaw.json"]);
      expect(backup.manifest?.stateFiles).toEqual([{ path: "openclaw.json", strategy: "copy" }]);

      // The local backup is sanitized: secret stripped, gateway removed,
      // restorable references preserved.
      const backedUp = JSON.parse(
        fs.readFileSync(path.join(backup.manifest!.backupPath, "openclaw.json"), "utf-8"),
      );
      expect(backedUp.models.providers.nvidia.apiKey).toBe("unused");
      expect(backedUp.models.providers.nvidia.models[0].id).toBe("moonshotai/kimi-k2");
      expect(backedUp.mcpServers.filesystem.command).toBe("npx");
      expect(backedUp.channels.discord.accounts.default.token).toBe(
        "openshell:resolve:env:DISCORD_BOT_TOKEN",
      );
      expect(backedUp.customAgents.researcher.prompt).toBe("be thorough");
      expect(backedUp.leaked.apiKey).toBe("[STRIPPED_BY_MIGRATION]");
      // Raw channel tokens and MCP env secrets must not leak into backups.
      expect(backedUp.channels.slack.accounts.default.botToken).toBe("[STRIPPED_BY_MIGRATION]");
      expect(backedUp.mcpServers.github.env.GITHUB_TOKEN).toBe("[STRIPPED_BY_MIGRATION]");
      expect(backedUp.mcpServers.github.env.NODE_ENV).toBe("production");
      expect(backedUp.gateway).toBeUndefined();

      fs.writeFileSync(
        path.join(openclawDir, "openclaw.json"),
        JSON.stringify(
          {
            models: {
              mode: "merge",
              providers: { nvidia: { apiKey: "unused", models: [{ id: "nvidia/nemotron" }] } },
            },
            channels: {
              defaults: {},
              discord: { accounts: { default: { token: "openshell:resolve:env:v222_TOKEN" } } },
              whatsapp: { accounts: { default: { enabled: true } } },
            },
            gateway: { auth: { token: "fresh-runtime-token" } },
          },
          null,
          2,
        ),
      );
      const restore = sandboxState.restoreSandboxState("alpha", backup.manifest!.backupPath);
      expect(restore.success).toBe(true);
      expect(restore.restoredFiles).toEqual(["openclaw.json"]);

      const after = JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf-8"));
      expect(after.gateway.auth.token).toBe("fresh-runtime-token");
      expect(after.models.providers.nvidia.models[0].id).toBe("nvidia/nemotron");
      expect(after.channels.discord.accounts.default.token).toBe(
        "openshell:resolve:env:v222_TOKEN",
      );
      expect(after.channels.whatsapp.accounts.default.enabled).toBe(true);
      expect(after.channels.slack).toBeUndefined();
      expect(after.mcpServers.filesystem.command).toBe("npx");
      expect(after.customAgents.researcher.prompt).toBe("be thorough");
      const expectedHash = await import("node:crypto").then(({ createHash }) =>
        createHash("sha256")
          .update(fs.readFileSync(path.join(openclawDir, "openclaw.json")))
          .digest("hex"),
      );
      expect(fs.readFileSync(path.join(openclawDir, ".config-hash"), "utf-8")).toBe(
        `${expectedHash}  openclaw.json\n`,
      );
    } finally {
      if (oldOpenshell === undefined) {
        delete process.env.NEMOCLAW_OPENSHELL_BIN;
      } else {
        process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
      }
      process.env.PATH = oldPath;
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  }, 15000);
});
