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
 *
 * The same harness covers record parsing. NUL delimiters keep tabs and
 * newlines inside a filename from changing the field boundaries.
 */

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ORIGINAL_HOME = process.env.HOME;
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-backup-audit-hardlinks-"));
process.env.HOME = TMP_HOME;
const tarHelp = spawnSync("tar", ["--help"], { encoding: "utf8" });
const supportsHardDereference = `${tarHelp.stdout}${tarHelp.stderr}`.includes("--hard-dereference");
// Production executes GNU tar inside the Linux sandbox. Skip only this
// archive-behavior case on hosts such as macOS whose BSD tar lacks that flag.
const hardDereferenceTest = supportsHardDereference ? it : it.skip;

const REPO_ROOT = path.join(import.meta.dirname, "../..");
type SandboxStateModule = typeof import("../../src/lib/state/sandbox.js");
const sandboxState = (await import(
  pathToFileURL(path.join(REPO_ROOT, "src", "lib", "state", "sandbox.ts")).href
)) as SandboxStateModule;

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

function encodePreBackupAuditEntries(
  entries: readonly (readonly [string, string, string])[],
): string {
  return entries.flat().join("\0") + (entries.length > 0 ? "\0" : "");
}

/**
 * Run `backupSandboxState` against a fake sandbox whose pre-backup audit
 * reports `auditOutput` (raw `find -printf "%y\0%p\0%l\0"` fields).
 */
function backupWithAuditOutput(
  auditOutput: string,
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
    // A real multiply-linked pair inside the archived tree, the shape a package
    // manager leaves behind. `tar` would otherwise emit a hard-link record for
    // the second path and `safeTarExtract` would reject the archive.
    const linkedDir = path.join(stateRoot, "workspace", "lazy-packages");
    fs.mkdirSync(linkedDir, { recursive: true });
    fs.writeFileSync(path.join(linkedDir, "impl.py"), "package payload\n");
    fs.linkSync(path.join(linkedDir, "impl.py"), path.join(linkedDir, "alias.py"));

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
  process.stdout.write(${JSON.stringify(auditOutput)});
  process.exit(0);
}
if (cmd.includes("tar ") && cmd.includes("-cf -")) {
  // Run the archive command the product actually issued, with the sandbox
  // state path mapped onto the fixture, so tar flags are exercised for real.
  const real = cmd.split("/sandbox/.openclaw").join(${JSON.stringify(stateRoot)});
  const r = spawnSync("sh", ["-c", real], { stdio: ["ignore", "pipe", "pipe"] });
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
    restoreEnv("NEMOCLAW_OPENSHELL_BIN", oldOpenshell);
    restoreEnv("PATH", oldPath);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

afterAll(() => {
  restoreEnv("HOME", ORIGINAL_HOME);
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

describe("pre-backup audit — multiply-linked regular files (#9314)", () => {
  hardDereferenceTest(
    "backs up a sandbox whose state dirs contain hard-linked package files",
    () => {
      // Shape emitted by `find -type f -a -links +1`: type `f`, empty link
      // target. A lazily installed dependency hard-links out of the package
      // manager cache, so every installed file looks like this.
      const auditOutput = encodePreBackupAuditEntries([
        ["f", "/sandbox/.openclaw/workspace/lazy-packages/aiohappyeyeballs/impl.py", ""],
        ["f", "/sandbox/.openclaw/workspace/lazy-packages/aiohappyeyeballs/utils.py", ""],
        ["f", "/sandbox/.openclaw/workspace/lazy-packages/edge_tts/__init__.py", ""],
      ]);

      const backup = backupWithAuditOutput(auditOutput);

      expect(backup.success, backup.error).toBe(true);
      expect(backup.error).toBeUndefined();
      expect(backup.backedUpDirs).toEqual(["workspace"]);

      // Both linked paths must survive as independent regular files: the archive
      // is unpacked through safeTarExtract, which rejects hard-link records.
      const linked = path.join(String(backup.manifest?.backupPath), "workspace", "lazy-packages");
      expect(fs.readFileSync(path.join(linked, "impl.py"), "utf8")).toBe("package payload\n");
      expect(fs.readFileSync(path.join(linked, "alias.py"), "utf8")).toBe("package payload\n");
      expect(fs.lstatSync(path.join(linked, "alias.py")).nlink).toBe(1);
    },
  );

  it("still rejects an unsafe symlink alongside hard-linked files", () => {
    // Regression lock: accepting hard links must not weaken symlink rejection.
    const auditOutput = encodePreBackupAuditEntries([
      ["f", "/sandbox/.openclaw/workspace/lazy-packages/edge_tts/__init__.py", ""],
      ["l", "/sandbox/.openclaw/workspace/escape", "../openclaw.json"],
    ]);

    const backup = backupWithAuditOutput(auditOutput);

    expect(backup.success).toBe(false);
    expect(backup.error).toMatch(/Pre-backup audit rejected/);
    expect(backup.error).toContain("workspace/escape");
  });

  it("still rejects special files", () => {
    // Regression lock: sockets/fifos/devices remain violations.
    const backup = backupWithAuditOutput(
      encodePreBackupAuditEntries([["s", "/sandbox/.openclaw/workspace/agent.sock", ""]]),
    );

    expect(backup.success).toBe(false);
    expect(backup.error).toMatch(/Pre-backup audit rejected/);
    expect(backup.error).toContain("agent.sock");
  });
});

describe("pre-backup audit record framing", () => {
  it("rejects a symlink path containing tabs and newlines", () => {
    // NUL framing must keep every control character inside the pathname field
    // so it cannot create synthetic audit records or change the link target.
    const backup = backupWithAuditOutput(
      encodePreBackupAuditEntries([
        [
          "l",
          "/sandbox/.openclaw/extensions/example-not-a-real-value-1/node_modules/.bin/x\t../qq/evil\nf\t/synthetic",
          "/etc/passwd",
        ],
      ]),
    );

    expect(String(backup.error ?? "")).toMatch(/Pre-backup audit rejected/);
    expect(String(backup.error ?? "")).toContain("node_modules/.bin/x");
    expect(backup.success).toBe(false);
  });

  it("keeps accepting a hard-link entry with an empty link target", () => {
    const backup = backupWithAuditOutput(
      encodePreBackupAuditEntries([
        ["f", "/sandbox/.openclaw/workspace/lazy-packages/edge_tts/__init__.py", ""],
      ]),
    );

    expect(backup.success, backup.error).toBe(true);
    expect(backup.error).toBeUndefined();
  });

  it("rejects output that does not contain complete field triples", () => {
    const backup = backupWithAuditOutput("f\0/sandbox/.openclaw/workspace/file");

    expect(backup.success).toBe(false);
    expect(backup.error).toBe("Pre-backup audit rejected malformed output");
  });
});
