// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLEAN_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "clean_runtime_shell_env_shim.py",
);
const SHIM_TEXT = '[ -f /tmp/nemoclaw-proxy-env.sh ] && . /tmp/nemoclaw-proxy-env.sh';
const CURRENT_UID = process.getuid?.() ?? 0;

function runScript(args: { rcPath: string; shim: string; uid: number }): {
  status: number | null;
  stderr: string;
  stdout: string;
} {
  const result = spawnSync(
    "python3",
    [CLEAN_SCRIPT, args.rcPath, args.shim, String(args.uid)],
    { encoding: "utf-8" },
  );
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
}

describe("clean_runtime_shell_env_shim.py", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-rc-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("removes the legacy two-line stanza when uid owns the rc file", () => {
    const rcPath = path.join(tmpDir, ".bashrc");
    const before = `export FOO=1\n# Source runtime proxy config\n${SHIM_TEXT}\nexport BAR=2\n`;
    fs.writeFileSync(rcPath, before, { mode: 0o644 });

    const result = runScript({ rcPath, shim: SHIM_TEXT, uid: CURRENT_UID });

    expect(result.status).toBe(0);
    const after = fs.readFileSync(rcPath, "utf-8");
    expect(after).toBe("export FOO=1\nexport BAR=2\n");
  });

  it("leaves the rc file untouched and exits 0 when the entrypoint uid does not own it", () => {
    // When the entrypoint runs as a non-root uid against an rc file owned by
    // a different uid (e.g. root-owned legacy .bashrc), the pre-fix cleanup
    // raised EPERM under errexit and killed the container. The ownership
    // guard now logs and exits 0 instead.
    const rcPath = path.join(tmpDir, ".bashrc");
    const before = `# Source runtime proxy config\n${SHIM_TEXT}\nexport REAL_USER_LINE=keep\n`;
    fs.writeFileSync(rcPath, before, { mode: 0o644 });

    // Mismatched uid: pretend we are running as a foreign uid against a file
    // owned by the test runner. Real container repro uses uid=1000 vs root.
    const foreignUid = CURRENT_UID + 99999;
    const result = runScript({ rcPath, shim: SHIM_TEXT, uid: foreignUid });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[SECURITY] skipping rc cleanup");
    expect(result.stderr).toContain(`file uid=${CURRENT_UID}`);
    expect(result.stderr).toContain(`uid=${foreignUid}`);

    const after = fs.readFileSync(rcPath, "utf-8");
    expect(after).toBe(before);
  });

  it("exits 0 without rewriting when the rc file is already clean", () => {
    const rcPath = path.join(tmpDir, ".bashrc");
    const before = "export FOO=1\nexport BAR=2\n";
    fs.writeFileSync(rcPath, before, { mode: 0o644 });

    const result = runScript({ rcPath, shim: SHIM_TEXT, uid: CURRENT_UID });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(rcPath, "utf-8")).toBe(before);
  });

  it("refuses a symlinked rc file and exits 1", () => {
    const realPath = path.join(tmpDir, "real");
    const linkPath = path.join(tmpDir, ".bashrc");
    fs.writeFileSync(realPath, "export FOO=1\n", { mode: 0o644 });
    fs.symlinkSync(realPath, linkPath);

    const result = runScript({ rcPath: linkPath, shim: SHIM_TEXT, uid: 0 });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("refusing symlinked rc file");
  });

  it("strips a bare shim line without the preceding comment", () => {
    const rcPath = path.join(tmpDir, ".bashrc");
    const before = `export FOO=1\n${SHIM_TEXT}\nexport BAR=2\n`;
    fs.writeFileSync(rcPath, before, { mode: 0o644 });

    const result = runScript({ rcPath, shim: SHIM_TEXT, uid: CURRENT_UID });

    expect(result.status).toBe(0);
    expect(fs.readFileSync(rcPath, "utf-8")).toBe("export FOO=1\nexport BAR=2\n");
  });
});
