// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { restoreEnv, restoreEnvBulk } from "../helpers/env-test-helpers";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-managed-extensions-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "../..");
type SandboxStateModule = typeof import("../../src/lib/state/sandbox.js");
const loadedSandboxState = await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
);
assert.equal(
  typeof loadedSandboxState.restoreRecreatedSandboxState,
  "function",
  "Expected recreated-sandbox state restore export to be available",
);
const sandboxState = loadedSandboxState as SandboxStateModule;
const BACKUPS_ROOT = path.join(TMP_HOME, ".nemoclaw", "rebuild-backups");

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function writeBackup(
  sandboxName: string,
  dirName: string,
  openclawImagePluginInstalls?: Array<{
    id: string;
    installPath: string;
    loadPaths: string[];
  }>,
): { backupPath: string } {
  const backupPath = path.join(BACKUPS_ROOT, sandboxName, dirName);
  fs.mkdirSync(backupPath, { recursive: true });
  fs.writeFileSync(
    path.join(backupPath, "rebuild-manifest.json"),
    JSON.stringify({
      version: 1,
      sandboxName,
      timestamp: dirName,
      agentType: "openclaw",
      agentVersion: null,
      expectedVersion: null,
      openclawImagePluginInstalls,
      stateDirs: ["extensions"],
      backedUpDirs: ["extensions"],
      dir: "/sandbox/.openclaw",
      backupPath,
      blueprintDigest: null,
    }),
  );
  return { backupPath };
}

function writeOpenClawRegistry(sandboxName: string): void {
  const registryDir = path.join(TMP_HOME, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "m",
          provider: "p",
          gpuEnabled: false,
          agent: null,
        },
      },
    }),
  );
}

function writeFakeOpenshell(binDir: string): string {
  const openshell = path.join(binDir, "openshell");
  writeExecutable(
    openshell,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
  );
  return openshell;
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(BACKUPS_ROOT, { recursive: true, force: true });
});

describe("OpenClaw managed extension snapshot restore", () => {
  const pluginTransitions = [
    { name: "same-id update", previousPlugin: "weather", freshPlugin: "weather" },
    { name: "removal", previousPlugin: "weather", freshPlugin: null },
    { name: "rename", previousPlugin: "weather", freshPlugin: "forecast" },
  ] as const;
  const installIndexCases = (["sqlite", "legacy"] as const).flatMap((installIndexSource) =>
    pluginTransitions.map((transition) => ({ installIndexSource, ...transition })),
  );

  it.each(installIndexCases)(
    "preserves fresh extensions and handles image-plugin $name from the $installIndexSource install index",
    ({ installIndexSource, previousPlugin, freshPlugin }) => {
      const fixture = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-openclaw-extension-restore-"),
      );
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      try {
        const binDir = path.join(fixture, "bin");
        const openclawDir = path.join(fixture, "sandbox-root", ".openclaw");
        const freshRegistryPath = path.join(fixture, "fresh-installs.json");
        const extensionsDir = path.join(openclawDir, "extensions");
        const builtInManagedExtensions = "nemoclaw,diagnostics-otel,brave".split(",");
        const freshImagePlugins = freshPlugin ? [freshPlugin] : [];
        const managedExtensions = [...builtInManagedExtensions, ...freshImagePlugins];
        fs.mkdirSync(binDir, { recursive: true });
        for (const extensionName of managedExtensions) {
          const extensionDir = path.join(extensionsDir, extensionName);
          fs.mkdirSync(extensionDir, { recursive: true });
          const marker = `fresh-${extensionName}\n`;
          fs.writeFileSync(path.join(extensionDir, "marker.txt"), marker);
        }
        fs.mkdirSync(path.join(extensionsDir, "stale-user-extension"), { recursive: true });
        fs.writeFileSync(path.join(extensionsDir, "stale-user-extension", "marker.txt"), "stale\n");
        fs.writeFileSync(
          freshRegistryPath,
          JSON.stringify({
            version: 1,
            loadPaths: [],
            installRecords: Object.fromEntries(
              freshImagePlugins.map((id) => [
                id,
                {
                  source: "path",
                  sourcePath: `/sandbox/.openclaw/extensions/${id}`,
                  installPath: `/sandbox/.openclaw/extensions/${id}`,
                },
              ]),
            ),
          }),
        );

        const manifest = writeBackup("alpha", "2026-05-19T12-00-00-000Z", [
          {
            id: previousPlugin,
            installPath: `/sandbox/.openclaw/extensions/${previousPlugin}`,
            loadPaths: [],
          },
        ]);
        const backupExtensionsDir = path.join(manifest.backupPath, "extensions");
        for (const extensionName of [...builtInManagedExtensions, previousPlugin]) {
          const extensionDir = path.join(backupExtensionsDir, extensionName);
          fs.mkdirSync(extensionDir, { recursive: true });
          const marker = `old-${extensionName}\n`;
          fs.writeFileSync(path.join(extensionDir, "marker.txt"), marker);
        }
        fs.mkdirSync(path.join(backupExtensionsDir, "user-extension"), { recursive: true });
        fs.writeFileSync(
          path.join(backupExtensionsDir, "user-extension", "marker.txt"),
          "restored\n",
        );

        const openshell = writeFakeOpenshell(binDir);
        writeExecutable(
          path.join(binDir, "ssh"),
          `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cmd = process.argv[process.argv.length - 1] || "";
const installIndexSource = ${JSON.stringify(installIndexSource)};
function readStdin() {
  const chunks = [];
  for (;;) {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(0, buf, 0, buf.length, null);
    if (n === 0) break;
    chunks.push(buf.subarray(0, n));
  }
  return Buffer.concat(chunks);
}
if (cmd.includes("installed_plugin_index") && cmd.includes("state/openclaw.sqlite")) {
  if (installIndexSource === "sqlite") process.stdout.write(fs.readFileSync(${JSON.stringify(freshRegistryPath)}));
  process.exit(installIndexSource === "sqlite" ? 0 : 2);
}
if (cmd.includes("plugins/installs.json") && cmd.includes("python3 -c")) {
  if (installIndexSource === "legacy") process.stdout.write(fs.readFileSync(${JSON.stringify(freshRegistryPath)}));
  process.exit(installIndexSource === "legacy" ? 0 : 2);
}
const mappedCmd = cmd.replaceAll("/sandbox/.openclaw", ${JSON.stringify(openclawDir)});
const result = spawnSync("bash", ["-c", mappedCmd], {
  input: readStdin(),
  stdio: ["pipe", "pipe", "pipe"],
  timeout: 30000,
  killSignal: "SIGKILL",
});
if (result.stdout) fs.writeSync(1, result.stdout);
if (result.stderr) fs.writeSync(2, result.stderr);
process.exit(result.status ?? 1);
`,
        );

        writeOpenClawRegistry("alpha");
        process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
        process.env.PATH = `${binDir}:${oldPath || ""}`;

        const restore = sandboxState.restoreRecreatedSandboxState("alpha", manifest.backupPath, {
          targetAgentType: "openclaw",
        });
        expect(restore.success).toBe(true);
        expect(restore.restoredDirs).toEqual(["extensions"]);
        for (const extensionName of managedExtensions) {
          expect(
            fs.readFileSync(path.join(extensionsDir, extensionName, "marker.txt"), "utf-8"),
          ).toBe(`fresh-${extensionName}\n`);
        }
        expect(fs.existsSync(path.join(extensionsDir, previousPlugin))).toBe(
          previousPlugin === freshPlugin,
        );
        expect(fs.existsSync(path.join(extensionsDir, "stale-user-extension"))).toBe(false);
        expect(
          fs.readFileSync(path.join(extensionsDir, "user-extension", "marker.txt"), "utf-8"),
        ).toBe("restored\n");

        const rejectionSentinel = path.join(extensionsDir, "rejection-sentinel");
        fs.mkdirSync(rejectionSentinel);
        fs.writeFileSync(path.join(rejectionSentinel, "marker.txt"), "preserve\n");

        fs.writeFileSync(
          freshRegistryPath,
          JSON.stringify({
            version: 1,
            loadPaths: [],
            installRecords: {
              "\u001b[31m../weather": {
                source: "path",
                sourcePath: "/sandbox/.openclaw/extensions/../weather",
                installPath: "/sandbox/.openclaw/extensions/../weather",
              },
            },
          }),
        );
        const rejected = sandboxState.restoreRecreatedSandboxState("alpha", manifest.backupPath, {
          targetAgentType: "openclaw",
        });
        expect(rejected.success).toBe(false);
        expect(rejected.error).toBe("fresh OpenClaw plugin install registry failed validation");
        expect(fs.existsSync(path.join(extensionsDir, previousPlugin))).toBe(
          previousPlugin === freshPlugin,
        );
        for (const extensionName of managedExtensions) {
          expect(
            fs.readFileSync(path.join(extensionsDir, extensionName, "marker.txt"), "utf-8"),
          ).toBe(`fresh-${extensionName}\n`);
        }
        expect(fs.readFileSync(path.join(rejectionSentinel, "marker.txt"), "utf-8")).toBe(
          "preserve\n",
        );
      } finally {
        restoreEnvBulk({ NEMOCLAW_OPENSHELL_BIN: oldOpenshell, PATH: oldPath });
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
