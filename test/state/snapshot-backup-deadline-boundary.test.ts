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
import { spawnSync } from "node:child_process";
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

function writeRegistry(sandboxName: string, agent: string | null = null): void {
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
          agent,
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
  validateBeforePublish?: () => void,
  downloadArchiveRoot?: string,
  agent?: string | null,
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
const { spawnSync } = require("node:child_process");
const command = process.argv[process.argv.length - 1] || "";
const stage = command.includes("hardlink_count=")
  ? "state-file"
  : command.includes("[ -d ")
  ? "discovery"
  : command.includes("find ")
    ? "audit"
    : command.includes("-cf -")
      ? "download"
      : "state-file";
fs.appendFileSync(${JSON.stringify(stageLog)}, stage + "\\n");
if (stage === "discovery") process.stdout.write("workspace\\n");
if (stage === "download" && ${JSON.stringify(downloadArchiveRoot ?? "")}) {
  const archive = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(downloadArchiveRoot ?? "")}, "workspace"]);
  if (archive.stdout) fs.writeSync(1, archive.stdout);
}
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

  writeRegistry("alpha", agent);
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
        validateBeforePublish,
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
      expect(backup).not.toHaveProperty("manifest");
      expect(backup).not.toHaveProperty("unreachable");
      expect(captured).toHaveBeenCalledOnce();
      expect(prepared.logs.join("\n")).toContain(
        "privileged state directory capture: backup deadline expired",
      );
    });
  });

  it("does not classify state-file deadline expiry as an SSH transport failure", () => {
    withFixture((fixture) => {
      const privilegedRoot = path.join(fixture, "privileged");
      fs.mkdirSync(path.join(privilegedRoot, "workspace"), { recursive: true });
      fs.writeFileSync(path.join(privilegedRoot, "workspace", "marker.txt"), "preserved");
      const captured = vi.fn((_request: unknown, archiveFd: number) => {
        const archive = spawnSync("tar", ["-cf", "-", "-C", privilegedRoot, "workspace"]);
        expect(archive.status, String(archive.stderr)).toBe(0);
        fs.writeSync(archiveFd, archive.stdout);
        return { outcome: "backed_up" as const };
      });
      const backup = prepareBackup(
        fixture,
        "state-file",
        captured,
        false,
        undefined,
        undefined,
        "hermes",
      ).run();

      expect(backup.success).toBe(false);
      expect(backup.unreachable).not.toBe(true);
      expect(sshStagesOf(fixture)).toContain("state-file");
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

  it("defers publication-fence cleanup for lifecycle-safe caller cleanup", () => {
    withFixture((fixture) => {
      const captured = vi.fn((_request: unknown, archiveFd: number) => {
        fs.writeSync(archiveFd, Buffer.alloc(1024));
        return { outcome: "backed_up" as const };
      });
      const backup = prepareBackup(fixture, "never", captured, true, () => {
        throw new Error("runtime generation changed");
      }).run();

      expect(backup).toMatchObject({
        success: false,
        error: "Snapshot authority changed during backup: runtime generation changed",
        manifest: { backupPath: expect.any(String) },
      });
      expect(fs.existsSync(backup.manifest?.backupPath ?? "")).toBe(true);
    });
  });

  it("synchronously replaces a partial permission-denied tree outside lifecycle deferral", () => {
    withFixture((fixture) => {
      const partialRoot = path.join(fixture, "partial");
      const privilegedRoot = path.join(fixture, "privileged");
      fs.mkdirSync(path.join(partialRoot, "workspace"), { recursive: true });
      fs.mkdirSync(path.join(privilegedRoot, "workspace"), { recursive: true });
      fs.writeFileSync(path.join(partialRoot, "workspace", "marker.txt"), "partial");
      fs.writeFileSync(path.join(privilegedRoot, "workspace", "marker.txt"), "privileged");
      const captured = vi.fn((_request: unknown, archiveFd: number) => {
        const archive = spawnSync("tar", ["-cf", "-", "-C", privilegedRoot, "workspace"]);
        expect(archive.status, String(archive.stderr)).toBe(0);
        fs.writeSync(archiveFd, archive.stdout);
        return { outcome: "backed_up" as const };
      });

      const backup = prepareBackup(fixture, "never", captured, false, undefined, partialRoot).run();

      expect(backup.success).toBe(true);
      expect(
        fs.readFileSync(path.join(backup.manifest!.backupPath, "workspace", "marker.txt"), "utf8"),
      ).toBe("privileged");
    });
  });
});
