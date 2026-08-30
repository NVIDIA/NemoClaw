// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-home-snapshot-"));
process.env.HOME = TMP_HOME;
const sandboxStateUrl = pathToFileURL(
  path.join(import.meta.dirname, "../../..", "src", "lib", "state", "sandbox.ts"),
);
sandboxStateUrl.searchParams.set("hermes-home-channel", String(Date.now()));
const sandboxState = await import(sandboxStateUrl.href);

afterAll(() => {
  ORIGINAL_HOME === undefined ? delete process.env.HOME : (process.env.HOME = ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

it("captures only Hermes home-channel assignments for rebuild (#7803)", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-home-capture-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const hermesDir = path.join(fixture, "sandbox-root", ".hermes");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });
    fs.writeFileSync(
      path.join(hermesDir, ".env"),
      [
        "SLACK_BOT_TOKEN=xoxb-must-not-enter-backup",
        "SLACK_HOME_CHANNEL=C0123",
        "SLACK_HOME_CHANNEL_NAME=alerts",
        "SLACK_HOME_CHANNEL_THREAD_ID=",
        "TEAMS_HOME_CHANNEL=19:meeting@example",
        "",
      ].join("\n"),
      { mode: 0o640 },
    );

    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-hermes\\n  HostName 127.0.0.1\\n  User sandbox\\n");
  process.exit(0);
}
process.exit(0);
`,
    );
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const command = process.argv[process.argv.length - 1] || "";
const mapped = command.split("/sandbox/.hermes").join(${JSON.stringify(hermesDir)});
const result = spawnSync("/bin/sh", ["-c", mapped], { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`,
    );

    fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
    fs.writeFileSync(
      path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
      JSON.stringify({
        defaultSandbox: "hermes",
        sandboxes: {
          hermes: {
            name: "hermes",
            model: "m",
            provider: "p",
            gpuEnabled: false,
            agent: "hermes",
          },
        },
      }),
    );
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${oldPath || ""}`;

    const backup = sandboxState.backupSandboxState("hermes", { name: "home-channel" });

    expect(backup.success).toBe(true);
    expect(backup.manifest?.preservedEnv).toEqual([
      {
        path: ".env",
        assignments: [
          "SLACK_HOME_CHANNEL=C0123",
          "SLACK_HOME_CHANNEL_NAME=alerts",
          "SLACK_HOME_CHANNEL_THREAD_ID=",
          "TEAMS_HOME_CHANNEL=19:meeting@example",
        ],
      },
    ]);
    expect(JSON.stringify(backup.manifest)).not.toContain("xoxb-must-not-enter-backup");
  } finally {
    oldOpenshell === undefined
      ? delete process.env.NEMOCLAW_OPENSHELL_BIN
      : (process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell);
    oldPath === undefined ? delete process.env.PATH : (process.env.PATH = oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
