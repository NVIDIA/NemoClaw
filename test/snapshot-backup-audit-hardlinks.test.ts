// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pre-backup audit (NC-2227-04) treatment of multiply-linked regular files.
 *
 * Package managers hard-link installed files out of their cache, so a Hermes
 * sandbox that lazily installed a dependency carries hundreds of them under
 * `lazy-packages`. Rejecting those aborted the whole pre-upgrade backup
 * (#9314). They are now recorded and archived; symlink and special-file
 * rejection is unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-audit-hardlinks-"));
process.env.HOME = TMP_HOME;

const REPO_ROOT = path.join(import.meta.dirname, "..");
type SandboxStateModule = typeof import("../src/lib/state/sandbox.js");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as SandboxStateModule;

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
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
          policies: [],
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

/**
 * Run `backupSandboxState` against a fake sandbox whose pre-backup audit
 * reports `auditLines` (raw `find -printf "%y\t%p\t%l\n"` rows).
 */
function backupWithAuditOutput(
  auditLines: string,
): ReturnType<SandboxStateModule["backupSandboxState"]> {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-audit-fixture-"));
  const oldPath = process.env.PATH;
  const oldOpenshell = process.env.NEMOCLAW_OPENSHELL_BIN;
  try {
    const binDir = path.join(fixture, "bin");
    const stateRoot = path.join(fixture, "sandbox-root", ".openclaw");
    const existingDirs = ["workspace"];
    fs.mkdirSync(binDir, { recursive: true });
    for (const d of existingDirs) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, "workspace", "note.txt"), "content\n");

    const openshell = writeFakeOpenshell(binDir);
    writeExecutable(
      path.join(binDir, "ssh"),
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const cmd = process.argv[process.argv.length - 1] || "";
const existingDirs = ${JSON.stringify(existingDirs)};
if (cmd.includes("[ -d ")) {
  process.stdout.write(existingDirs.join("\\n") + "\\n");
  process.exit(0);
}
if (cmd.includes("find ")) {
  process.stdout.write(${JSON.stringify(auditLines)} + (${JSON.stringify(auditLines)} ? "\\n" : ""));
  process.exit(0);
}
if (cmd.includes("tar -cf -")) {
  const r = spawnSync("tar", ["-cf", "-", "-C", ${JSON.stringify(stateRoot)}, ...existingDirs], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.stdout) fs.writeSync(1, r.stdout);
  process.exit(r.status || 0);
}
process.exit(0);
`,
    );

    writeRegistry("alpha");
    process.env.NEMOCLAW_OPENSHELL_BIN = openshell;
    process.env.PATH = `${binDir}:${oldPath || ""}`;
    return sandboxState.backupSandboxState("alpha");
  } finally {
    if (oldOpenshell === undefined) {
      delete process.env.NEMOCLAW_OPENSHELL_BIN;
    } else {
      process.env.NEMOCLAW_OPENSHELL_BIN = oldOpenshell;
    }
    process.env.PATH = oldPath;
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

afterAll(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("pre-backup audit — multiply-linked regular files (#9314)", () => {
  it("backs up a sandbox whose state dirs contain hard-linked package files", () => {
    // Shape emitted by `find -type f -a -links +1`: type `f`, empty link
    // target. A lazily installed dependency hard-links out of the package
    // manager cache, so every installed file looks like this.
    const auditLines = [
      "f\t/sandbox/.openclaw/workspace/lazy-packages/aiohappyeyeballs/impl.py\t",
      "f\t/sandbox/.openclaw/workspace/lazy-packages/aiohappyeyeballs/utils.py\t",
      "f\t/sandbox/.openclaw/workspace/lazy-packages/edge_tts/__init__.py\t",
    ].join("\n");

    const backup = backupWithAuditOutput(auditLines);

    expect(backup.success).toBe(true);
    expect(backup.error).toBeUndefined();
    expect(backup.backedUpDirs).toEqual(["workspace"]);
  });

  it("still rejects an unsafe symlink alongside hard-linked files", () => {
    // Regression lock: accepting hard links must not weaken symlink rejection.
    const auditLines = [
      "f\t/sandbox/.openclaw/workspace/lazy-packages/edge_tts/__init__.py\t",
      "l\t/sandbox/.openclaw/workspace/escape\t../openclaw.json",
    ].join("\n");

    const backup = backupWithAuditOutput(auditLines);

    expect(backup.success).toBe(false);
    expect(backup.error).toMatch(/Pre-backup audit rejected/);
    expect(backup.error).toContain("workspace/escape");
  });

  it("still rejects special files", () => {
    // Regression lock: sockets/fifos/devices remain violations.
    const backup = backupWithAuditOutput("s\t/sandbox/.openclaw/workspace/agent.sock\t");

    expect(backup.success).toBe(false);
    expect(backup.error).toMatch(/Pre-backup audit rejected/);
    expect(backup.error).toContain("agent.sock");
  });
});
