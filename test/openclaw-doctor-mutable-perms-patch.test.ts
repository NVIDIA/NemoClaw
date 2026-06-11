// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const PATCH_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "patch-openclaw-doctor-mutable-perms.mts",
);

// Minimal stand-in for the compiled OpenClaw doctor state-integrity module: the
// two permission gates use the exact `(stat.mode & 63) !== 0` form the patch
// rewrites, alongside the two warning signatures the patch keys on. dirTooOpen /
// fileTooOpen are exported so the patched behavior can be exercised directly.
function doctorModuleSource(
  options: { gateCount?: number; withSignatures?: boolean } = {},
): string {
  const gateCount = options.gateCount ?? 2;
  const withSignatures = options.withSignatures ?? true;
  const lines = [
    "function dirTooOpen(stat) {",
    "\tif ((stat.mode & 63) !== 0) {",
    withSignatures
      ? "\t\twarnings.push(`- State directory permissions are too open (${displayStateDir}). Recommend chmod 700.`);"
      : "\t\twarnings.push(`- State directory needs review.`);",
    "\t\treturn true;",
    "\t}",
    "\treturn false;",
    "}",
    "function fileTooOpen(stat) {",
    // The second gate is only emitted when gateCount === 2.
    gateCount >= 2 ? "\tif ((stat.mode & 63) !== 0) {" : "\tif ((stat.mode & 7) !== 0) {",
    withSignatures
      ? "\t\twarnings.push(`- Config file is group/world readable (${displayConfigPath}). Recommend chmod 600.`);"
      : "\t\twarnings.push(`- Config file needs review.`);",
    "\t\treturn true;",
    "\t}",
    "\treturn false;",
    "}",
    "",
  ];
  return lines.join("\n");
}

function writeDoctorDist(
  root: string,
  options: { gateCount?: number; withSignatures?: boolean } = {},
): string {
  const distDir = path.join(root, "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const file = path.join(distDir, "doctor-state-integrity-FIXTURE.js");
  fs.writeFileSync(file, doctorModuleSource(options));
  return file;
}

function runPatch(...dirs: string[]) {
  return spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, ...dirs], {
    encoding: "utf-8",
    timeout: 10000,
  });
}

// Evaluate the patched dir/file "too open" predicates under a chosen
// OPENSHELL_SANDBOX value and a mode, mirroring how the real doctor calls them.
function evalGate(
  patchedSource: string,
  fn: "dirTooOpen" | "fileTooOpen",
  mode: number,
  openshellSandbox: string | undefined,
): boolean {
  const sandbox: Record<string, unknown> = {
    warnings: [] as string[],
    displayStateDir: "/sandbox/.openclaw",
    displayConfigPath: "/sandbox/.openclaw/openclaw.json",
    process: { env: openshellSandbox === undefined ? {} : { OPENSHELL_SANDBOX: openshellSandbox } },
  };
  return vm.runInNewContext(`${patchedSource}\n${fn}({ mode: ${mode} });`, sandbox) as boolean;
}

describe("OpenClaw doctor mutable-perms patch", () => {
  it("tolerates the NemoClaw 2770/660 contract inside a sandbox while still flagging world bits", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-perms-"));
    const file = writeDoctorDist(tmp);
    try {
      const patch = runPatch(path.join(tmp, "dist"));
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("patched OpenClaw doctor mutable-perms gate");

      const patched = fs.readFileSync(file, "utf-8");
      // Both gates rewritten to the sandbox-aware mask; no raw `& 63` gate remains.
      expect(patched.match(/process\.env\.OPENSHELL_SANDBOX \? 7 : 63/g)).toHaveLength(2);
      expect(patched).not.toContain("(stat.mode & 63) !== 0");
      expect(patched).toContain("nemoclaw: tolerate group-shared mutable config perms");

      const NAME = "my-sandbox"; // OpenShell injects the sandbox NAME, not "1".
      // Inside a sandbox: the mutable contract (2770 dir / 660 file → group bits
      // only) is NOT flagged.
      expect(evalGate(patched, "dirTooOpen", 0o2770, NAME)).toBe(false);
      expect(evalGate(patched, "fileTooOpen", 0o660, NAME)).toBe(false);
      // Inside a sandbox: genuinely world-accessible modes ARE still flagged.
      expect(evalGate(patched, "dirTooOpen", 0o2777, NAME)).toBe(true);
      expect(evalGate(patched, "fileTooOpen", 0o664, NAME)).toBe(true);
      // Outside a sandbox (unset): upstream behavior — group bits flagged.
      expect(evalGate(patched, "dirTooOpen", 0o2770, undefined)).toBe(true);
      expect(evalGate(patched, "fileTooOpen", 0o660, undefined)).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("is idempotent across repeated runs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-perms-idem-"));
    const file = writeDoctorDist(tmp);
    try {
      expect(runPatch(path.join(tmp, "dist")).status).toBe(0);
      const rerun = runPatch(path.join(tmp, "dist"));
      expect(rerun.status, `${rerun.stdout}${rerun.stderr}`).toBe(0);
      expect(rerun.stdout).toContain("already present");
      const patched = fs.readFileSync(file, "utf-8");
      expect(patched.match(/process\.env\.OPENSHELL_SANDBOX \? 7 : 63/g)).toHaveLength(2);
      expect(patched.match(/nemoclaw: tolerate group-shared mutable config perms/g)).toHaveLength(
        2,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when no doctor state-integrity module is present (dist drift)", () => {
    // The doctor module is core OpenClaw and always present where this patch
    // runs; an absent module means dist drift, so a silent no-op would ship an
    // unpatched image. Fail closed instead.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-perms-none-"));
    fs.mkdirSync(path.join(tmp, "dist"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "dist", "unrelated.js"), "export const x = 1;\n");
    try {
      const patch = runPatch(path.join(tmp, "dist"));
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("no OpenClaw doctor state-integrity module found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails loudly when the permission-gate shape changes (wrong gate count)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-doctor-perms-shape-"));
    // Only one `(stat.mode & 63) !== 0` gate — refuse the ambiguous rewrite.
    writeDoctorDist(tmp, { gateCount: 1 });
    try {
      const patch = runPatch(path.join(tmp, "dist"));
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("expected exactly 2");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
