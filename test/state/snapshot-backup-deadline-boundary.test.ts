// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stopped-sandbox backup transaction shares one deadline across readiness
 * probing, capture, and the stop that returns the sandbox to its prior state.
 * Every remote step must fail closed once that deadline passes instead of
 * starting another SSH subprocess on borrowed time (#11936).
 *
 * Each case drives the real `backupSandboxState` against fake `openshell` and
 * `ssh` binaries that append their stage to a log. The clock reports the
 * deadline as expired the moment the log names the stage under test, so the
 * next step always begins after expiry.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-deadline-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "../..");
type SandboxStateModule = typeof import("../../src/lib/state/sandbox.js");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as SandboxStateModule;

const BASE_NOW = 1_700_000_000_000;
const DEADLINE_MS = BASE_NOW + 300_000;

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

/** Restore an env var without branching, mirroring the sibling snapshot tests. */
function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

function writeRegistry(sandboxName: string): void {
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
          agent: null,
        },
      },
    }),
  );
}

interface DeadlineRun {
  readonly stages: string[];
  readonly logs: string[];
  readonly run: () => ReturnType<SandboxStateModule["backupSandboxState"]>;
}

/**
 * Prepare a sandbox backup whose shared deadline expires as soon as
 * `expireAfterStage` appears in the fake binaries' stage log.
 */
function prepareBackup(
  fixture: string,
  expireAfterStage: string,
  captureStateDirectories?: SandboxStateModule["backupSandboxState"] extends (
    name: string,
    options?: infer Options,
  ) => unknown
    ? Options extends { captureStateDirectories?: infer Capture }
      ? Capture
      : never
    : never,
  deferSanitizationDeadlineCleanup = false,
): DeadlineRun {
  const binDir = path.join(fixture, "bin");
  const stageLog = path.join(fixture, "stages.log");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(stageLog, "");

  const openshell = path.join(binDir, "openshell");
  writeExecutable(
    openshell,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const servesSshConfig = args[0] === "sandbox" && args[1] === "ssh-config";
fs.appendFileSync(${JSON.stringify(stageLog)}, (servesSshConfig ? "ssh-config" : "openshell") + "\\n");
process.stdout.write(
  servesSshConfig ? "Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n" : "",
);
process.exit(0);
`,
  );

  writeExecutable(
    path.join(binDir, "ssh"),
    `#!/usr/bin/env node
const fs = require("node:fs");
const command = process.argv[process.argv.length - 1] || "";
const stage = command.includes("[ -d ")
  ? "discovery"
  : command.includes("find ")
    ? "audit"
    : command.includes("-cf -")
      ? "download"
      : "state-file";
fs.appendFileSync(${JSON.stringify(stageLog)}, stage + "\\n");
process.stdout.write(stage === "discovery" ? "workspace\\n" : "");
process.stderr.write(
  stage === "download" ? "tar: workspace: Cannot open: Permission denied\\n" : "",
);
process.exit(stage === "download" ? 2 : 0);
`,
  );

  const readStages = () => fs.readFileSync(stageLog, "utf8").trim().split("\n").filter(Boolean);
  vi.spyOn(Date, "now").mockImplementation(() =>
    readStages().includes(expireAfterStage) ? DEADLINE_MS : BASE_NOW,
  );

  const logs: string[] = [];
  vi.spyOn(console, "error").mockImplementation((message: unknown) => {
    logs.push(String(message));
  });

  writeRegistry("alpha");
  process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
  process.env.PATH = `${binDir}:${process.env.PATH || ""}`;
  process.env.NEMOCLAW_REBUILD_VERBOSE = "1";

  return {
    stages: readStages(),
    logs,
    run: () =>
      sandboxState.backupSandboxState("alpha", {
        deadlineMs: DEADLINE_MS,
        captureStateDirectories,
        deferSanitizationDeadlineCleanup,
      }),
  };
}

function withFixture<T>(body: (fixture: string) => T): T {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-deadline-fixture-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  const oldVerbose = process.env.NEMOCLAW_REBUILD_VERBOSE;
  try {
    return body(fixture);
  } finally {
    restoreEnv("NEMOCLAW_REBUILD_VERBOSE", oldVerbose);
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

const SSH_STAGES = new Set(["discovery", "audit", "download", "state-file"]);

/** Remote stages that actually ran an `ssh` subprocess, in execution order. */
function sshStagesOf(fixture: string): string[] {
  return fs
    .readFileSync(path.join(fixture, "stages.log"), "utf8")
    .trim()
    .split("\n")
    .filter((stage) => SSH_STAGES.has(stage));
}

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("shared backup deadline boundaries (#11936)", () => {
  it("does not start state dir discovery after the deadline expires", () => {
    withFixture((fixture) => {
      const backup = prepareBackup(fixture, "ssh-config").run();

      expect(backup.success).toBe(false);
      expect(backup.error).toBe("State dir discovery skipped: backup deadline expired");
      expect(sshStagesOf(fixture)).toEqual([]);
    });
  });

  it("does not start the pre-backup audit after the deadline expires", () => {
    withFixture((fixture) => {
      const backup = prepareBackup(fixture, "discovery").run();

      expect(backup.success).toBe(false);
      expect(backup.error).toBe("Pre-backup audit skipped: backup deadline expired");
      expect(sshStagesOf(fixture)).toEqual(["discovery"]);
    });
  });

  it("does not start the archive download after the deadline expires", () => {
    withFixture((fixture) => {
      const backup = prepareBackup(fixture, "audit").run();

      expect(backup.success).toBe(false);
      expect(backup.error).toBe("State archive download skipped: backup deadline expired");
      expect(sshStagesOf(fixture)).toEqual(["discovery", "audit"]);
    });
  });

  it("does not list a privileged recovery archive after the deadline expires", () => {
    withFixture((fixture) => {
      const captured = vi.fn((_request: unknown, archiveFd: number) => {
        fs.writeSync(archiveFd, Buffer.alloc(1024));
        return { outcome: "backed_up" as const };
      });
      const prepared = prepareBackup(fixture, "download", captured);

      const backup = prepared.run();
      expect(backup).toMatchObject({
        success: false,
        error: "Snapshot sanitization skipped: backup deadline expired",
      });
      expect(backup).not.toHaveProperty("unreachable");
      expect(captured).toHaveBeenCalledOnce();
      expect(prepared.logs.join("\n")).toContain(
        "privileged state directory capture: backup deadline expired",
      );
    });
  });

  it("preserves a deadline-expired snapshot for lifecycle-safe caller cleanup", () => {
    withFixture((fixture) => {
      const captured = vi.fn((_request: unknown, archiveFd: number) => {
        fs.writeSync(archiveFd, Buffer.alloc(1024));
        return { outcome: "backed_up" as const };
      });
      const backup = prepareBackup(fixture, "download", captured, true).run();

      expect(backup).toMatchObject({
        success: false,
        error: "Snapshot sanitization skipped: backup deadline expired",
        manifest: { backupPath: expect.any(String) },
      });
      expect(fs.existsSync(backup.manifest?.backupPath ?? "")).toBe(true);
    });
  });
});
