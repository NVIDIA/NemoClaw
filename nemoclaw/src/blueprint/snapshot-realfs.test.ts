// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteSnapshotDirectory } from "./snapshot-delete-helper.js";
import { deleteSnapshot, pruneSnapshots } from "./snapshot.js";

const tempRoots: string[] = [];
const REAL_TMP = fs.realpathSync(os.tmpdir());

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("snapshot real filesystem safety", () => {
  function writeSnapshot(snapshotsDir: string, timestamp: string): string {
    const snapshotDir = path.join(snapshotsDir, timestamp);
    fs.mkdirSync(path.join(snapshotDir, "openclaw"), { recursive: true });
    fs.writeFileSync(path.join(snapshotDir, "openclaw", "config.json"), "{}\n");
    fs.writeFileSync(
      path.join(snapshotDir, "snapshot.json"),
      JSON.stringify(
        {
          timestamp,
          source: path.join(os.tmpdir(), "openclaw-source"),
          file_count: 1,
          contents: ["config.json"],
        },
        null,
        2,
      ),
    );
    return snapshotDir;
  }

  it.skipIf(process.platform === "win32")(
    "deletes a normal direct-child timestamp snapshot",
    async () => {
      const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
      tempRoots.push(home);

      const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
      const snapshotDir = writeSnapshot(snapshotsDir, "20990101T000000Z");

      expect(deleteSnapshot(snapshotDir, { snapshotsDir })).toBe(true);
      expect(fs.existsSync(snapshotDir)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")("prunes older direct-child snapshots", async () => {
    const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
    tempRoots.push(home);

    const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
    const older = writeSnapshot(snapshotsDir, "20990101T000000Z");
    const newer = writeSnapshot(snapshotsDir, "20990201T000000Z");

    const result = pruneSnapshots(1, { snapshotsDir });

    expect(result.deleted).toEqual([older]);
    expect(result.kept).toEqual([newer]);
    expect(result.failed).toEqual([]);
    expect(fs.existsSync(older)).toBe(false);
    expect(fs.existsSync(newer)).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked snapshot delete path without touching the outside target",
    async () => {
      const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
      const outside = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-outside-"));
      tempRoots.push(home, outside);

      const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
      const outsideFile = path.join(outside, "keep.txt");
      const symlinkedSnapshot = path.join(snapshotsDir, "20990101T000000Z");
      fs.mkdirSync(snapshotsDir, { recursive: true });
      fs.writeFileSync(outsideFile, "outside target must survive");
      fs.symlinkSync(outside, symlinkedSnapshot, "dir");

      expect(deleteSnapshot(symlinkedSnapshot, { snapshotsDir })).toBe(false);
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside target must survive");
      expect(fs.lstatSync(symlinkedSnapshot).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores symlinked snapshot entries during prune without touching the outside target",
    async () => {
      const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
      const outside = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-outside-"));
      tempRoots.push(home, outside);

      const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
      const newer = writeSnapshot(snapshotsDir, "20990201T000000Z");
      const outsideFile = path.join(outside, "keep.txt");
      const symlinkedSnapshot = path.join(snapshotsDir, "20990101T000000Z");
      fs.writeFileSync(outsideFile, "outside target must survive");
      fs.symlinkSync(outside, symlinkedSnapshot, "dir");

      expect(pruneSnapshots(1, { snapshotsDir })).toEqual({
        deleted: [],
        kept: [newer],
        failed: [],
      });
      expect(fs.readFileSync(outsideFile, "utf8")).toBe("outside target must survive");
      expect(fs.lstatSync(symlinkedSnapshot).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(process.platform === "win32")(
    "isolates the deletion helper from Python startup hooks and ambient secrets",
    async () => {
      const home = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-snapshot-home-"));
      const attackDir = fs.mkdtempSync(path.join(REAL_TMP, "nemoclaw-python-attack-"));
      tempRoots.push(home, attackDir);

      const snapshotsDir = path.join(home, ".nemoclaw", "snapshots");
      const snapshotDir = writeSnapshot(snapshotsDir, "20990101T000000Z");
      const startupMarker = path.join(attackDir, "sitecustomize-loaded");
      const envProbe = path.join(attackDir, "helper-env");
      const sentinelSecret = "snapshot-secret-must-not-reach-python";
      fs.writeFileSync(
        path.join(attackDir, "sitecustomize.py"),
        [
          "import os",
          "from pathlib import Path",
          `Path(${JSON.stringify(startupMarker)}).write_text(os.environ.get("NEMOCLAW_SNAPSHOT_TEST_SECRET", "missing"))`,
        ].join("\n"),
      );

      const pythonPath = spawnSync(
        "python3",
        ["-I", "-c", "import os, sys; print(os.path.realpath(sys.executable))"],
        { encoding: "utf-8" },
      );
      expect(pythonPath.status, pythonPath.stderr).toBe(0);
      const realPython = pythonPath.stdout.trim();

      const vulnerable = spawnSync(realPython, ["-c", "pass"], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NEMOCLAW_SNAPSHOT_TEST_SECRET: sentinelSecret,
          PYTHONPATH: attackDir,
        },
      });
      expect(vulnerable.status, vulnerable.stderr).toBe(0);
      expect(fs.readFileSync(startupMarker, "utf-8")).toBe(sentinelSecret);
      fs.rmSync(startupMarker);

      const wrapperBin = path.join(attackDir, "bin");
      const pythonWrapper = path.join(wrapperBin, "python3");
      fs.mkdirSync(wrapperBin);
      fs.writeFileSync(
        pythonWrapper,
        [
          "#!/bin/sh",
          `printf '%s\\n%s\\n%s\\n' "\${PYTHONPATH-__unset__}" "\${NEMOCLAW_SNAPSHOT_TEST_SECRET-__unset__}" "\${1-__unset__}" > ${shellQuote(envProbe)}`,
          `exec ${shellQuote(realPython)} "$@"`,
        ].join("\n"),
        { mode: 0o755 },
      );

      vi.stubEnv("NEMOCLAW_SNAPSHOT_TEST_SECRET", sentinelSecret);
      vi.stubEnv("PYTHONPATH", attackDir);

      expect(
        deleteSnapshot(snapshotDir, {
          snapshotsDir,
          deleteDirectory: (root, name) =>
            deleteSnapshotDirectory(root, name, { pythonExecutable: pythonWrapper }),
        }),
      ).toBe(true);
      expect(fs.existsSync(snapshotDir)).toBe(false);
      expect(fs.existsSync(startupMarker)).toBe(false);
      expect(fs.readFileSync(envProbe, "utf-8").trim().split("\n")).toEqual([
        "__unset__",
        "__unset__",
        "-I",
      ]);
    },
  );
});
