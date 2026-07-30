// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { restoreEnvBulk } from "../../../test/helpers/env-test-helpers.js";
import { loadAgent } from "../agent/defs.js";
import { restoreRecreatedSandboxState } from "./sandbox.js";

const HERMES_DIR = "/sandbox/.hermes";

type MoveRecord = { target: string; scriptsPresent: boolean };

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function runHermesRestore(options: { stateDirs: string[]; movesFail?: boolean }): {
  moves: MoveRecord[];
  restore: ReturnType<typeof restoreRecreatedSandboxState>;
  restoredCronJob: string | null;
  restoredScript: string | null;
  stagingLeftBehind: boolean;
} {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-staged-restore-"));
  const previousOpenshellBin = process.env.NEMOCLAW_OPENSHELL_BIN;
  const previousPath = process.env.PATH;
  try {
    const binDir = path.join(fixture, "bin");
    const shimDir = path.join(fixture, "shim");
    const hermesDir = path.join(fixture, "sandbox-root", ".hermes");
    const backupPath = path.join(fixture, "backup");
    const moveLog = path.join(fixture, "move-log.jsonl");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });

    for (const stateDir of options.stateDirs) {
      fs.mkdirSync(path.join(backupPath, stateDir), { recursive: true });
    }
    fs.writeFileSync(path.join(backupPath, "cron", "jobs.json"), '{"jobs":[{"enabled":true}]}\n');
    fs.writeFileSync(path.join(backupPath, "scripts", "digest.sh"), "#!/bin/bash\necho ok\n");

    fs.writeFileSync(
      path.join(backupPath, "rebuild-manifest.json"),
      JSON.stringify({
        version: 1,
        sandboxName: "alpha",
        timestamp: "2026-07-29T12-00-00-000Z",
        agentType: "hermes",
        agentVersion: null,
        expectedVersion: null,
        stateDirs: options.stateDirs,
        backedUpDirs: options.stateDirs,
        stateFiles: [],
        dir: HERMES_DIR,
        backupPath,
        blueprintDigest: null,
      }),
    );

    const openshell = path.join(binDir, "openshell");
    writeExecutable(
      openshell,
      `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "sandbox" && args[1] === "ssh-config") {
  process.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");
}
process.exit(0);
`,
    );

    writeExecutable(
      path.join(shimDir, "mv"),
      options.movesFail === true
        ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(moveLog)},
  JSON.stringify({
    target: args[args.length - 1],
    scriptsPresent: fs.existsSync(${JSON.stringify(path.join(hermesDir, "scripts"))}),
  }) + "\\n",
);
process.exit(1);
`
        : `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const target = args[args.length - 1];
fs.appendFileSync(
  ${JSON.stringify(moveLog)},
  JSON.stringify({
    target,
    scriptsPresent: fs.existsSync(${JSON.stringify(path.join(hermesDir, "scripts"))}),
  }) + "\\n",
);
const result = spawnSync("/bin/mv", args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`,
    );

    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const command = (process.argv[process.argv.length - 1] || "").split(${JSON.stringify(HERMES_DIR)}).join(${JSON.stringify(hermesDir)});
function readStdin() {
  const chunks = [];
  for (;;) {
    const buffer = Buffer.alloc(65536);
    let count = 0;
    try {
      count = fs.readSync(0, buffer, 0, buffer.length, null);
    } catch {
      break;
    }
    if (count === 0) break;
    chunks.push(buffer.subarray(0, count));
  }
  return Buffer.concat(chunks);
}
const result = spawnSync("sh", ["-c", command], {
  input: readStdin(),
  env: { ...process.env, PATH: ${JSON.stringify(shimDir)} + ":" + process.env.PATH },
  stdio: ["pipe", "pipe", "pipe"],
});
process.exit(result.status === null ? 1 : result.status);
`,
    );

    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
    const restore = restoreRecreatedSandboxState("alpha", backupPath, {
      targetAgentType: "hermes",
    });

    const moves = fs.existsSync(moveLog)
      ? fs
          .readFileSync(moveLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as MoveRecord)
      : [];
    const cronJobPath = path.join(hermesDir, "cron", "jobs.json");
    const scriptPath = path.join(hermesDir, "scripts", "digest.sh");
    return {
      moves,
      restore,
      restoredCronJob: fs.existsSync(cronJobPath) ? fs.readFileSync(cronJobPath, "utf8") : null,
      restoredScript: fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : null,
      stagingLeftBehind: fs.existsSync(path.join(hermesDir, ".nemoclaw-restore-staging")),
    };
  } finally {
    restoreEnvBulk({ NEMOCLAW_OPENSHELL_BIN: previousOpenshellBin, PATH: previousPath });
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

describe("Hermes cron state restore", () => {
  it("declares the cron script directory as Hermes state", () => {
    expect(loadAgent("hermes").stateDirs).toContain("scripts");
  });

  it("restores cron scripts alongside the job definitions that call them", () => {
    const result = runHermesRestore({ stateDirs: ["scripts", "cron", "workspace"] });

    expect(result.restore.success).toBe(true);
    expect(result.restore.restoredDirs).toEqual(
      expect.arrayContaining(["scripts", "cron", "workspace"]),
    );
    expect(result.restoredScript).toBe("#!/bin/bash\necho ok\n");
    expect(result.restoredCronJob).toBe('{"jobs":[{"enabled":true}]}\n');
  });

  it("publishes cron job definitions only after their scripts are in place", () => {
    const result = runHermesRestore({ stateDirs: ["scripts", "cron", "workspace"] });

    const cronMove = result.moves.find((move) => move.target.endsWith("/cron"));
    expect(cronMove?.scriptsPresent).toBe(true);
    expect(result.moves.at(-1)?.target).toMatch(/\/cron$/);
  });

  it("applies cron last for a backup whose manifest lists it first", () => {
    const result = runHermesRestore({ stateDirs: ["cron", "scripts", "workspace"] });

    expect(result.restore.success).toBe(true);
    expect(result.moves.at(-1)?.target).toMatch(/\/cron$/);
    expect(result.moves.find((move) => move.target.endsWith("/cron"))?.scriptsPresent).toBe(true);
  });

  it("publishes every state directory as a unit and leaves no staging directory", () => {
    const result = runHermesRestore({ stateDirs: ["scripts", "cron", "workspace"] });

    expect(result.restore.success).toBe(true);
    expect(result.moves.map((move) => path.basename(move.target)).sort()).toEqual([
      "cron",
      "scripts",
      "workspace",
    ]);
    expect(result.stagingLeftBehind).toBe(false);
  });

  it("removes the archive copy when a state directory cannot be published", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "cron", "workspace"],
      movesFail: true,
    });

    expect(result.moves.map((move) => path.basename(move.target))).toEqual(["scripts"]);
    expect(result.restoredCronJob).toBeNull();
    expect(result.restore.success).toBe(false);
    expect(result.stagingLeftBehind).toBe(false);
  });
});
