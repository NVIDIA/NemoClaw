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

type RestoreEvent =
  | { event: "guard"; action: string }
  | { event: "move"; target: string; scriptsPresent: boolean; drainActive: boolean };
type MoveRecord = Extract<RestoreEvent, { event: "move" }>;

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function seedExistingStateFixture(hermesDir: string): void {
  fs.mkdirSync(path.join(hermesDir, "cron"), { recursive: true });
  fs.mkdirSync(path.join(hermesDir, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(hermesDir, "workspace"), { recursive: true });
  fs.writeFileSync(path.join(hermesDir, "cron", "jobs.json"), "old cron\n");
  fs.writeFileSync(path.join(hermesDir, "scripts", "digest.sh"), "old script\n");
  fs.writeFileSync(path.join(hermesDir, "workspace", "notes.md"), "old workspace\n");
}

function seedUnrecoveredRollbackFixture(hermesDir: string): void {
  const rollbackScripts = path.join(hermesDir, ".nemoclaw-restore-rollback", "scripts");
  fs.mkdirSync(rollbackScripts, { recursive: true });
  fs.writeFileSync(path.join(rollbackScripts, "digest.sh"), "recoverable script\n");
}

function runHermesRestore(options: {
  stateDirs: string[];
  movesFail?: boolean;
  failPublishingDir?: string;
  failRemovingRollback?: boolean;
  failRollingBackDir?: string;
  seedExistingState?: boolean;
  seedUnrecoveredRollback?: boolean;
  gatewayRunning?: boolean;
  preexistingDrain?: boolean;
  guardValidationFails?: boolean;
  missingRestoredScript?: boolean;
}): {
  moves: MoveRecord[];
  events: RestoreEvent[];
  guardEvents: string[];
  restore: ReturnType<typeof restoreRecreatedSandboxState>;
  rollbackScript: string | null;
  restoredCronJob: string | null;
  restoredScript: string | null;
  restoredWorkspace: string | null;
  rollbackLeftBehind: boolean;
  stagingLeftBehind: boolean;
  drainLeftBehind: boolean;
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
    const drainMarker = path.join(fixture, "drain-active");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(hermesDir, { recursive: true });
    const existingStateSeeder =
      options.seedExistingState === true ? seedExistingStateFixture : () => undefined;
    const rollbackSeeder =
      options.seedUnrecoveredRollback === true ? seedUnrecoveredRollbackFixture : () => undefined;
    const drainSeeder =
      options.preexistingDrain === true
        ? () => fs.writeFileSync(drainMarker, "external\n")
        : () => undefined;
    const restoredScriptSeeder =
      options.missingRestoredScript === true
        ? () => undefined
        : () =>
            fs.writeFileSync(
              path.join(backupPath, "scripts", "digest.sh"),
              "#!/bin/bash\necho ok\n",
            );
    existingStateSeeder(hermesDir);
    rollbackSeeder(hermesDir);
    drainSeeder();

    for (const stateDir of options.stateDirs) {
      fs.mkdirSync(path.join(backupPath, stateDir), { recursive: true });
    }
    fs.writeFileSync(
      path.join(backupPath, "cron", "jobs.json"),
      '{"jobs":[{"enabled":true,"script":"digest.sh"}]}\n',
    );
    restoredScriptSeeder();

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
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const source = args[args.length - 2] || "";
const target = args[args.length - 1];
const isPublish = source.includes("/.nemoclaw-restore-staging/");
const isRollback = source.includes("/.nemoclaw-restore-rollback/");
if (isPublish) {
  fs.appendFileSync(
    ${JSON.stringify(moveLog)},
    JSON.stringify({
      event: "move",
      target,
      scriptsPresent: fs.existsSync(${JSON.stringify(path.join(hermesDir, "scripts"))}),
      drainActive: fs.existsSync(${JSON.stringify(drainMarker)}),
    }) + "\\n",
  );
}
if (
  ${JSON.stringify(options.movesFail === true)} ||
  (isPublish && target.endsWith("/" + ${JSON.stringify(options.failPublishingDir ?? "")})) ||
  (isRollback && target.endsWith("/" + ${JSON.stringify(options.failRollingBackDir ?? "")}))
) process.exit(1);
const result = spawnSync("/bin/mv", args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`,
    );

    const restoreGuard = path.join(binDir, "hermes-restore-cron-guard");
    writeExecutable(
      restoreGuard,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const action = args[0] || "";
fs.appendFileSync(
  ${JSON.stringify(moveLog)},
  JSON.stringify({ event: "guard", action }) + "\\n",
);
if (action === "begin") {
  if (!${JSON.stringify(options.gatewayRunning !== false)}) {
    process.stdout.write("inactive\\n");
  } else if (fs.existsSync(${JSON.stringify(drainMarker)})) {
    process.stdout.write("preserved\\n");
  } else {
    const token = "nemoclaw-state-restore:0123456789abcdef0123456789abcdef";
    fs.writeFileSync(${JSON.stringify(drainMarker)}, token + "\\n");
    process.stdout.write(token + "\\n");
  }
} else if (action === "assert-safe") {
  if (${JSON.stringify(options.gatewayRunning !== false)} && !fs.existsSync(${JSON.stringify(drainMarker)})) {
    process.exit(1);
  }
} else if (action === "validate") {
  if (${JSON.stringify(options.guardValidationFails === true)}) process.exit(1);
  if (${JSON.stringify(options.gatewayRunning !== false)} && !fs.existsSync(${JSON.stringify(drainMarker)})) {
    process.exit(1);
  }
  const jobs = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(hermesDir, "cron", "jobs.json"))}, "utf8")).jobs;
  for (const job of jobs) {
    if (!job.enabled || !job.script) continue;
    try {
      fs.accessSync(path.join(${JSON.stringify(path.join(hermesDir, "scripts"))}, job.script), fs.constants.R_OK);
    } catch {
      process.exit(1);
    }
  }
} else if (action === "release") {
  const tokenIndex = args.indexOf("--token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : "";
  const owner = fs.existsSync(${JSON.stringify(drainMarker)})
    ? fs.readFileSync(${JSON.stringify(drainMarker)}, "utf8").trim()
    : "";
  if (owner === token) fs.rmSync(${JSON.stringify(drainMarker)});
}
process.exit(0);
`,
    );

    writeExecutable(
      path.join(shimDir, "rm"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (
  ${JSON.stringify(options.failRemovingRollback === true)} &&
  args.some((arg) => arg.endsWith("/.nemoclaw-restore-rollback"))
) process.exit(1);
const result = spawnSync("/bin/rm", args, { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
`,
    );

    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const command = (process.argv[process.argv.length - 1] || "")
  .split(${JSON.stringify(HERMES_DIR)}).join(${JSON.stringify(hermesDir)})
  .split("/usr/local/lib/nemoclaw/hermes-restore-cron-guard.py").join(${JSON.stringify(restoreGuard)});
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

    const events = fs.existsSync(moveLog)
      ? fs
          .readFileSync(moveLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as RestoreEvent)
      : [];
    const moves = events.filter((event): event is MoveRecord => event.event === "move");
    const cronJobPath = path.join(hermesDir, "cron", "jobs.json");
    const scriptPath = path.join(hermesDir, "scripts", "digest.sh");
    const workspacePath = path.join(hermesDir, "workspace", "notes.md");
    const rollbackScriptPath = path.join(
      hermesDir,
      ".nemoclaw-restore-rollback",
      "scripts",
      "digest.sh",
    );
    return {
      moves,
      events,
      guardEvents: events
        .filter(
          (event): event is Extract<RestoreEvent, { event: "guard" }> => event.event === "guard",
        )
        .map((event) => event.action),
      restore,
      rollbackScript: fs.existsSync(rollbackScriptPath)
        ? fs.readFileSync(rollbackScriptPath, "utf8")
        : null,
      restoredCronJob: fs.existsSync(cronJobPath) ? fs.readFileSync(cronJobPath, "utf8") : null,
      restoredScript: fs.existsSync(scriptPath) ? fs.readFileSync(scriptPath, "utf8") : null,
      restoredWorkspace: fs.existsSync(workspacePath)
        ? fs.readFileSync(workspacePath, "utf8")
        : null,
      rollbackLeftBehind: fs.existsSync(path.join(hermesDir, ".nemoclaw-restore-rollback")),
      stagingLeftBehind: fs.existsSync(path.join(hermesDir, ".nemoclaw-restore-staging")),
      drainLeftBehind: fs.existsSync(drainMarker),
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
    expect(result.restoredCronJob).toBe('{"jobs":[{"enabled":true,"script":"digest.sh"}]}\n');
  });

  it("drains the gateway before moving live scheduled-work state and resumes after validation", () => {
    const result = runHermesRestore({ stateDirs: ["scripts", "cron", "workspace"] });

    expect(result.restore.success).toBe(true);
    expect(result.guardEvents).toEqual(["begin", "assert-safe", "validate", "release"]);
    expect(result.moves.every((move) => move.drainActive)).toBe(true);
    expect(
      result.events.findIndex((event) => event.event === "guard" && event.action === "begin"),
    ).toBeLessThan(result.events.findIndex((event) => event.event === "move"));
    expect(
      result.events.findIndex((event) => event.event === "guard" && event.action === "validate"),
    ).toBeGreaterThan(result.events.map((event) => event.event).lastIndexOf("move"));
    expect(result.drainLeftBehind).toBe(false);
  });

  it("preserves a drain that another operator already owned", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "cron", "workspace"],
      preexistingDrain: true,
    });

    expect(result.restore.success).toBe(true);
    expect(result.guardEvents).toEqual(["begin", "assert-safe", "validate"]);
    expect(result.moves.every((move) => move.drainActive)).toBe(true);
    expect(result.drainLeftBehind).toBe(true);
  });

  it("does not create a drain marker when the gateway is inactive", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "cron", "workspace"],
      gatewayRunning: false,
    });

    expect(result.restore.success).toBe(true);
    expect(result.guardEvents).toEqual(["begin", "assert-safe", "validate"]);
    expect(result.moves.every((move) => !move.drainActive)).toBe(true);
    expect(result.drainLeftBehind).toBe(false);
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

  it("restores the original state when a staged directory cannot be published", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "workspace", "cron"],
      failPublishingDir: "workspace",
      seedExistingState: true,
    });

    expect(result.moves.map((move) => path.basename(move.target))).toEqual([
      "scripts",
      "workspace",
    ]);
    expect(result.restore.success).toBe(false);
    expect(result.restoredScript).toBe("old script\n");
    expect(result.restoredWorkspace).toBe("old workspace\n");
    expect(result.restoredCronJob).toBe("old cron\n");
    expect(result.stagingLeftBehind).toBe(false);
    expect(result.rollbackLeftBehind).toBe(false);
    expect(result.guardEvents.at(-1)).toBe("release");
    expect(result.drainLeftBehind).toBe(false);
  });

  it("rolls back instead of resuming when restored enabled-job scripts fail validation", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "workspace", "cron"],
      guardValidationFails: true,
      seedExistingState: true,
    });

    expect(result.restore.success).toBe(false);
    expect(result.guardEvents).toEqual(["begin", "assert-safe", "validate", "release"]);
    expect(result.restoredScript).toBe("old script\n");
    expect(result.restoredCronJob).toBe("old cron\n");
    expect(result.rollbackLeftBehind).toBe(false);
    expect(result.drainLeftBehind).toBe(false);
  });

  it("rejects an enabled restored job whose script is absent", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "workspace", "cron"],
      missingRestoredScript: true,
      seedExistingState: true,
    });

    expect(result.restore.success).toBe(false);
    expect(result.guardEvents).toEqual(["begin", "assert-safe", "validate", "release"]);
    expect(result.restoredScript).toBe("old script\n");
    expect(result.restoredCronJob).toBe("old cron\n");
    expect(result.drainLeftBehind).toBe(false);
  });

  it("preserves the recovery tree when rolling the original state back fails", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "workspace", "cron"],
      failPublishingDir: "workspace",
      failRollingBackDir: "scripts",
      seedExistingState: true,
    });

    expect(result.restore.success).toBe(false);
    expect(result.restoredWorkspace).toBe("old workspace\n");
    expect(result.restoredCronJob).toBe("old cron\n");
    expect(result.rollbackScript).toBe("old script\n");
    expect(result.rollbackLeftBehind).toBe(true);
    expect(result.stagingLeftBehind).toBe(false);
    expect(result.guardEvents).not.toContain("release");
    expect(result.drainLeftBehind).toBe(true);
  });

  it("refuses a new restore while an unrecovered rollback tree exists", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "workspace", "cron"],
      seedExistingState: true,
      seedUnrecoveredRollback: true,
    });

    expect(result.restore.success).toBe(false);
    expect(result.restoredScript).toBe("old script\n");
    expect(result.rollbackScript).toBe("recoverable script\n");
    expect(result.rollbackLeftBehind).toBe(true);
  });

  it("keeps the new state and recovery tree when post-commit cleanup fails", () => {
    const result = runHermesRestore({
      stateDirs: ["scripts", "workspace", "cron"],
      failRemovingRollback: true,
      seedExistingState: true,
    });

    expect(result.restore.success).toBe(false);
    expect(result.restoredScript).toBe("#!/bin/bash\necho ok\n");
    expect(result.restoredCronJob).toBe('{"jobs":[{"enabled":true,"script":"digest.sh"}]}\n');
    expect(result.rollbackScript).toBe("old script\n");
    expect(result.rollbackLeftBehind).toBe(true);
    expect(result.stagingLeftBehind).toBe(false);
  });
});
