// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// Sandbox state resolves HOME during module initialization.
const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-errors-"));
process.env.HOME = TMP_HOME;
const sandboxState = await import("../../src/lib/state/sandbox.js");
afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});
function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}
function restoreEnv(name: string, value: string | undefined): void {
  value === undefined
    ? Reflect.deleteProperty(process.env, name)
    : Reflect.set(process.env, name, value);
}

describe("sandbox backup transport failures", () => {
  it.each([
    {
      stage: "ssh-config",
      status: 255,
      unreachable: true,
      error: "Could not obtain SSH configuration",
    },
    {
      stage: "directory-discovery",
      status: 255,
      unreachable: true,
      error: "SSH state-directory discovery failed (exit 255)",
    },
    {
      stage: "unsafe-directory",
      status: 65,
      unreachable: false,
      error: "State directory discovery rejected an unsafe entry (exit 65)",
    },
  ])(
    "reports $stage failure before capturing archives without exposing stderr",
    ({ stage, status, unreachable, error }) => {
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-transport-"));
      const oldPath = process.env.PATH;
      const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
      try {
        const openshell = path.join(fixture, "openshell");
        const failure = `#!/usr/bin/env node\nprocess.stderr.write("private-transport-detail"); process.exit(${status});\n`;
        writeExecutable(path.join(fixture, "ssh"), failure);
        writeExecutable(
          openshell,
          stage === "ssh-config"
            ? failure
            : '#!/usr/bin/env node\nprocess.stdout.write("Host openshell-alpha\\n  HostName 127.0.0.1\\n  User sandbox\\n");\n',
        );
        fs.mkdirSync(path.join(TMP_HOME, ".nemoclaw"), { recursive: true });
        fs.writeFileSync(
          path.join(TMP_HOME, ".nemoclaw", "sandboxes.json"),
          JSON.stringify({
            defaultSandbox: "alpha",
            sandboxes: { alpha: { name: "alpha", agent: null } },
          }),
        );
        process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
        process.env.PATH = `${fixture}${path.delimiter}${oldPath || ""}`;

        const backup = sandboxState.backupSandboxState("alpha");
        expect(backup).toMatchObject({
          success: false,
          unreachable,
          backedUpDirs: [],
          backedUpFiles: [],
          error: expect.stringContaining(error),
        });
        expect(backup.error).toContain("No state archive was captured.");
        expect(JSON.stringify(backup)).not.toContain("private-transport-detail");
        expect(backup.failedDirs.length).toBeGreaterThan(0);
        expect(backup.failedFiles).toContain("openclaw.json");
      } finally {
        restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
        restoreEnv("PATH", oldPath);
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
